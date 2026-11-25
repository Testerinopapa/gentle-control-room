"use strict";

// Load deterministic evidence analysis locally in this classic MV3 worker.
importScripts("analysis.js");

// Standalone Edge extension. No native host, Windows process, remote analysis
// provider, or privileged filesystem access is required.
const KEY = tabId => "gcrChatGPTTab:" + tabId;
const LOCAL_KEY = "gcrEvidenceV1";
const BROWSER_CHAT_KEY = "gcrBrowserConversationV1";
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
const MAX_PUBLIC_HISTORY_REPOS = 2;
const PUBLIC_HISTORY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
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
// Browser message text is stored separately from coding evidence after the
// explicitly labeled Start/capture action. It never enters Codex exports.
async function readBrowserChats() {
  const stored = (await chrome.storage.local.get(BROWSER_CHAT_KEY))[BROWSER_CHAT_KEY];
  if (stored?.version !== 1 || !Array.isArray(stored.snapshots))
    return { version: 1, snapshots: [] };
  // Existing browser captures from older versions may contain only an
  // accessible speaker label. Clean them when reading, without losing
  // legitimate text or touching the separate coding evidence store.
  return { ...stored, snapshots: stored.snapshots.map(snapshot => ({
    ...snapshot,
    messages: Array.isArray(snapshot.messages)
      ? collapseDuplicateAssistantReplies(
          snapshot.messages.map(normalizeChatTurn).filter(item => item.text))
      : []
  })) };
}
function boundedBrowserChats(store) {
  const cutoff = Date.now() - RETENTION_MS;
  store.snapshots = store.snapshots.filter(item =>
    item && Number.isFinite(Date.parse(item.capturedAt)) &&
    Date.parse(item.capturedAt) >= cutoff &&
    Array.isArray(item.messages)).sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt)).slice(-6);
  while (JSON.stringify(store).length > 1600000 && store.snapshots.length > 1)
    store.snapshots.shift();
  return store;
}
// Stable local pseudonym of the conversation path. We don't save URLs or
// raw ChatGPT conversation IDs. High-entropy chat IDs make collisions unlikely.
function chatIdentity(pathname) {
  if (typeof pathname !== "string" || pathname.length > 1024) return null;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < pathname.length; i++) {
    h ^= BigInt(pathname.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
function browserChatForTab(store, session, path = null) {
  // Prefer the same active recording, then earlier recordings of the same
  // conversation. Never fall back to a different chat while one is active.
  const key = session?.page ? chatIdentity(session.page) : chatIdentity(path);
  if (session) return store.snapshots.find(item => item.sessionId === session.id) ||
    (key && store.snapshots.filter(item => item.conversationKey === key).at(-1)) || null;
  if (key) return store.snapshots.filter(item => item.conversationKey === key).at(-1) || null;
  return null;
}
function cleanChatText(role, text) {
  const value = String(text).trim();
  return role === "assistant"
    ? value.replace(/^(?:ChatGPT said:\s*)+/i, "").trim()
    : role === "user" ? value.replace(/^(?:You said:\s*)+/i, "").trim() : value;
}
// Normalize GitHub identifiers from captured DOM metadata, never trust raw URLs.
function normalizeChatGithub(github) {
  const repos = Array.isArray(github?.repositories) ? github.repositories : [];
  const refs = Array.isArray(github?.commits) ? github.commits : [];
  const repositories = [...new Set(repos.filter(repo => typeof repo === "string" &&
    REPOSITORY.test(repo)).map(repo => repo.toLowerCase()))].slice(0, 8);
  const commits = [];
  const seen = new Set();
  for (const ref of refs.slice(0, 12)) {
    if (typeof ref?.repository !== "string" || typeof ref?.sha !== "string" ||
        !REPOSITORY.test(ref.repository) || !COMMIT_SHA.test(ref.sha)) continue;
    const repository = ref.repository.toLowerCase(), sha = ref.sha.toLowerCase();
    const key = repository + "@" + sha;
    if (seen.has(key)) continue;
    seen.add(key);
    commits.push({ repository, sha, url: "https://github.com/" + repository + "/commit/" + sha });
    if (!repositories.includes(repository) && repositories.length < 8)
      repositories.push(repository);
  }
  return { repositories, commits };
}
function unionChatGithub(a, b) {
  return normalizeChatGithub({
    repositories: [...(a?.repositories || []), ...(b?.repositories || [])],
    commits: [...(a?.commits || []), ...(b?.commits || [])]
  });
}
// Older locally saved conversations predate structured link metadata.
// Recover only explicit GitHub URLs or labeled repository identities from text.
function githubFromText(text) {
  const repositories = [], commits = [];
  const raw = String(text || "");
  for (const match of raw.matchAll(/(?:https?:\/\/)?github\.com\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})(?:\/commit\/([a-f0-9]{40}))?(?=[\s/?#"'<>)]|$)/gi)) {
    const repository = (match[1] + "/" + match[2]).toLowerCase();
    repositories.push(repository);
    if (match[3]) commits.push({ repository, sha: match[3].toLowerCase() });
  }
  for (const match of raw.matchAll(/\b(?:repository|repo)\s*[:=]\s*[`"']?([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})\b/gi))
    repositories.push(match[1].toLowerCase());
  return normalizeChatGithub({ repositories, commits });
}
function normalizeChatTurn(message) {
  const text = cleanChatText(message.role, message.text);
  const key = typeof message.key === "string" && message.key.length <= 220 &&
    /^[a-z]+:[^\r\n]{1,210}$/.test(message.key) ? message.key : null;
  const recovered = githubFromText(text);
  const github = normalizeChatGithub({
    repositories: [...(Array.isArray(message.github?.repositories) ? message.github.repositories : []),
      ...recovered.repositories],
    commits: [...(Array.isArray(message.github?.commits) ? message.github.commits : []),
      ...recovered.commits]
  });
  return { role: message.role, text, ...(key ? { key } : {}),
    ...((github.repositories.length || github.commits.length) ? { github } : {}) };
}
// Re-captures can contain two renderings of the same assistant turn:
// one includes status/tool progress, the other is the final reply. Only
// deduplicate adjacent assistant messages with substantial 5-word overlap.
// Never merge distinct conversations or unrelated assistant messages.
function replyTokens(text) {
  return String(text).toLowerCase().match(/[a-z0-9\u00c0-\u024f]+/g) || [];
}
function duplicateAssistantReplies(a, b) {
  if (a?.role !== "assistant" || b?.role !== "assistant" ||
      a.text.length < 120 || b.text.length < 120) return false;
  const first = replyTokens(a.text), second = replyTokens(b.text);
  if (Math.min(first.length, second.length) < 24) return false;
  const shingles = words => {
    const set = new Set();
    for (let i = 0; i <= words.length - 5; i++)
      set.add(words.slice(i, i + 5).join(" "));
    return set;
  };
  const sa = shingles(first), sb = shingles(second);
  if (!sa.size || !sb.size) return false;
  let common = 0;
  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = sa.size <= sb.size ? sb : sa;
  for (const item of smaller) if (larger.has(item)) common++;
  return common / smaller.size >= 0.88;
}
function preferCompleteAssistantReply(a, b) {
  const shorter = a.text.length <= b.text.length ? a : b;
  const longer = a.text.length <= b.text.length ? b : a;
  const shortWords = replyTokens(shorter.text), longWords = replyTokens(longer.text);
  const endOfShort = shortWords.slice(-12).join(" ");
  const tailOfLong = longWords.slice(-Math.max(30, Math.floor(longWords.length * 0.6))).join(" ");
  // When the entire final reply is at the end of a progress-wrapped version,
  // keep the cleaner reply instead of retaining status messages as prose.
  if (tailOfLong.includes(endOfShort)) return shorter;
  return longer;
}
function collapseDuplicateAssistantReplies(messages) {
  const result = [];
  for (const item of messages) {
    const previous = result.at(-1);
    if (duplicateAssistantReplies(previous, item)) {
      result[result.length - 1] = {
        ...preferCompleteAssistantReply(previous, item),
        github: unionChatGithub(previous.github, item.github)
      };
    } else result.push(item);
  }
  return result;
}

function sameChatTurn(a, b) {
  // Older v0.9.3 snapshots have no stable keys. Compare their cleaned
  // content when merging an upgraded recording.
  return Boolean(a.key && b.key && a.key === b.key) ||
    (a.role === b.role && a.text === b.text);
}
// Merge at the *user-turn* level. Prior implementations inserted individual
// messages around the nearest matching assistant and could scramble the order
// of old prompts whenever a new capture exposed a different history window.
// A top-to-bottom DOM scan is authoritative for visible user-turn ordering;
// older snapshots contribute missing turns and replies, never reorder it.
function chatComparableText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}
function chatTurnBlocks(messages) {
  const turns = [], prelude = [];
  for (const message of messages.map(normalizeChatTurn).filter(item => item.text)) {
    if (message.role === "user") turns.push({ user: message, replies: [] });
    else if (turns.length) turns[turns.length - 1].replies.push(message);
    else prelude.push(message);
  }
  return { turns, prelude };
}
function findChatTurn(needle, haystack) {
  // Stable user identifiers are preferred. Text fallback is used only for
  // substantial, unique prompts (not repeated "proceed" or "yes" messages).
  if (needle.user?.key) {
    const ids = haystack.map((item, i) => item.user.key === needle.user.key ? i : -1)
      .filter(i => i >= 0);
    if (ids.length === 1) return ids[0];
  }
  const text = chatComparableText(needle.user?.text);
  if (text.length < 14) return -1;
  const found = haystack.map((item, i) =>
    chatComparableText(item.user.text) === text ? i : -1).filter(i => i >= 0);
  return found.length === 1 ? found[0] : -1;
}
function mergeChatReplies(previous, incoming) {
  const out = previous.slice();
  for (const next of incoming) {
    const match = out.findIndex(saved => sameChatTurn(saved, next) ||
      duplicateAssistantReplies(saved, next));
    if (match >= 0) {
      const github = unionChatGithub(out[match].github, next.github);
      if (duplicateAssistantReplies(out[match], next))
        out[match] = { ...preferCompleteAssistantReply(out[match], next), github };
      else if (next.text.length >= out[match].text.length)
        out[match] = { ...next, github };
      else out[match] = { ...out[match], github };
    } else out.push(next);
  }
  return collapseDuplicateAssistantReplies(out);
}
function mergeChatWindows(previous, incoming, options = {}) {
  // A first capture has no prior chronology to contradict. Only an orphan
  // assistant reply with no preceding user turn has uncertain placement.
  if (!previous.length) {
    const normalized = incoming.map(normalizeChatTurn).filter(item => item.text);
    return { messages: normalized,
      uncertain: normalized.length > 0 && normalized[0].role === "assistant" };
  }
  const old = chatTurnBlocks(previous);
  const fresh = chatTurnBlocks(incoming);
  const preferIncomingOrder = options.preferIncomingOrder === true && fresh.turns.length > 0;
  const base = (preferIncomingOrder ? fresh : old).turns.map(block =>
    ({ user: block.user, replies: block.replies.slice() }));
  const other = (preferIncomingOrder ? old : fresh).turns;
  let uncertain = false, earlierMatch = -1, hasAnchor = false;
  // A virtualized window can start with the previous turn's assistant reply
  // but not its user prompt. Use that reply as an ordering anchor when its
  // stable identity matches an already retained assistant response.
  const orphanStart = (preferIncomingOrder ? old : fresh).prelude;
  for (const orphan of orphanStart) {
    const linked = base.findIndex(block => block.replies.some(reply =>
      sameChatTurn(reply, orphan) || duplicateAssistantReplies(reply, orphan)));
    if (linked >= 0) { earlierMatch = linked; hasAnchor = true; }
  }
  for (let i = 0; i < other.length; i++) {
    const block = other[i];
    const currentIndex = findChatTurn(block, base);
    if (currentIndex >= 0) {
      hasAnchor = true;
      if (earlierMatch > currentIndex && !preferIncomingOrder) uncertain = true;
      const current = base[currentIndex];
      // The freshest scan's user identity is retained when its ordering wins.
      const github = unionChatGithub(current.user.github, block.user.github);
      if (!preferIncomingOrder && block.user.text.length >= current.user.text.length)
        current.user = { ...block.user, github };
      else current.user = { ...current.user, github };
      current.replies = preferIncomingOrder
        ? mergeChatReplies(block.replies, current.replies)
        : mergeChatReplies(current.replies, block.replies);
      earlierMatch = currentIndex;
      continue;
    }
    // Place an old missing turn between neighboring common user prompts.
    // When windows have no shared anchors, append conservatively and report
    // uncertain order instead of blindly PREPENDING (the original regression).
    let nextAnchor = -1;
    for (let j = i + 1; j < other.length; j++) {
      nextAnchor = findChatTurn(other[j], base);
      if (nextAnchor >= 0) break;
    }
    let insertion = base.length;
    if (nextAnchor >= 0 && (earlierMatch < 0 || nextAnchor > earlierMatch))
      insertion = nextAnchor;
    else if (earlierMatch >= 0) insertion = earlierMatch + 1;
    else uncertain = true;
    base.splice(insertion, 0, { user: block.user, replies: block.replies.slice() });
    earlierMatch = insertion;
    if (nextAnchor < 0 && earlierMatch === base.length - 1 && i > 0 &&
        !hasAnchor) uncertain = true;
  }
  if (old.turns.length && fresh.turns.length && !hasAnchor) uncertain = true;
  const knownReplies = base.flatMap(block => block.replies);
  const isKnownReply = orphan => knownReplies.some(reply =>
    sameChatTurn(reply, orphan) || duplicateAssistantReplies(reply, orphan));
  const olderPrelude = old.prelude.filter(item => !isKnownReply(item));
  const newerPrelude = fresh.prelude.filter(item => !isKnownReply(item));
  const prelude = mergeChatReplies(olderPrelude, newerPrelude);
  if (prelude.length && base.length) uncertain = true;
  return { messages: [
    ...prelude,
    ...base.flatMap(block => [block.user, ...collapseDuplicateAssistantReplies(block.replies)])
  ], uncertain };
}
// Legacy v0.9.3–0.9.5 captures have no conversation identity. An overlap of
// substantial user+assistant messages is sufficient to migrate them safely;
// avoid merging different conversations on common replies like "Done".
function confirmsSameChat(previous, incoming) {
  let user = 0, assistant = 0;
  for (const entry of incoming) {
    if (entry.text.length < 26) continue;
    if (!previous.some(other => sameChatTurn(other, entry))) continue;
    if (entry.role === "user") user++;
    if (entry.role === "assistant" && entry.text.length >= 80) assistant++;
  }
  return (user >= 2 && assistant >= 1) || (user >= 1 && assistant >= 2) ||
    user >= 4 || assistant >= 4;
}

function boundChatMessages(messages) {
  let total = messages.reduce((sum, message) => sum + message.text.length, 0);
  let limited = false;
  while (messages.length > 160 || total > 350000) {
    const removed = messages.splice(Math.floor(messages.length / 2), 1)[0];
    total -= removed.text.length;
    limited = true;
  }
  return { messages, limited };
}

function browserChatMeta(chat) {
  return chat ? { sessionId: chat.sessionId, capturedAt: chat.capturedAt,
    messageCount: chat.messages.length, truncated: chat.truncated,
    orderUncertain: chat.orderUncertain === true,
    renderedCount: chat.renderedCount,
    coverage: chat.coverage || null } : null;
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
  // Limit lookup metadata alongside the same 30-day consented evidence store.
  if (data.publicHistoryLookups && typeof data.publicHistoryLookups === "object") {
    for (const [repo, timestamp] of Object.entries(data.publicHistoryLookups))
      if (!REPOSITORY.test(repo) || !Number.isFinite(timestamp) || timestamp < cutoff)
        delete data.publicHistoryLookups[repo];
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
      // GitHub commit metadata supports topic comparison but is not proof
      // of who requested, performed or verified a change.
      message: typeof json.commit?.message === "string"
        ? json.commit.message.split(/\r?\n/)[0].slice(0, 160) : "",
      committedAt: typeof json.commit?.committer?.date === "string" &&
        Number.isFinite(Date.parse(json.commit.committer.date))
        ? json.commit.committer.date.slice(0, 40) : null,
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
    // An earlier failed public lookup must not permanently block a later
    // explicit user-initiated rescan. Successful/metadata-only records are cached.
    if (existing.commits[key] && existing.commits[key].status !== "unavailable") return;
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["live-archiver-reader.js", "content.js"] });
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
    discovery === "conversation_scan" || discovery === "repository_history" ? "unattributed" :
    details.historical === true ? "historical" :
      request?.confidence === "supported" ? "automatic" : "unattributed";
  if (state !== "historical" && !(current.commitRefs || []).includes(key) &&
      (current.commitRefs || []).length >= MAX_COMMITS) return { ok: false };
  const taskId = state === "manual" ? manualTask.taskId : state === "automatic" ? request.taskId : null;
  const association = { state, method: discovery === "manual" ? "user_selection" :
      discovery === "conversation_scan" ? "captured_conversation_link" :
      discovery === "repository_history" ? "public_repository_history" : "assistant_response",
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
  // A duplicate link may have been recorded before a GitHub API failure.
  // Keep its single evidence event, but allow a subsequent consented retry.
  const existingCommit = (await readEvidence()).commits[key];
  if (!inserted && (state === "historical" ||
      (existingCommit && existingCommit.status !== "unavailable")))
    return { ok: true, duplicate: true };
  const next = await getSession(tabId);
  if (!next || next.id !== session.id || !next.workflowEnabled) return { ok: false };
  await chrome.storage.session.set({ [KEY(tabId)]: { ...next,
    commitRefs: state === "historical" ? (next.commitRefs || []) : [...new Set([...(next.commitRefs || []), key])] } });
  return { ok: true, duplicate: !inserted, retrieval: state !== "historical"
    ? collectCommit(repository, sha, session.id, clearGeneration, session.consentEpoch || 0) : null };
}
// Import real commit references retained by the two-pass transcript reader.
 // If no commit address was shown for an identified repository, inspect only
 // a few recent public default-branch commits. Discovery is NEVER authorship
 // or evidence that a commit implemented a particular chat request.
async function recentPublicCommits(repository) {
  if (!REPOSITORY.test(repository)) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://api.github.com/repos/" + repository + "/commits?per_page=3",
      { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
        redirect: "error", credentials: "omit" });
    if (!response.ok) return null;
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > 32000) return null;
    const body = await response.text();
    if (body.length > 32000) return null;
    const data = JSON.parse(body);
    if (!Array.isArray(data) || data.length > 3) return null;
    return [...new Set(data.map(item => item?.sha?.toLowerCase())
      .filter(sha => typeof sha === "string" && COMMIT_SHA.test(sha)))];
  } catch { return null; }
  finally { clearTimeout(timeout); }
}
async function collectConversationGithub(tabId, session, messages) {
  const explicit = new Map(), repos = new Map();
  for (const message of messages) {
    const github = normalizeChatGithub(message.github);
    for (const repo of github.repositories)
      repos.set(repo, (repos.get(repo) || 0) + 1);
    for (const ref of github.commits) explicit.set(ref.repository + "@" + ref.sha, ref);
  }
  // Explicit commit links take precedence, including older messages already
  // present when recording began. Do not infer authorship or task association.
  const pendingPatches = [];
  for (const ref of [...explicit.values()].slice(0, 12)) {
    const active = await getSession(tabId);
    if (!active || active.id !== session.id || !active.workflowEnabled) return;
    const result = await recordCommit(tabId, session, ref.repository, ref.sha, "conversation_scan");
    if (result?.retrieval) pendingPatches.push(result.retrieval);
  }
  const reposWithCommits = new Set([...explicit.values()].map(ref => ref.repository));
  const possibleRepos = [...repos.entries()]
    .filter(([repository]) => !reposWithCommits.has(repository))
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_PUBLIC_HISTORY_REPOS);
  for (const [repository] of possibleRepos) {
    const active = await getSession(tabId);
    if (!active || active.id !== session.id || !active.workflowEnabled) return;
    const existing = await readEvidence();
    const lastLookup = existing.publicHistoryLookups?.[repository] || 0;
    if (Date.now() - lastLookup < PUBLIC_HISTORY_COOLDOWN_MS) {
      // Reuse already identified SHAs when a previous public patch request
      // failed, without re-querying the repository history or duplicating events.
      const failed = [...new Set(existing.events.filter(e =>
        e.type === "github_commit_ref" && e.discovery === "repository_history" &&
        e.repository === repository && e.sessionId === session.id &&
        existing.commits[repository + "@" + e.commitSha]?.status === "unavailable")
        .map(e => e.commitSha))].slice(0, 3);
      for (const sha of failed) {
        const result = await recordCommit(tabId, session, repository, sha, "repository_history");
        if (result?.retrieval) pendingPatches.push(result.retrieval);
      }
      continue;
    }
    const shas = await recentPublicCommits(repository);
    if (!shas) continue; // Network/API errors must not block later retry.
    await mutateEvidence(data => {
      if (!data.publicHistoryLookups) data.publicHistoryLookups = {};
      data.publicHistoryLookups[repository] = Date.now();
    });
    for (const sha of shas) {
      const current = await getSession(tabId);
      if (!current || current.id !== session.id || !current.workflowEnabled) return;
      const result = await recordCommit(tabId, session, repository, sha, "repository_history");
      if (result?.retrieval) pendingPatches.push(result.retrieval);
    }
  }
  await Promise.allSettled(pendingPatches);
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
        ...(isRequest ? { confidence: message.confidence === "supported" && message.historical !== true
           ? "supported" : "uncertain", historical: message.historical === true } :
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
        e.type === "assistant_response" && e.responseId === message.responseId);
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
    if (message.type === "clearBrowserConversation") {
      if (sender.tab) return { ok: false };
      await chrome.storage.local.set({
        [BROWSER_CHAT_KEY]: { version: 1, snapshots: [] }
      });
      return { ok: true };
    }
    if (message.type === "clearEvidence") {
      await mutateEvidence(data => {
        data.events = [];
        data.commits = {};
        data.publicHistoryLookups = {};
        data.clearGeneration = (data.clearGeneration || 0) + 1;
      });
      await chrome.storage.local.set({
        [BROWSER_CHAT_KEY]: { version: 1, snapshots: [] }
      });
      return { ok: true };
    }
    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw Error("No selected tab.");
    const tab = await chrome.tabs.get(tabId);
    if (message.type === "getBrowserConversation") {
      if (sender.tab) return { ok: false };
      const session = await getSession(tabId);
      const chats = boundedBrowserChats(await readBrowserChats());
      const path = eligible(tab.url) ? new URL(tab.url).pathname : null;
      // A tab with no matching ChatGPT conversation must never receive the
      // most recently saved transcript from an unrelated tab.
      return { ok: true, snapshot: path
        ? browserChatForTab(chats, session?.page === path ? session : null, path)
        : null };
    }
    if (message.type === "captureBrowserConversation") {
      if (sender.tab) return { ok: false };
      const session = await getSession(tabId);
      if (!session?.workflowEnabled || !eligible(tab.url) ||
          session.page !== new URL(tab.url).pathname)
        return { ok: false, error: "Start recording this ChatGPT conversation first." };
      let rendered;
      try {
        rendered = await chrome.tabs.sendMessage(tabId, { type: "gcrCaptureConversation" });
      } catch {
        return { ok: false, error: "Cannot read the ChatGPT page. Refresh it and restart recording." };
      }
      if (!rendered?.ok || !Array.isArray(rendered.messages) ||
          rendered.messages.length > 160)
        return { ok: false, error: rendered?.error || "Browser conversation was unavailable." };
      let chars = 0;
      const messages = [];
      for (const entry of rendered.messages) {
        if (!entry || !["user", "assistant"].includes(entry.role) ||
            typeof entry.text !== "string" || entry.text.length > 8000)
          return { ok: false, error: "Invalid browser conversation content." };
        chars += entry.text.length;
        if (chars > 350000) return { ok: false, error: "Conversation snapshot is too large." };
        if (entry.key !== undefined &&
            (typeof entry.key !== "string" || entry.key.length > 220))
          return { ok: false, error: "Invalid browser message identity." };
        messages.push(normalizeChatTurn(entry));
      }
      // Consent can be revoked while the browser is preparing its reply.
      const current = await getSession(tabId);
      if (!current || current.id !== session.id ||
          current.page !== session.page || !current.workflowEnabled)
        return { ok: false, error: "Recording ended before capture completed." };
      const chats = await readBrowserChats();
      const conversationKey = chatIdentity(session.page);
      // Match new-version captures by stable conversation identity. For older
      // snapshots without a key, migrate only with strong message overlap.
      const matches = chats.snapshots.filter(item =>
        item.sessionId === session.id || item.conversationKey === conversationKey ||
        (!item.conversationKey && confirmsSameChat(item.messages, messages)))
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      let combined = [];
      let orderUncertain = rendered.orderUncertain === true;
      let truncated = rendered.truncated === true;
      for (const item of matches) {
        const merge = mergeChatWindows(combined, item.messages, {
          preferIncomingOrder: item.coverage?.atTop === true &&
            item.coverage?.atBottom === true
        });
        combined = merge.messages;
        orderUncertain ||= merge.uncertain || item.orderUncertain === true;
        truncated ||= item.truncated === true;
      }
      const authoritativeScan = rendered.coverage?.atTop === true &&
        rendered.coverage?.atBottom === true;
      const merged = mergeChatWindows(combined, messages, {
        preferIncomingOrder: authoritativeScan
      });
      // A complete new pass repairs the relative ordering of older user
      // turns. Don't carry forward obsolete "uncertain" from corrupt
      // snapshots when every old turn has a reliable current anchor.
      orderUncertain = authoritativeScan
        ? rendered.orderUncertain === true || merged.uncertain
        : orderUncertain || merged.uncertain;
      const limited = boundChatMessages(merged.messages);
      const snapshot = {
        sessionId: session.id, conversationKey, capturedAt: new Date().toISOString(),
        messages: collapseDuplicateAssistantReplies(limited.messages),
        renderedCount: Number.isInteger(rendered.renderedCount) ?
          Math.min(240, Math.max(0, rendered.renderedCount)) : messages.length,
        truncated: truncated || limited.limited,
        orderUncertain,
        coverage: rendered.coverage && typeof rendered.coverage === "object" ? {
          scanMethod: "live_archiver_dom_two_pass",
          atTop: rendered.coverage.atTop === true,
          atBottom: rendered.coverage.atBottom === true,
          initiallyRendered: Number.isInteger(rendered.coverage.initiallyRendered)
            ? Math.max(0, Math.min(240, rendered.coverage.initiallyRendered)) : null,
          stoppedEarly: rendered.coverage.stoppedEarly === true,
          supplementalReplies: Number.isInteger(rendered.coverage.supplementalReplies)
            ? Math.max(0, Math.min(160, rendered.coverage.supplementalReplies)) : 0,
          recoveredFromUpwardPass: Number.isInteger(rendered.coverage.recoveredFromUpwardPass)
            ? Math.max(0, Math.min(160, rendered.coverage.recoveredFromUpwardPass)) : 0,
          recoveredUserTurns: Number.isInteger(rendered.coverage.recoveredUserTurns)
            ? Math.max(0, Math.min(160, rendered.coverage.recoveredUserTurns)) : 0,
          uncertainPlacements: Number.isInteger(rendered.coverage.uncertainPlacements)
            ? Math.max(0, Math.min(160, rendered.coverage.uncertainPlacements)) : 0,
          unanchoredReplies: Number.isInteger(rendered.coverage.unanchoredReplies)
            ? Math.max(0, Math.min(160, rendered.coverage.unanchoredReplies)) : 0,
          observedWindows: Number.isInteger(rendered.coverage.observedWindows)
            ? Math.max(0, Math.min(1500, rendered.coverage.observedWindows)) : 0,
          disconnectedWindows: Number.isInteger(rendered.coverage.disconnectedWindows)
            ? Math.max(0, Math.min(1500, rendered.coverage.disconnectedWindows)) : 0,
          // A backgrounded ChatGPT tab may have delayed UI rendering.
          tabWasHidden: rendered.coverage.tabWasHidden === true,
          // Reaching the DOM scroll boundaries is not proof that every
          // historical assistant response ever mounted in those windows.
          verifiedComplete: false
        } : matches.at(-1)?.coverage || null
      };
      const linked = new Set(matches);
      chats.snapshots = chats.snapshots.filter(item => !linked.has(item));
      chats.snapshots.push(snapshot);
      await chrome.storage.local.set({ [BROWSER_CHAT_KEY]: boundedBrowserChats(chats) });
      // The message handler remains alive until bounded public GitHub
      // retrieval finishes; do not leave unsupported MV3 background tasks.
      // Import only structured GitHub references, never the raw chat text.
      try { await collectConversationGithub(tabId, session, snapshot.messages); }
      catch { /* The conversation capture remains valid if GitHub is unavailable. */ }
      return { ok: true, meta: browserChatMeta(snapshot) };
    }
    if (message.type === "getState") {
      const session = await getSession(tabId);
      const allowed = eligible(tab.url);
      const samePage = allowed && session?.page === new URL(tab.url).pathname;
      if (session && !samePage) await stop(tabId);
      const local = await readEvidence();
      const analysis = globalThis.GentleCodingAnalysis.analyze(local);
      const savedChat = allowed
        ? browserChatForTab(boundedBrowserChats(await readBrowserChats()),
          samePage ? session : null, new URL(tab.url).pathname)
        : null;
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
        patterns: analysis.patterns,
        browserConversation: browserChatMeta(savedChat),
        conversationSummary: (samePage && session
          ? analysis.conversationSummaries.find(item => item.sessionId === session.id)
          : null) || analysis.conversationSummaries.at(-1) || null,
        recordedEvents: local.events.length,
        recordedCommits: Object.values(local.commits).filter(c => c.status === "retrieved").length,
        githubEvidence: {
          capturedRepositories: savedChat
            ? [...new Set(savedChat.messages.flatMap(m => m.github?.repositories || []))].length : 0,
          capturedCommitLinks: savedChat
            ? [...new Set(savedChat.messages.flatMap(m => (m.github?.commits || [])
              .map(ref => ref.repository + "@" + ref.sha)))].length : 0,
          referenceEvents: local.events.filter(e => e.type === "github_commit_ref").length,
          unavailable: Object.values(local.commits).filter(c => c.status === "unavailable").length,
          metadataOnly: Object.values(local.commits).filter(c => c.status === "metadata_only").length
        }
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
