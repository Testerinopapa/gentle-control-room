"use strict";

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
const MAX_EVENTS = 1500;
const MAX_COMMITS = 30;
const RETENTION_MS = 30 * 86400000;
const MAX_PATCH_BYTES = 24000;
const MAX_RESPONSE_BYTES = 512000;
const MAX_EVIDENCE_BYTES = 3500000;
const pendingCommits = new Set();
let storageQueue = Promise.resolve();

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
    const result = change(data);
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
    return { status: "retrieved", files, changedFiles: json.files.length,
      note: "A commit link was seen in an assistant message. Authorship, tests and outcome are unverified." };
  } finally { clearTimeout(timeout); }
}
async function collectCommit(repository, sha, sessionId, clearGeneration) {
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
    const active = await chrome.storage.session.get(null);
    const consented = Object.values(active).some(session =>
      session?.id === sessionId && session.workflowEnabled && (session.commitRefs || []).includes(key));
    if (!consented) return;
    await mutateEvidence(data => {
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
  await event(id, "session_started");
  await chrome.storage.session.set({ [KEY(tabId)]: {
    id, page: new URL(tab.url).pathname,
    visibleUser: null, visibleAssistant: null, visibleCodeBlocks: null,
    codingMarked: false, workflowEnabled: false, workflowStages: 0, commitRefs: [],
    detector: null, lastObservedAt: null, lastCountAt: null
  } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#166534" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); }
  catch {
    await stop(tabId);
    throw Error("Cannot observe this tab. Reload ChatGPT and start again.");
  }
}
async function recordCommit(tabId, session, repository, sha, discovery) {
  const key = repository + "@" + sha;
  if ((session.commitRefs || []).includes(key)) return { ok: true, duplicate: true };
  if ((session.commitRefs || []).length >= 30) return { ok: false };
  const current = await getSession(tabId);
  if (!current || current.id !== session.id || !current.workflowEnabled) return { ok: false };
  // Capture deletion generation before an asynchronous GitHub request.
  const clearGeneration = (await readEvidence()).clearGeneration || 0;
  await event(session.id, "github_commit_ref", { repository, commitSha: sha, discovery });
  const next = await getSession(tabId);
  if (!next || next.id !== session.id || !next.workflowEnabled) return { ok: false };
  await chrome.storage.session.set({ [KEY(tabId)]: { ...next,
    commitRefs: [...(next.commitRefs || []), key] } });
  await collectCommit(repository, sha, session.id, clearGeneration);
  return { ok: true };
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
  if (message.type === "workflowStage") {
    if (!session.workflowEnabled || !WORKFLOW_STAGES.has(message.stage) ||
        session.workflowStages >= 120) return { ok: false };
    await event(session.id, "workflow_stage", { stage: message.stage });
    const current = await getSession(tabId);
    if (current?.id === session.id && current.workflowEnabled)
      await chrome.storage.session.set({ [KEY(tabId)]: { ...current,
        workflowStages: current.workflowStages + 1 } });
    return { ok: true };
  }
  if (message.type === "githubCommitReference") {
    if (!session.workflowEnabled || typeof message.repository !== "string" ||
        typeof message.sha !== "string" || !REPOSITORY.test(message.repository) ||
        !COMMIT_SHA.test(message.sha)) return { ok: false };
    const repository = message.repository.toLowerCase(), sha = message.sha.toLowerCase();
    return recordCommit(tabId, session, repository, sha, "assistant");
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
  (async () => {
    if (!message || typeof message.type !== "string") throw Error("Invalid request");
    if (["visibleCounts", "conversationChanged", "observerStatus",
      "workflowStage", "githubCommitReference"].includes(message.type))
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
      return recordCommit(tabId, session, commit.repository, commit.sha, "manual");
    }
    if (message.type === "exportEvidence") {
      const data = await readEvidence();
      return { ok: true, data: { ...bounded(data), exportedAt: new Date().toISOString(),
        attribution: "Observed links are not proof of authorship, success, or deployment." } };
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
        ...session, workflowEnabled: message.enabled
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
  })().then(respond, () => respond({ ok: false, error: "Local extension operation failed." }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void stop(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) void stop(tabId);
});
