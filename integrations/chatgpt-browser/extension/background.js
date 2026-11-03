"use strict";

// Load deterministic evidence analysis locally in this classic MV3 worker.
importScripts("analysis.js");

// Standalone Edge extension. No native host, Windows process, remote analysis
// provider, or privileged filesystem access is required.
const KEY = tabId => "gcrChatGPTTab:" + tabId;
const LOCAL_KEY = "gcrEvidenceV1";
const CHATGPT = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const DETECTORS = new Set(["current", "legacy", "waiting", "unsupported"]);
const REPOSITORY = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i;
const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const WORKFLOW_STAGES = new Set([
  "investigation", "implementation", "debugging", "testing",
  "version_control", "deployment"
]);
const COMMAND_FAMILIES = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "node", "python", "pytest",
  "docker", "dotnet", "powershell"
]);
const MAX_EVENTS = 1500;
const MAX_COMMITS = 30;
const RETENTION_MS = 30 * 86400000;
const MAX_PATCH_BYTES = 24000;
const MAX_RESPONSE_BYTES = 512000;
const MAX_EVIDENCE_BYTES = 3500000;
const pendingCommits = new Set();
const MESSAGE_ID = /^m-[a-z0-9]{1,16}-[0-9]{1,6}$/;
let storageQueue = Promise.resolve();
let operationQueue = Promise.resolve();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function eligible(url) {
  try { const u = new URL(url); return u.protocol === "https:" && CHATGPT.has(u.origin); }
  catch { return false; }
}
async function getSession(tabId) {
  const data = await chrome.storage.session.get(KEY(tabId));
  return data[KEY(tabId)] || null;
}
async function readEvidence() {
  const found = await chrome.storage.local.get(LOCAL_KEY);
  const data = found[LOCAL_KEY];
  return data?.version === 1 && Array.isArray(data.events) && data.commits &&
    typeof data.commits === "object" ? data : { version: 1, events: [], commits: {} };
}
function bounded(data) {
  const cutoff = Date.now() - RETENTION_MS;
  data.events = data.events.filter(e => Number.isFinite(Date.parse(e.timestamp)) &&
    Date.parse(e.timestamp) >= cutoff).slice(-MAX_EVENTS);
  for (const [key, entry] of Object.entries(data.commits)) {
    if (!entry || Date.parse(entry.savedAt) < cutoff) delete data.commits[key];
  }
  const keys = Object.keys(data.commits).sort((a, b) =>
    Date.parse(data.commits[b].savedAt) - Date.parse(data.commits[a].savedAt));
  for (const key of keys.slice(MAX_COMMITS)) delete data.commits[key];
  // Storage has a hard ceiling. Drop oldest patches before removing chronology.
  while (JSON.stringify(data).length > MAX_EVIDENCE_BYTES && Object.keys(data.commits).length) {
    const oldest = Object.keys(data.commits).sort((a, b) =>
      Date.parse(data.commits[a].savedAt) - Date.parse(data.commits[b].savedAt))[0];
    delete data.commits[oldest];
  }
  while (JSON.stringify(data).length > MAX_EVIDENCE_BYTES && data.events.length)
    data.events.shift();
  return data;
}
function mutateEvidence(change) {
  const job = storageQueue.then(async () => {
    const data = await readEvidence();
    const result = await change(data);
    await chrome.storage.local.set({ [LOCAL_KEY]: bounded(data) });
    return result;
  });
  storageQueue = job.catch(() => {});
  return job;
}
function event(sessionId, type, fields = {}) {
  return mutateEvidence(data => {
    data.events.push({
      timestamp: new Date().toISOString(), source: "chatgpt_browser",
      sessionId, type, ...fields
    });
    return true;
  });
}
function secretPath(path) {
  return typeof path !== "string" || path.length > 220 || path.includes("\0") ||
    path.startsWith("/") || path.includes("\\") || path.split("/").some(p =>
      !p || p === "." || p === ".." || /^\.env(?:\.|$)/i.test(p) ||
      /^(?:node_modules|\.git|\.next|dist|build)$/i.test(p) ||
      /^(?:id_rsa|id_ed25519|credentials|secrets|private\.key|\.npmrc|\.pypirc)$/i.test(p));
}
function patchLooksSensitive(patch) {
  return /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9_-]{24,})/.test(patch);
}
async function fetchCommit(repository, sha) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://api.github.com/repos/" + repository + "/commits/" + sha,
      { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
        redirect: "error", credentials: "omit" });
    if (!response.ok) throw Error("GitHub returned HTTP " + response.status);
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > MAX_RESPONSE_BYTES) throw Error("Commit response too large");
    // Bound parsing work even if Content-Length is missing.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw Error("Commit response too large");
    const json = JSON.parse(text);
    if (json.sha?.toLowerCase() !== sha || !Array.isArray(json.files) || json.files.length > 100)
      throw Error("Commit data invalid or incomplete");
    const files = [];
    let total = 0;
    for (const file of json.files) {
      const path = file.filename;
      const old = file.status === "renamed" ? file.previous_filename : path;
      if (secretPath(path) || secretPath(old) || typeof file.patch !== "string") continue;
      const patch = file.patch;
      if (!patch.startsWith("@@ ") || patch.length > MAX_PATCH_BYTES || patchLooksSensitive(patch)) continue;
      if (!Number.isInteger(file.additions) || !Number.isInteger(file.deletions)) continue;
      total += patch.length;
      if (total > 120000 || files.length >= 20) break;
      files.push({ path, previousPath: old, status: file.status,
        additions: file.additions, deletions: file.deletions, patch });
    }
    // A public commit can contain only binary files, sensitive paths, or
    // omitted GitHub patch hunks. Do not claim code evidence was retrieved
    // when no safe textual diff can actually be exported.
    return {
      status: files.length ? "retrieved" : "metadata_only",
      files,
      changedFiles: json.files.length,
      note: files.length
        ? "A public commit reference was recorded. Authorship, tests and outcome are unverified."
        : "Commit metadata was retrieved, but no safe textual patches were available. Authorship, tests and outcome are unverified."
    };
  } finally { clearTimeout(timeout); }
}
async function hasCommitConsent(sessionId, consentEpoch, key) {
  const active = await chrome.storage.session.get(null);
  for (const [storageKey, session] of Object.entries(active)) {
    if (session?.id !== sessionId || !session.workflowEnabled ||
        (session.consentEpoch || 0) !== consentEpoch || !(session.commitRefs || []).includes(key)) continue;
    try {
      const tab = await chrome.tabs.get(Number(storageKey.slice("gcrChatGPTTab:".length)));
      if (eligible(tab.url) && new URL(tab.url).pathname === session.page) return true;
    } catch { /* Closed tabs no longer consent to collection. */ }
  }
  return false;
}
async function collectCommit(repository, sha, sessionId, clearGeneration, consentEpoch) {
  const key = repository + "@" + sha;
  if (pendingCommits.has(key)) return;
  pendingCommits.add(key);
  try {
    const existing = await readEvidence();
    if (existing.commits[key]) return;
    let result;
    try { result = await fetchCommit(repository, sha); }
    catch { result = { status: "unavailable", files: [],
      note: "Public GitHub commit could not be retrieved. No code evidence verified." }; }
    // Never retain patches after a session's consent has been revoked.
    if (!await hasCommitConsent(sessionId, consentEpoch, key)) return;
    await mutateEvidence(async data => {
      if (!await hasCommitConsent(sessionId, consentEpoch, key)) return;
      // Delete stored evidence must also win against a GitHub fetch that was
      // already in flight. Otherwise, a cleared patch could reappear later.
      if ((data.clearGeneration || 0) !== clearGeneration) return;
      data.commits[key] = { repository, sha, sessionId,
        savedAt: new Date().toISOString(), ...result };
    });
  } finally { pendingCommits.delete(key); }
}
async function stop(tabId) {
  const session = await getSession(tabId);
  if (!session) return;
  await chrome.storage.session.remove(KEY(tabId));
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "gcrStop" }).catch(() => {});
  await event(session.id, "session_ended").catch(() => {});
}
async function start(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!eligible(tab.url)) throw Error("Open a ChatGPT conversation before starting recording.");
  if (await getSession(tabId)) return;
  const id = crypto.randomUUID();
  // Start is the single explicit opt-in: tagging and local workflow analysis
  // are enabled together, without requiring two additional panel toggles.
  await event(id, "session_started");
  await event(id, "coding_tag", { codingMarked: true, method: "automatic_on_start" });
  await chrome.storage.session.set({ [KEY(tabId)]: {
    id, page: new URL(tab.url).pathname,
    visibleUser: null, visibleAssistant: null, visibleCodeBlocks: null,
    codingMarked: true, workflowEnabled: true, consentEpoch: 1,
    workflowStages: 0, commitRefs: [],
    detector: null, lastObservedAt: null, lastCountAt: null
  } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#166534" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    // The content observer initially runs in metadata-only mode. Explicitly
    // enable the bounded text classification/commit observer once installed.
    await chrome.tabs.sendMessage(tabId, { type: "gcrWorkflowMode", enabled: true });
  } catch {
    await stop(tabId);
    throw Error("Cannot enable the ChatGPT observer. Reload the page and start recording again.");
  }
}
async function recordCommit(tabId, session, repository, sha, discovery, details = {}) {
  const key = repository + "@" + sha;

  const current = await getSession(tabId);
  if (!current || current.id !== session.id || !current.workflowEnabled) return { ok: false };
  // Capture deletion generation before an asynchronous GitHub request.
  const clearGeneration = (await readEvidence()).clearGeneration || 0;
  const data = await readEvidence();
  const response = data.events.find(e => e.sessionId === session.id &&
    e.type === "assistant_response" && e.responseId === details.responseId);
  const request = data.events.find(e => e.sessionId === session.id &&
    e.type === "request_boundary" && e.taskId === response?.taskId);
  const manualTask = details.taskId && globalThis.GentleCodingAnalysis.analyze(data).tasks
    .find(task => task.taskId === details.taskId && task.requestId);
  if (details.taskId && !manualTask) return { ok: false };
  const state = discovery === "manual" ? (manualTask ? "manual" : "unattributed") :
    details.historical === true ? "historical" :
      request?.confidence === "supported" ? "automatic" : "unattributed";
  if (state !== "historical" && !(current.commitRefs || []).includes(key) &&
      (current.commitRefs || []).length >= MAX_COMMITS) return { ok: false };
  const taskId = state === "manual" ? manualTask.taskId : state === "automatic" ? request.taskId : null;
  const association = { state, method: discovery === "manual" ? "user_selection" : "assistant_response",
    confidence: taskId ? "supported" : "uncertain",
    requestId: state === "automatic" ? request.requestId : null,
    responseId: response?.responseId || null,
    supportingTaskId: taskId };
  const inserted = await mutateEvidence(currentData => {
    if ((currentData.clearGeneration || 0) !== clearGeneration) return false;
    if (currentData.events.some(e => e.sessionId === session.id && e.type === "github_commit_ref" &&
        e.repository === repository && e.commitSha === sha && e.taskId === taskId &&
        e.attribution?.state === state && e.attribution?.responseId === association.responseId)) return false;
    currentData.events.push({ timestamp: new Date().toISOString(), source: "chatgpt_browser",
      sessionId: session.id, type: "github_commit_ref", repository, commitSha: sha, discovery,
      taskId, attribution: association });
    return true;
  });
  if (!inserted) return { ok: true, duplicate: true };
  const next = await getSession(tabId);
  if (!next || next.id !== session.id || !next.workflowEnabled) return { ok: false };
  await chrome.storage.session.set({ [KEY(tabId)]: { ...next,
    commitRefs: state === "historical" ? (next.commitRefs || []) : [...new Set([...(next.commitRefs || []), key])] } });
  return { ok: true, retrieval: state !== "historical"
    ? collectCommit(repository, sha, session.id, clearGeneration, session.consentEpoch || 0) : null };
}
function parseCommitUrl(input) {
  if (typeof input !== "string" || input.length > 300) return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.origin !== "https://github.com" || url.search || url.hash) return null;
  const match = /^\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})\/commit\/([a-f0-9]{40})\/?$/i.exec(url.pathname);
  return match ? { repository: (match[1] + "/" + match[2]).toLowerCase(), sha: match[3].toLowerCase() } : null;
}
async function fromPage(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false };
  const session = await getSession(tabId);
  if (!session) return { ok: false };
  if (message.type === "conversationChanged") {
    await stop(tabId); return { ok: true };
  }
  const tab = await chrome.tabs.get(tabId);
  if (!eligible(tab.url) || new URL(tab.url).pathname !== session.page) {
    await stop(tabId); return { ok: false };
  }
  if (message.type === "observerStatus") {
    if (!DETECTORS.has(message.detector)) return { ok: false };
    await chrome.storage.session.set({ [KEY(tabId)]: {
      ...session, detector: message.detector, lastObservedAt: Date.now()
    } });
    return { ok: true };
  }
  if (["requestBoundary", "assistantBoundary"].includes(message.type)) {
    if (!session.workflowEnabled) return { ok: false };
    const isRequest = message.type === "requestBoundary";
    const id = isRequest ? message.requestId : message.responseId;
    if (!MESSAGE_ID.test(id || "")) return { ok: false };
    return mutateEvidence(data => {
      const type = isRequest ? "request_boundary" : "assistant_response";
      const field = isRequest ? "requestId" : "responseId";
      if (data.events.some(e => e.sessionId === session.id && e.type === type && e[field] === id))
        return { ok: true, duplicate: true };
      if (data.events.filter(e => e.sessionId === session.id && e.type === type).length >= 240)
        return { ok: false };
      const request = !isRequest && data.events.find(e => e.sessionId === session.id &&
        e.type === "request_boundary" && e.requestId === message.requestId);
      data.events.push({ timestamp: new Date().toISOString(), source: "chatgpt_browser", sessionId: session.id,
        type, [field]: id, taskId: isRequest ? session.id + ":" + id : request?.taskId || null,
        ...(isRequest ? { confidence: message.confidence === "supported" ? "supported" : "uncertain" } :
          { requestId: request?.requestId || null, historical: message.historical === true }) });
      return { ok: true };
    });
  }
  if (message.type === "assistantEvidence") {
    // Accept only bounded, structured metadata for a response that this
    // consented conversation actually recorded. Never accept raw text/code.
    if (!session.workflowEnabled || !MESSAGE_ID.test(message.responseId || "") ||
        !Number.isInteger(message.observedCharacters) || message.observedCharacters < 0 ||
        message.observedCharacters > 10000000 ||
        !Number.isInteger(message.observedCodeBlocks) || message.observedCodeBlocks < 0 ||
        message.observedCodeBlocks > 1000 ||
        !Number.isInteger(message.observedCommitLinks) || message.observedCommitLinks < 0 ||
        message.observedCommitLinks > MAX_COMMITS) return { ok: false };
    const stages = message.mentionedStages ?? [], commands = message.commandFamilies ?? [];
    if (!Array.isArray(stages) || stages.length > WORKFLOW_STAGES.size ||
        stages.some(stage => !WORKFLOW_STAGES.has(stage)) ||
        !Array.isArray(commands) || commands.length > COMMAND_FAMILIES.size ||
        commands.some(command => !COMMAND_FAMILIES.has(command))) return { ok: false };
    return mutateEvidence(data => {
      const response = data.events.find(e => e.sessionId === session.id &&
        e.type === "assistant_response" && e.responseId === message.responseId &&
        e.historical !== true);
      if (!response) return { ok: false };
      const current = data.events.find(e => e.sessionId === session.id &&
        e.type === "assistant_evidence" && e.responseId === message.responseId);
      const fields = {
        observedCharacters: message.observedCharacters,
        observedCodeBlocks: message.observedCodeBlocks,
        observedCommitLinks: message.observedCommitLinks,
        mentionedStages: [...new Set(stages)].sort(),
        commandFamilies: [...new Set(commands)].sort(),
        coverage: "rendered_at_observation"
      };
      if (current) {
        Object.assign(current, fields, { lastObservedAt: new Date().toISOString() });
      } else {
        if (data.events.filter(e => e.sessionId === session.id &&
            e.type === "assistant_evidence").length >= 240) return { ok: false };
        data.events.push({
          timestamp: new Date().toISOString(), source: "chatgpt_browser",
          sessionId: session.id, type: "assistant_evidence",
          responseId: response.responseId, taskId: response.taskId,
          ...fields
        });
      }
      return { ok: true };
    });
  }
  if (message.type === "workflowStage") {
    if (!session.workflowEnabled || !WORKFLOW_STAGES.has(message.stage) ||
        session.workflowStages >= 120) return { ok: false };
    if (message.ordinal !== undefined && (!Number.isInteger(message.ordinal) || message.ordinal < 0 || message.ordinal >= 20)) return { ok: false };
    const data = await readEvidence();
    const request = data.events.find(e => e.sessionId === session.id &&
      e.type === "request_boundary" && e.requestId === message.requestId);
    if (message.requestId && !request) return { ok: false };
    if (request && data.events.some(e => e.sessionId === session.id && e.type === "workflow_stage" &&
        e.requestId === request.requestId && e.stage === message.stage && e.ordinal === message.ordinal)) return { ok: true, duplicate: true };
    await event(session.id, "workflow_stage", { stage: message.stage,
      ...(request ? { taskId: request.taskId, requestId: request.requestId, ...(message.ordinal === undefined ? {} : { ordinal: message.ordinal }) } : {}) });
    const current = await getSession(tabId);
    if (current?.id === session.id && current.workflowEnabled)
      await chrome.storage.session.set({ [KEY(tabId)]: { ...current,
        workflowStages: current.workflowStages + 1 } });
    return { ok: true };
  }
  if (message.type === "githubCommitReferences") {
    // A single message acknowledges each link independently. A malformed or
    // temporarily rejected reference must never starve later valid commits.
    if (!session.workflowEnabled || !MESSAGE_ID.test(message.responseId || "") ||
        !Array.isArray(message.links) || message.links.length < 1 ||
        message.links.length > MAX_COMMITS) return { ok: false };
    const accepted = [];
    const seen = new Set();
    for (const link of message.links) {
      if (!link || typeof link.repository !== "string" || typeof link.sha !== "string" ||
          !REPOSITORY.test(link.repository) || !COMMIT_SHA.test(link.sha) ||
          typeof link.historical !== "boolean") {
        accepted.push(false);
        continue;
      }
      const repository = link.repository.toLowerCase(), sha = link.sha.toLowerCase();
      const key = repository + "@" + sha;
      if (seen.has(key)) { accepted.push(true); continue; }
      seen.add(key);
      try {
        const result = await recordCommit(tabId, session, repository, sha, "assistant",
          { responseId: message.responseId, historical: link.historical });
        accepted.push(result.ok === true);
      } catch {
        accepted.push(false);
      }
    }
    return { ok: true, accepted };
  }
  if (message.type === "githubCommitReference") {
    if (!session.workflowEnabled || typeof message.repository !== "string" ||
        typeof message.sha !== "string" || !REPOSITORY.test(message.repository) ||
        !COMMIT_SHA.test(message.sha)) return { ok: false };
    const repository = message.repository.toLowerCase(), sha = message.sha.toLowerCase();
    return recordCommit(tabId, session, repository, sha, "assistant", { responseId: message.responseId, historical: message.historical === true });
  }
  if (message.type === "visibleCounts") {
    if (!Number.isInteger(message.user) || message.user < 0 || message.user > 10000 ||
        !Number.isInteger(message.assistant) || message.assistant < 0 || message.assistant > 10000 ||
        (message.codeBlocks !== undefined &&
          (!Number.isInteger(message.codeBlocks) || message.codeBlocks < 0 || message.codeBlocks > 10000)))
      return { ok: false };
    await event(session.id, "visible_counts", {
      visibleUser: message.user, visibleAssistant: message.assistant,
      ...(message.codeBlocks === undefined ? {} : { visibleCodeBlocks: message.codeBlocks })
    });
    const current = await getSession(tabId);
    if (current?.id === session.id)
      await chrome.storage.session.set({ [KEY(tabId)]: { ...current,
        visibleUser: message.user, visibleAssistant: message.assistant,
        visibleCodeBlocks: message.codeBlocks ?? null, lastCountAt: Date.now() } });
    return { ok: true };
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const operation = operationQueue.then(async () => {
    if (!message || typeof message.type !== "string") throw Error("Invalid request");
    if (["visibleCounts", "conversationChanged", "observerStatus",
      "workflowStage", "githubCommitReference", "githubCommitReferences", "requestBoundary", "assistantBoundary", "assistantEvidence"].includes(message.type))
      return fromPage(message, sender);
    if (message.type === "importCommitUrl") {
      // Only the extension's own side panel may invoke manual import.
      if (sender.tab) return { ok: false };
      const tabId = message.tabId;
      if (!Number.isInteger(tabId)) return { ok: false };
      const session = await getSession(tabId);
      const tab = await chrome.tabs.get(tabId);
      if (!session?.workflowEnabled || !eligible(tab.url) ||
          session.page !== new URL(tab.url).pathname) return { ok: false };
      const commit = parseCommitUrl(message.url);
      if (!commit) return { ok: false, error: "Provide a full GitHub commit URL containing a 40-character SHA." };
      return recordCommit(tabId, session, commit.repository, commit.sha, "manual", { taskId: message.taskId });
    }
    if (message.type === "exportEvidence") {
      const data = bounded(await readEvidence());
      return { ok: true, data: {
        ...data,
        analysis: globalThis.GentleCodingAnalysis.analyze(data),
        exportedAt: new Date().toISOString(),
        attribution: "Observed links and request-stage labels are not proof of authorship, execution, success, or deployment."
      } };
    }
    if (message.type === "clearEvidence") {
      await mutateEvidence(data => {
        data.events = [];
        data.commits = {};
        data.clearGeneration = (data.clearGeneration || 0) + 1;
      });
      return { ok: true };
    }
    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw Error("No selected tab.");
    const tab = await chrome.tabs.get(tabId);
    if (message.type === "getState") {
      const session = await getSession(tabId);
      const allowed = eligible(tab.url);
      const samePage = allowed && session?.page === new URL(tab.url).pathname;
      if (session && !samePage) await stop(tabId);
      const local = await readEvidence();
      const analysis = globalThis.GentleCodingAnalysis.analyze(local);
      return {
        ok: true, allowed, reason: allowed ? null : "Open ChatGPT in the active tab.",
        active: Boolean(session && samePage),
        visibleUser: samePage ? session?.visibleUser ?? null : null,
        visibleAssistant: samePage ? session?.visibleAssistant ?? null : null,
        visibleCodeBlocks: samePage ? session?.visibleCodeBlocks ?? null : null,
        codingMarked: Boolean(samePage && session?.codingMarked),
        workflowEnabled: Boolean(samePage && session?.workflowEnabled),
        workflowStages: samePage ? session?.workflowStages ?? 0 : 0,
        detector: samePage ? session?.detector ?? null : null,
        lastObservedAt: samePage ? session?.lastObservedAt ?? null : null,
        lastCountAt: samePage ? session?.lastCountAt ?? null : null,
        attributionTasks: analysis.tasks.filter(task => task.requestId).map(task => ({
          taskId: task.taskId, startedAt: task.startedAt, stages: task.stages })),
        unresolvedCommits: analysis.unattributedCommits,
        recordedEvents: local.events.length,
        recordedCommits: Object.values(local.commits).filter(c => c.status === "retrieved").length
      };
    }
    if (message.type === "start") { await start(tabId); return { ok: true }; }
    if (message.type === "stop") { await stop(tabId); return { ok: true }; }
    if (message.type === "setWorkflowAnalysis") {
      if (typeof message.enabled !== "boolean") throw Error("Invalid workflow option.");
      const session = await getSession(tabId);
      if (!session || !eligible(tab.url) || session.page !== new URL(tab.url).pathname)
        throw Error("Start recording this conversation first.");
      if (message.enabled === Boolean(session.workflowEnabled)) return { ok: true };
      await chrome.storage.session.set({ [KEY(tabId)]: {
        ...session, workflowEnabled: message.enabled, consentEpoch: (session.consentEpoch || 0) + 1
      } });
      try { await chrome.tabs.sendMessage(tabId, {
        type: "gcrWorkflowMode", enabled: message.enabled
      }); }
      catch {
        if (message.enabled) {
          const current = await getSession(tabId);
          if (current?.id === session.id)
            await chrome.storage.session.set({ [KEY(tabId)]: { ...current, workflowEnabled: false } });
          throw Error("Page observer unavailable. Reload ChatGPT, start recording, and try again.");
        }
      }
      return { ok: true };
    }
    if (message.type === "setCodingTag") {
      if (typeof message.codingMarked !== "boolean") throw Error("Invalid tag.");
      const session = await getSession(tabId);
      if (!session || !eligible(tab.url) || session.page !== new URL(tab.url).pathname)
        throw Error("Start recording this conversation first.");
      await event(session.id, "coding_tag", { codingMarked: message.codingMarked });
      const current = await getSession(tabId);
      if (current?.id === session.id)
        await chrome.storage.session.set({ [KEY(tabId)]: { ...current, codingMarked: message.codingMarked } });
      return { ok: true };
    }
    throw Error("Unsupported operation.");
  });
  operationQueue = operation.catch(() => {});
  operation.then(async result => {
    if (result?.retrieval) await result.retrieval;
    if (result) delete result.retrieval;
    respond(result);
  }).catch(() => respond({ ok: false, error: "Local extension operation failed." }));
  return true;
});
function queueStop(tabId) {
  operationQueue = operationQueue.then(() => stop(tabId)).catch(() => {});
}
chrome.tabs.onRemoved.addListener(queueStop);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) queueStop(tabId);
});
