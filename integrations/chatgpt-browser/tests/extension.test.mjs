import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const analysisSource = readFileSync(new URL("../extension/analysis.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const panel = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const HASH = "3d3812a0aade7b5e7c661741054184fd09886613";
const COMMIT = "https://github.com/Testerinopapa/gentle-control-room/commit/" + HASH;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(url = "https://chatgpt.com/c/test-conversation", commitResponse = null, fetchOverride = null) {
  const sessions = new Map(), local = new Map(), badge = [], requests = [], pageCommands = [];
  let listener, tabUpdated, tabRemoved, currentUrl = url;
  const record = commitResponse || {
    sha: HASH,
    files: [
      { filename: "src/feature.ts", status: "modified", additions: 2, deletions: 1,
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+more" },
      { filename: ".env.local", status: "modified", additions: 1, deletions: 0,
        patch: "@@ -1 +1 @@\n-secret\n+changed" }
    ]
  };
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      session: {
        async get(key) {
          if (key === null) return Object.fromEntries(sessions);
          return { [key]: sessions.get(key) };
        },
        async set(items) { for (const [k, v] of Object.entries(items)) sessions.set(k, v); },
        async remove(key) { sessions.delete(key); }
      },
      local: {
        async get(key) { return { [key]: local.get(key) }; },
        async set(items) { for (const [k, v] of Object.entries(items)) local.set(k, v); }
      }
    },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      async get(id) { assert.equal(id, 9); return { id: 9, url: currentUrl }; },
      async sendMessage(_tab, message) { pageCommands.push(message); },
      onUpdated: { addListener(fn) { tabUpdated = fn; } },
      onRemoved: { addListener(fn) { tabRemoved = fn; } }
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText(entry) { badge.push(entry); }
    },
    scripting: { async executeScript() {} }
  };
  const fetch = async (requested, options) => {
    requests.push({ requested, options });
    if (fetchOverride) return fetchOverride(requested, options);
    return {
      ok: true, status: 200,
      headers: { get() { return null; } },
      text: async () => JSON.stringify(record)
    };
  };
  const context = vm.createContext({
    chrome, URL, crypto: { randomUUID }, Date, JSON, fetch,
    setTimeout, clearTimeout, console, AbortController
  });
  context.importScripts = filename => {
    assert.equal(filename, "analysis.js");
    vm.runInContext(analysisSource, context, { filename });
  };
  vm.runInContext(background, context, { filename: "background.js" });
  async function send(message, sender = {}) {
    return await new Promise(resolve => listener(message, sender, resolve));
  }
  return {
    send, local, sessions, badge, requests, pageCommands,
    navigate(next) { currentUrl = next; tabUpdated(9, { url: next }); },
    tabRemoved,
    analyze: data => context.GentleCodingAnalysis.analyze(data)
  };
}
const origin = { tab: { id: 9 } };
async function enable(h) {
  assert.equal((await h.send({ type: "start", tabId: 9 })).ok, true);
  const state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.workflowEnabled, true);
  assert.equal(state.codingMarked, true);
}
async function exported(h) {
  const result = await h.send({ type: "exportEvidence" });
  assert.equal(result.ok, true);
  return result.data;
}

// Commit collection runs asynchronously after a reference is acknowledged.
async function waitForStoredCommit(h, key) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const evidence = await exported(h);
    if (evidence.commits[key]) return evidence.commits[key];
    await tick();
  }
  assert.fail("Timed out waiting for retrieved commit evidence: " + key);
}

test("extension requires no Windows host and uses only approved page + public GitHub API permissions", () => {
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
  assert.ok(manifest.host_permissions.includes("https://chatgpt.com/*"));
  assert.ok(!background.includes("sendNativeMessage"));
  assert.ok(markup.includes('id="export-evidence"'));
  assert.ok(markup.includes('id="clear-evidence"'));
  assert.ok(!markup.includes("Windows connection"));
  assert.ok(panel.includes('type: "exportEvidence"'));
  assert.ok(!markup.includes('id="coding-toggle"'));
  assert.ok(!markup.includes('id="workflow-toggle"'));
  assert.ok(!panel.includes("toggleCodingTag"));
  assert.ok(!panel.includes("toggleWorkflow"));
});

test("starts locally without a host and stores minimal session metadata", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, false);
  assert.equal(h.local.size, 0);
  assert.equal((await h.send({ type: "start", tabId: 9 })).ok, true);
  const state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.active, true);
  assert.equal(state.workflowEnabled, true);
  assert.equal(state.codingMarked, true);
  assert.ok(h.pageCommands.some(message =>
    message.type === "gcrWorkflowMode" && message.enabled === true));
  assert.equal(h.badge.at(-1).text, "ON");
  const data = await exported(h);
  assert.equal(data.version, 1);
  assert.deepEqual(Array.from(data.events, e => e.type), ["session_started", "coding_tag"]);
  assert.equal(data.events[1].codingMarked, true);
  assert.equal(data.events[1].method, "automatic_on_start");
  assert.equal(data.analysis.tasks.length, 0,
    "automatic coding tagging alone must not invent a coding task");
  assert.equal(JSON.stringify(data).includes("/c/test-conversation"), false);
});

test("rejects unapproved pages, invalid counts and background-originated page events", async () => {
  const blocked = harness("https://example.org/c/test");
  assert.equal((await blocked.send({ type: "start", tabId: 9 })).ok, false);
  const h = harness();
  assert.equal((await h.send({ type: "visibleCounts", user: 3, assistant: 4 }, origin)).ok, false);
  await h.send({ type: "start", tabId: 9 });
  assert.equal((await h.send({ type: "visibleCounts", user: "3", assistant: 4 }, origin)).ok, false);
  assert.equal((await h.send({ type: "visibleCounts", user: 3, assistant: 4 })).ok, false);
  assert.equal((await exported(h)).events.length, 2);
});

test("start automatically records a coding tag and enables metadata-only workflow capture", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  assert.equal((await h.send({ type: "getState", tabId: 9 })).workflowEnabled, true);
  const counts = await h.send({
    type: "visibleCounts", user: 3, assistant: 4, codeBlocks: 2,
    prompt: "PRIVATE CHAT", url: "https://chatgpt.com/c/private"
  }, origin);
  assert.equal(counts.ok, true);
  assert.equal((await h.send({ type: "workflowStage", stage: "debugging", prompt: "SECRET" }, origin)).ok, true);
  assert.equal((await h.send({ type: "workflowStage", stage: "arbitrary" }, origin)).ok, false);
  const data = await exported(h);
  assert.deepEqual(Array.from(data.events, x => x.type), ["session_started", "coding_tag", "visible_counts", "workflow_stage"]);
  assert.equal(data.events[1].codingMarked, true);
  assert.equal(data.events.at(-1).stage, "debugging");
  assert.equal(JSON.stringify(data).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(data).includes("SECRET"), false);
  assert.equal(JSON.stringify(data).includes("chatgpt.com/c/"), false);
});

test("GitHub commit link captures actual public diff without local clone or Windows process", async () => {
  const h = harness();
  await enable(h);
  const reference = { type: "githubCommitReference",
    repository: "Testerinopapa/gentle-control-room", sha: HASH, assistantText: "PRIVATE" };
  assert.equal((await h.send(reference, origin)).ok, true);
  const data = await exported(h);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].requested,
    "https://api.github.com/repos/testerinopapa/gentle-control-room/commits/" + HASH);
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(data.events.at(-1).type, "github_commit_ref");
  assert.equal(data.events.at(-1).commitSha, HASH);
  const commit = data.commits["testerinopapa/gentle-control-room@" + HASH];
  assert.equal(commit.status, "retrieved");
  assert.equal(commit.files.length, 1);
  assert.equal(commit.files[0].path, "src/feature.ts");
  assert.match(commit.files[0].patch, /\+more/);
  assert.equal(JSON.stringify(data).includes("PRIVATE"), false);
  assert.equal(commit.note.includes("unverified"), true);
  assert.equal((await h.send(reference, origin)).duplicate, true);
  assert.equal(h.requests.length, 1);
});

test("explicit Start authorizes public GitHub collection, and Stop revokes it", async () => {
  const h = harness();
  const reference = { type: "githubCommitReference",
    repository: "Testerinopapa/gentle-control-room", sha: HASH };
  assert.equal((await h.send(reference, origin)).ok, false);
  assert.equal(h.requests.length, 0);
  await h.send({ type: "start", tabId: 9 });
  assert.equal((await h.send({ ...reference, sha: "bad" }, origin)).ok, false);
  assert.equal((await h.send({ ...reference, repository: "example.com.evil/a" }, origin)).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.send(reference, origin)).ok, true);
  assert.equal(h.requests.length, 1);
  await h.send({ type: "stop", tabId: 9 });
  assert.equal((await h.send(reference, origin)).ok, false);
  assert.equal(h.requests.length, 1);
});

test("renamed secrets, private keys and risky patches are never retained", async () => {
  const h = harness(undefined, { sha: HASH, files: [
    { filename: "src/safe.ts", previous_filename: ".env.local", status: "renamed",
      additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" },
    { filename: "src/token.ts", status: "added", additions: 1, deletions: 0,
      patch: "@@ -0,0 +1 @@\n+sk-ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnop" },
    { filename: "src/ok.ts", status: "added", additions: 1, deletions: 0,
      patch: "@@ -0,0 +1 @@\n+ok" }
  ] });
  await enable(h);
  await h.send({ type: "githubCommitReference",
    repository: "testerinopapa/gentle-control-room", sha: HASH }, origin);
  const data = await exported(h);
  const files = data.commits["testerinopapa/gentle-control-room@" + HASH].files;
  assert.deepEqual(Array.from(files, f => f.path), ["src/ok.ts"]);
});

test("end recording, page switch, and explicit evidence deletion work without native host", async () => {
  const h = harness();
  await enable(h);
  await h.send({ type: "githubCommitReference",
    repository: "testerinopapa/gentle-control-room", sha: HASH }, origin);
  assert.equal((await h.send({ type: "clearEvidence" })).ok, true);
  let data = await exported(h);
  assert.equal(data.events.length, 0);
  assert.equal(Object.keys(data.commits).length, 0);
  assert.equal((await h.send({ type: "stop", tabId: 9 })).ok, true);
  data = await exported(h);
  assert.equal(data.events.at(-1).type, "session_ended");
  assert.equal(h.badge.at(-1).text, "");
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, false);
});

test("deleting evidence prevents an in-flight GitHub patch from returning", async () => {
  let releaseResponse;
  const delayedResponse = new Promise(resolve => { releaseResponse = resolve; });
  const h = harness(undefined, null, () => delayedResponse);
  await enable(h);

  const pending = h.send({
    type: "githubCommitReference",
    repository: "testerinopapa/gentle-control-room", sha: HASH
  }, origin);
  for (let i = 0; i < 30 && h.requests.length === 0; i++) await tick();
  assert.equal(h.requests.length, 1, "the GitHub fetch must already be in progress");
  assert.equal((await h.send({ type: "clearEvidence" })).ok, true);
  const cleared = await exported(h);
  assert.equal(cleared.events.length, 0);
  assert.equal(Object.keys(cleared.commits).length, 0);

  releaseResponse({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: HASH,
      files: [{ filename: "src/late.ts", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\\n+late" }]
    })
  });
  assert.equal((await pending).ok, true);
  const after = await exported(h);
  assert.equal(after.events.length, 0);
  assert.equal(Object.keys(after.commits).length, 0,
    "cleared evidence must stay deleted after an already-started fetch finishes");
  assert.equal(after.clearGeneration, cleared.clearGeneration);
});

test("a navigation away ends approval and rejects further page events", async () => {
  const h = harness();
  await enable(h);
  h.navigate("https://example.com/");
  await tick();
  assert.equal((await h.send({ type: "workflowStage", stage: "testing" }, origin)).ok, false);
  assert.equal(h.sessions.size, 0);
});

function domHarness(h = null, html = '<article data-turn="assistant" data-turn-id="old">Earlier reply</article>') {
  const dom = new JSDOM('<main data-app-action-timeline-scroll role="region">' + html + '</main>');
  const sent = [];
  let command, poll, mutation, observerOptions;
  const location = { pathname: "/c/test-conversation" };
  vm.runInNewContext(content, {
    URL, document: dom.window.document, location,
    chrome: { runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (h) return h.send(message, origin);
        return message.type === "githubCommitReferences"
          ? { ok: true, accepted: message.links.map(() => true) } : { ok: true };
      },
      onMessage: { addListener(fn) { command = fn; }, removeListener() {} }
    } },
    MutationObserver: class {
      observe(_target, options) { observerOptions = options; }
      disconnect() {}
      constructor(fn) { mutation = fn; }
    },
    setInterval(fn) { poll = fn; return 1; }, clearInterval() {},
    setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {}, Date
  });
  const root = dom.window.document.querySelector('main');
  const flush = async () => { for (let i = 0; i < 35; i++) await tick(); };
  return { sent, root, location, flush, observerOptions: () => observerOptions,
    async enable() { command({ type: "gcrWorkflowMode", enabled: true }); await flush(); },
    async change(html) { root.insertAdjacentHTML('beforeend', html); mutation(); await flush(); },
    async mutate() { mutation(); await flush(); },
    async scan() { poll(); await flush(); }, command };
}
const userTurn = (id, text) => `<article data-turn="user" data-turn-id="${id}"><div data-message-author-role="user">${text}</div></article>`;
const assistantTurn = (id, text) => `<article data-turn="assistant" data-turn-id="${id}"><div data-message-author-role="assistant">${text}</div></article>`;

test("content observer reports only categories and local identities; historical references never fetch", async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h, userTurn('old-u', 'PRIVATE old request') + assistantTurn('old-a', `<a href="${COMMIT}">old</a>`));
  await d.enable();
  assert.equal(h.requests.length, 0);
  assert.equal((await exported(h)).analysis.unattributedCommits[0].state, 'historical');
  await d.change(userTurn('new-u', 'Inspect PRIVATE issue then implement and test'));
  await d.change(assistantTurn('new-a', `Done ${COMMIT.replace(HASH, "b".repeat(40))}`));
  const data = await exported(h);
  assert.equal(h.requests.length, 1);
  assert.equal(data.analysis.tasks.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences[0].attribution.state, 'automatic');
  assert.ok(!JSON.stringify(data).includes('PRIVATE'));
  assert.ok(!JSON.stringify(data).includes('new-u'));
});

test("GitHub capture works without message counts, with streamed text and rerendered nested wrappers", async () => {
  const h = harness(); await enable(h); const d = domHarness(h); await d.enable();
  assert.equal(d.sent.find(m => m.type === 'observerStatus').detector, 'waiting');
  await d.change(userTurn('u1', 'Debug then modify then test'));
  await d.change(assistantTurn('a1', 'Streaming...'));
  d.root.lastElementChild.querySelector('div').textContent = 'Finished ' + COMMIT;
  await d.scan();
  const before = await exported(h);
  d.root.innerHTML = d.root.innerHTML;
  await d.scan();
  const after = await exported(h);
  assert.equal(after.analysis.tasks.length, 1);
  assert.equal(after.analysis.tasks[0].taskId, before.analysis.tasks[0].taskId);
  assert.equal(after.events.filter(e => e.type === 'github_commit_ref').length, 1);
  assert.equal(h.requests.length, 1);
});

test("plain-text and delayed href capture excludes user links and stops on navigation", async () => {
  const d = domHarness(); await d.enable();
  await d.change(userTurn('u1', 'Implement ' + COMMIT));
  assert.equal(d.sent.filter(e => e.type === 'githubCommitReferences').length, 0);
  await d.change(assistantTurn('a1', '<a>Commit</a>'));
  d.root.querySelector('a').setAttribute('href', COMMIT);
  await d.scan();
  assert.equal(d.sent.filter(e => e.type === 'githubCommitReferences').length, 1);
  d.location.pathname = '/c/elsewhere';
  await d.change(assistantTurn('a2', COMMIT));
  assert.equal(d.sent.filter(e => e.type === 'githubCommitReferences').length, 1);
});

test("sidepanel manual commit fallback requires active workflow consent and strict GitHub URL", async () => {
  assert.ok(markup.includes('id="commit-url"'));
  assert.ok(markup.includes('id="import-commit"'));
  assert.ok(panel.includes('type: "importCommitUrl"'));
  const h = harness();
  const request = { type: "importCommitUrl", tabId: 9, url: COMMIT };
  assert.equal((await h.send(request)).ok, false);
  await h.send({ type: "start", tabId: 9 });
  for (const url of [
    "http://github.com/a/b/commit/" + HASH,
    "https://github.com.evil.invalid/a/b/commit/" + HASH,
    "https://github.com/a/b/commit/" + HASH + "?token=secret",
    "https://github.com/a/b/commit/short-sha"
  ]) assert.equal((await h.send({ ...request, url })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.send(request, origin)).ok, false, "page events cannot impersonate side panel");
  assert.equal((await h.send(request)).ok, true);
  const data = await exported(h);
  assert.equal(data.events.at(-1).type, "github_commit_ref");
  assert.equal(data.events.at(-1).discovery, "manual");
  assert.equal(data.commits["testerinopapa/gentle-control-room@" + HASH].status, "retrieved");
  assert.equal(h.requests.length, 1);
  assert.equal((await h.send(request)).duplicate, true);
  assert.equal(h.requests.length, 1);
});


test("binary-only GitHub commits export metadata without claiming a code diff", async () => {
  const h = harness(undefined, {
    sha: HASH,
    files: [
      { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
      { filename: ".env.production", status: "modified", additions: 1, deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new" }
    ]
  });
  await enable(h);
  const response = await h.send({
    type: "githubCommitReference", repository: "testerinopapa/gentle-control-room", sha: HASH
  }, origin);
  assert.equal(response.ok, true);
  const data = await exported(h);
  const record = data.commits["testerinopapa/gentle-control-room@" + HASH];
  assert.equal(record.status, "metadata_only");
  assert.equal(record.changedFiles, 2);
  assert.equal(record.files.length, 0);
  assert.match(record.note, /no safe textual patches/);
  assert.equal(data.events.at(-1).type, "github_commit_ref");
  assert.equal((await h.send({ type: "getState", tabId: 9 })).recordedCommits, 0);
});

test("JSON export groups stage/commit evidence into a session-scoped coding episode", async () => {
  const h = harness();
  await enable(h);
  await h.send({ type: "requestBoundary", requestId: "m-test-1", confidence: "supported" }, origin);
  await h.send({ type: "workflowStage", stage: "implementation", requestId: "m-test-1" }, origin);
  await h.send({ type: "assistantBoundary", responseId: "m-test-2", requestId: "m-test-1" }, origin);
  await h.send({ type: "githubCommitReference", responseId: "m-test-2",
    repository: "testerinopapa/gentle-control-room", sha: HASH }, origin);
  await h.send({ type: "workflowStage", stage: "testing", requestId: "m-test-1" }, origin);
  const exportedData = await exported(h);
  assert.equal(exportedData.analysis.version, 2);
  assert.equal(exportedData.analysis.method, "deterministic_local_evidence_rules");
  const tasks = exportedData.analysis.tasks;
  assert.equal(tasks.length, 1);
  assert.deepEqual(Array.from(tasks[0].stages), ["implementation", "testing"]);
  assert.equal(tasks[0].commitReferences.length, 1);
  assert.equal(tasks[0].commitReferences[0].retrieval, "retrieved");
  assert.equal(tasks[0].commitReferences[0].filesWithCapturedPatches[0].path, "src/feature.ts");
  assert.equal(tasks[0].evidence.retrievedCommitPatches, 1);
  assert.equal(tasks[0].evidence.reportedLineChanges.additions, 2);
  assert.equal(tasks[0].evidence.reportedLineChanges.deletions, 1);
  assert.equal(tasks[0].evidence.reportedLineChanges.total, 3);
  assert.equal(tasks[0].evidence.reportedLineChanges.scope,
    "github_file_counts_for_retained_text_patches");
  assert.equal(tasks[0].evidence.testExecution, "not_verified");
  assert.equal(tasks[0].evidence.testsPassed, "unknown");
  assert.equal(exportedData.analysis.patterns.length, 0,
    "one coding episode must never imply a recurring habit");
  assert.equal(exportedData.analysis.coverage.inferredCodingEpisodes, 1);
});

test("recurrence requires distinct coding episodes with supporting evidence", () => {
  const h = harness();
  const shaA = HASH;
  const shaB = "a".repeat(40);
  const sessionA = "123e4567-e89b-42d3-a456-426614174000";
  const sessionB = "123e4567-e89b-42d3-a456-426614174001";
  const t = (date, sessionId, type, fields = {}) => ({
    timestamp: date, sessionId, type, ...fields
  });
  const events = [
    t("2026-11-01T10:00:00Z", sessionA, "session_started"),
    t("2026-11-01T10:01:00Z", sessionA, "workflow_stage", { stage: "debugging" }),
    t("2026-11-01T10:02:00Z", sessionA, "workflow_stage", { stage: "implementation" }),
    t("2026-11-01T10:03:00Z", sessionA, "github_commit_ref", {
      repository: "testerinopapa/gentle-control-room", commitSha: shaA, discovery: "assistant" }),
    t("2026-11-01T10:04:00Z", sessionA, "workflow_stage", { stage: "testing" }),
    t("2026-11-02T10:00:00Z", sessionB, "workflow_stage", { stage: "debugging" }),
    t("2026-11-02T10:01:00Z", sessionB, "workflow_stage", { stage: "implementation" }),
    t("2026-11-02T10:02:00Z", sessionB, "github_commit_ref", {
      repository: "testerinopapa/gentle-control-room", commitSha: shaB, discovery: "assistant" }),
    t("2026-11-02T10:03:00Z", sessionB, "workflow_stage", { stage: "testing" })
  ];
  const commits = {
    ["testerinopapa/gentle-control-room@" + shaA]: {
      repository: "testerinopapa/gentle-control-room", sha: shaA, status: "retrieved",
      changedFiles: 1, files: [{ path: "src/shared.ts", additions: 1, deletions: 0,
        patch: "@@ -0,0 +1 @@\n+first" }]
    },
    ["testerinopapa/gentle-control-room@" + shaB]: {
      repository: "testerinopapa/gentle-control-room", sha: shaB, status: "retrieved",
      changedFiles: 1, files: [{ path: "src/shared.ts", additions: 1, deletions: 0,
        patch: "@@ -0,0 +1 @@\n+second" }]
    }
  };
  for (const event of events) {
    event.taskId = event.sessionId + ":request";
    if (event.type === "github_commit_ref") event.attribution = { state: "automatic" };
  }
  for (const sessionId of new Set(events.map(e => e.sessionId)))
    events.unshift({ timestamp: events.find(e => e.sessionId === sessionId).timestamp, sessionId,
      type: "request_boundary", requestId: "m-test-1", taskId: sessionId + ":request", confidence: "supported" });
  const analysis = h.analyze({ events, commits });
  assert.equal(analysis.coverage.inferredCodingEpisodes, 2);
  assert.equal(analysis.patterns.find(p => p.id === "transition:debugging->implementation").distinctTasks, 2);
  assert.equal(analysis.patterns.find(p => p.id === "transition:implementation->testing").distinctTasks, 2);
  const file = analysis.patterns.find(p =>
    p.id === "file:testerinopapa/gentle-control-room/src/shared.ts");
  assert.equal(file.distinctTasks, 2);
  assert.equal(file.supportingCommitRefs.length, 2);
  assert.ok(file.supportingTaskIds.every(x => typeof x === "string"));
  assert.ok(analysis.tasks.every(x => x.evidence.testsPassed === "unknown"));
  assert.ok(!JSON.stringify(analysis).includes("+second"),
    "analysis should link to patches rather than duplicating their source content");
});

test("line-change totals exclude files without saved patches and duplicate references", () => {
  const h = harness();
  const sessionId = "session-line-totals";
  const sha = HASH;
  const events = [
    { timestamp: "2026-11-02T11:00:00Z", sessionId, type: "github_commit_ref",
      repository: "testerinopapa/gentle-control-room", commitSha: sha },
    { timestamp: "2026-11-02T11:02:00Z", sessionId, type: "github_commit_ref",
      repository: "testerinopapa/gentle-control-room", commitSha: sha }
  ];
  const commits = { ["testerinopapa/gentle-control-room@" + sha]: {
    repository: "testerinopapa/gentle-control-room", sha, status: "retrieved",
    changedFiles: 3,
    files: [
      { path: "src/a.ts", additions: 5, deletions: 2, patch: "@@ -1 +1 @@\\n-old\\n+new" },
      { path: "src/b.ts", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\\n-before\\n+after" },
      { path: "src/excluded.ts", additions: 100, deletions: 50 }
    ]
  } };
  for (const event of events) {
    event.taskId = event.sessionId + ":request";
    if (event.type === "github_commit_ref") event.attribution = { state: "automatic" };
  }
  for (const sessionId of new Set(events.map(e => e.sessionId)))
    events.unshift({ timestamp: events.find(e => e.sessionId === sessionId).timestamp, sessionId,
      type: "request_boundary", requestId: "m-test-1", taskId: sessionId + ":request", confidence: "supported" });
  const analysis = h.analyze({ events, commits });
  assert.equal(analysis.tasks.length, 1);
  const task = analysis.tasks[0];
  assert.equal(task.commitReferences.length, 1);
  assert.equal(task.evidence.capturedChangedFiles, 2);
  assert.equal(task.evidence.reportedLineChanges.additions, 8);
  assert.equal(task.evidence.reportedLineChanges.deletions, 3);
  assert.equal(task.evidence.reportedLineChanges.total, 11);
  assert.match(task.evidence.reportedLineChanges.note, /not work effort/);
  assert.equal(analysis.patterns.length, 0);
});

test("one commit referenced twice is not evidence of recurring file edits", () => {
  const h = harness();
  const events = [
    { timestamp: "2026-11-01T10:00:00Z", sessionId: "session-a", type: "github_commit_ref",
      repository: "testerinopapa/gentle-control-room", commitSha: HASH },
    { timestamp: "2026-11-01T11:00:00Z", sessionId: "session-b", type: "github_commit_ref",
      repository: "testerinopapa/gentle-control-room", commitSha: HASH }
  ];
  const commits = { ["testerinopapa/gentle-control-room@" + HASH]: {
    repository: "testerinopapa/gentle-control-room", sha: HASH, status: "retrieved",
    files: [{ path: "src/once.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]
  } };
  const result = h.analyze({ events, commits });
  assert.equal(result.tasks.length, 0);
  assert.equal(result.unattributedCommits.length, 2);
  assert.equal(result.patterns.some(p => p.type === "same_file_in_distinct_commits"), false);
});

test("separates long gaps and ignores count-only sessions and unrecognized stages", () => {
  const h = harness();
  const session = "session-long";
  const events = [
    { timestamp: "2026-11-01T08:00:00Z", sessionId: "session-counts",
      type: "session_started" },
    { timestamp: "2026-11-01T08:05:00Z", sessionId: "session-counts",
      type: "visible_counts", visibleUser: 3, visibleAssistant: 2 },
    { timestamp: "2026-11-01T08:10:00Z", sessionId: session,
      type: "workflow_stage", stage: "implementation" },
    { timestamp: "2026-11-01T08:20:00Z", sessionId: session,
      type: "workflow_stage", stage: "invented_action" },
    { timestamp: "2026-11-01T10:00:00Z", sessionId: session,
      type: "workflow_stage", stage: "testing" }
  ];
  const result = h.analyze({ events, commits: {} });
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].sessionId, session);
  assert.equal(result.tasks[0].eventIndices.length, 1);
  assert.equal(result.patterns.length, 0);
  assert.ok(result.limitations.some(x => x.includes("heuristic time segments")));
});

test('multiple requests and commits reconstruct deterministically after JSON export', async () => {
  const h = harness(); await enable(h); const d = domHarness(h); await d.enable();
  await d.change(userTurn('u1', 'Investigate then implement then test'));
  await d.change(assistantTurn('a1', COMMIT + ' https://github.com/testerinopapa/gentle-control-room/commit/' + 'b'.repeat(40)));
  await d.change(userTurn('u2', 'Investigate then implement then test another feature'));
  await d.change(assistantTurn('a2', 'https://github.com/testerinopapa/gentle-control-room/commit/' + 'c'.repeat(40)));
  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 2);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(data.analysis.tasks[1].commitReferences.length, 1);
  assert.equal(data.analysis.patterns.find(p => p.id === 'sequence:investigation->implementation->testing').distinctTasks, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.analyze(JSON.parse(JSON.stringify(data))))), JSON.parse(JSON.stringify(data.analysis)));
});

test('manual imports stay unattributed until explicit task selection, including later association', async () => {
  const h = harness(); await enable(h);
  await h.send({ type: 'requestBoundary', requestId: 'm-test-1', confidence: 'supported' }, origin);
  await h.send({ type: 'importCommitUrl', tabId: 9, url: COMMIT });
  let data = await exported(h);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 0);
  assert.equal(data.analysis.unattributedCommits[0].state, 'unattributed');
  const taskId = data.analysis.tasks[0].taskId;
  assert.equal((await h.send({ type: 'importCommitUrl', tabId: 9, url: COMMIT, taskId: 'invented' })).ok, false);
  assert.equal((await h.send({ type: 'importCommitUrl', tabId: 9, url: COMMIT, taskId })).ok, true);
  data = await exported(h);
  assert.equal(data.analysis.tasks[0].commitReferences[0].attribution.state, 'manual');
  assert.equal(data.analysis.unattributedCommits[0].resolved, true);
  assert.equal(h.requests.length, 1);
});

test('same commit in separate sessions shares cached patch and does not imply repeated edits', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    await enable(h);
    await h.send({ type: 'requestBoundary', requestId: 'm-test-1', confidence: 'supported' }, origin);
    await h.send({ type: 'assistantBoundary', responseId: 'm-test-2', requestId: 'm-test-1' }, origin);
    await h.send({ type: 'githubCommitReference', responseId: 'm-test-2', repository: 'testerinopapa/gentle-control-room', sha: HASH }, origin);
    await h.send({ type: 'stop', tabId: 9 });
  }
  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 2);
  assert.equal(Object.keys(data.commits).length, 1);
  assert.equal(h.requests.length, 1);
  assert.ok(!data.analysis.patterns.some(p => p.type === 'same_file_in_distinct_commits'));
});

test('delayed history, prepended history, and missing stable identities remain uncertain', async () => {
  const h = harness(); await enable(h); const d = domHarness(h, ''); await d.enable();
  await d.change(userTurn('delayed-u', 'Implement historical request') + assistantTurn('delayed-a', COMMIT));
  let data = await exported(h);
  assert.equal(data.analysis.tasks[0].attribution.confidence, 'uncertain');
  assert.equal(data.analysis.tasks[0].commitReferences.length, 0);
  d.root.insertAdjacentHTML('afterbegin', userTurn('older-u', 'Fix older bug'));
  await d.scan();
  await d.change('<div data-role="user">Implement missing stable id</div><div data-role="assistant">' + COMMIT + '</div>');
  data = await exported(h);
  const count = data.analysis.tasks.length;
  d.root.innerHTML = d.root.innerHTML;
  await d.scan();
  data = await exported(h);
  assert.equal(data.analysis.tasks.length, count);
  assert.ok(data.analysis.tasks.every(t => t.attribution.confidence === 'uncertain'));
});

test('consent off and on cannot revive an earlier pending fetch', async () => {
  let release;
  const h = harness(undefined, null, () => new Promise(resolve => { release = resolve; }));
  await enable(h);
  const pending = h.send({ type: 'importCommitUrl', tabId: 9, url: COMMIT });
  for (let i = 0; i < 30 && !release; i++) await tick();
  await h.send({ type: 'setWorkflowAnalysis', tabId: 9, enabled: false });
  await h.send({ type: 'setWorkflowAnalysis', tabId: 9, enabled: true });
  release({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ sha: HASH, files: [] }) });
  await pending;
  assert.equal(Object.keys((await exported(h)).commits).length, 0);
});

test('concurrent duplicate deliveries produce one reference and one API fetch', async () => {
  const h = harness(); await enable(h);
  await Promise.all(Array.from({ length: 5 }, () => h.send({ type: 'importCommitUrl', tabId: 9, url: COMMIT })));
  const data = await exported(h);
  assert.equal(data.events.filter(e => e.type === 'github_commit_ref').length, 1);
  assert.equal(h.requests.length, 1);
});

test('return to debugging is an observed request sequence across separate tasks', async () => {
  const h = harness(); await enable(h); const d = domHarness(h); await d.enable();
  for (let i = 1; i <= 2; i++) {
    await d.change(userTurn('loop-' + i, 'Debug, implement, test, then debug again'));
    await d.change(assistantTurn('reply-' + i, 'Response'));
  }
  const data = await exported(h);
  assert.deepEqual(Array.from(data.analysis.tasks[0].stages), ['debugging', 'implementation', 'testing', 'debugging']);
  const pattern = data.analysis.patterns.find(p => p.id === 'sequence:implementation->testing->debugging');
  assert.equal(pattern.distinctTasks, 2);
  assert.equal(pattern.verifiedOutcome, false);
});

test('historical references do not consume the new-commit capture quota', async () => {
  const h = harness(); await enable(h);
  const old = Array.from({ length: 30 }, (_, i) => assistantTurn('old-' + i,
    'https://github.com/example/repo/commit/' + i.toString(16).padStart(40, '0'))).join('');
  const d = domHarness(h, old); await d.enable();
  await d.change(userTurn('new-task', 'Implement a feature'));
  await d.change(assistantTurn('new-response', COMMIT));
  assert.equal(h.requests.length, 1);
  const data = await exported(h);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 1);
});

test('supporting event indices are recomputed after retained chronology changes', async () => {
  const h = harness(); await enable(h);
  await h.send({ type: 'requestBoundary', requestId: 'm-test-1', confidence: 'supported' }, origin);
  await h.send({ type: 'assistantBoundary', requestId: 'm-test-1', responseId: 'm-test-2' }, origin);
  await h.send({ type: 'githubCommitReference', repository: 'testerinopapa/gentle-control-room', sha: HASH, responseId: 'm-test-2' }, origin);
  const data = JSON.parse(JSON.stringify(await exported(h)));
  data.events.shift();
  const analysis = h.analyze(data);
  const ref = analysis.tasks[0].commitReferences[0];
  const expectedIndices = data.events.flatMap((event, index) =>
    ["request_boundary", "assistant_response"].includes(event.type) ? [index] : []);
  assert.deepEqual(Array.from(ref.attribution.evidenceEventIndices), expectedIndices,
    "indices must match the current exported chronology, including automatic coding metadata");
  assert.equal(analysis.tasks[0].taskId, data.analysis.tasks[0].taskId);
});


test('historical links survive rerender while new links in old responses remain unattributed', async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h, assistantTurn('historical', COMMIT)); await d.enable();
  d.root.innerHTML = d.root.innerHTML;
  await d.scan();
  d.root.lastElementChild.querySelector('div').textContent += ' https://github.com/example/repo/commit/' + 'b'.repeat(40);
  await d.scan();
  const data = await exported(h);
  assert.equal(h.requests.length, 1);
  assert.equal(data.analysis.tasks.length, 0);
  assert.equal(data.events.filter(e => e.type === 'github_commit_ref').length, 2);
  assert.deepEqual(Array.from(data.analysis.unattributedCommits, ref => ref.state), ['historical', 'unattributed']);
});


test('a previously visible commit repeated in a new response cannot become automatic task evidence', async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h, assistantTurn('old', COMMIT)); await d.enable();
  await d.change(userTurn('new', 'Implement a different feature'));
  await d.change(assistantTurn('new-reply', COMMIT));
  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 0);
  assert.ok(data.analysis.unattributedCommits.every(ref => ref.state === 'historical'));
  assert.equal(h.requests.length, 0);
});


test("analysis export diagnoses automatic versus manual capture and patch availability", () => {
  const h = harness();
  const repo = "testerinopapa/gentle-control-room";
  const alternate = ["a", "b", "c", "d"].map(x => x.repeat(40));
  const now = "2026-11-02T15:00:00Z";
  const commit = (sha, discovery, state) => ({
    sessionId: "session-diagnostics",
    timestamp: now, type: "github_commit_ref",
    repository: repo, commitSha: sha, discovery, attribution: { state }
  });
  const events = [
    commit(HASH, "assistant", "automatic"),
    commit(HASH, "manual", "unattributed"),
    commit(alternate[0], "assistant", "historical"),
    commit(alternate[1], "manual", "unattributed"),
    commit(alternate[2], "assistant", "automatic"),
    commit(alternate[3], "assistant", "unattributed")
  ];
  const commits = {
    [repo + "@" + HASH]: {
      status: "retrieved",
      files: [{ path: "src/test.ts", patch: "@@ -1 +1 @@\\n-old\\n+new" }]
    },
    [repo + "@" + alternate[1]]: { status: "metadata_only", files: [] },
    [repo + "@" + alternate[2]]: { status: "unavailable", files: [] }
  };
  const data = h.analyze({ events, commits });
  const diagnostic = data.captureDiagnostics;
  assert.equal(data.version, 2);
  assert.equal(diagnostic.observedReferenceEvents, 6);
  assert.equal(diagnostic.distinctNonhistoricalReferencedCommits, 4);
  assert.equal(diagnostic.distinctHistoricalReferencedCommits, 1);
  assert.equal(diagnostic.discovery.assistant, 4);
  assert.equal(diagnostic.discovery.manual, 2);
  assert.equal(diagnostic.attribution.automatic, 2);
  assert.equal(diagnostic.attribution.unattributed, 3);
  assert.equal(diagnostic.attribution.historical, 1);
  assert.equal(diagnostic.retrieval.withTextPatches, 1);
  assert.equal(diagnostic.retrieval.metadataOnly, 1);
  assert.equal(diagnostic.retrieval.unavailable, 1);
  assert.equal(diagnostic.retrieval.notCached, 1);
  assert.ok(!JSON.stringify(diagnostic).includes("src/test.ts"),
    "diagnostics must not duplicate code or paths");
});


test("capture diagnostics reject mismatched cached commit identities", () => {
  const h = harness();
  const repository = "testerinopapa/gentle-control-room";
  const alternate = ["a", "b", "c"].map(letter => letter.repeat(40));
  const event = sha => ({
    type: "github_commit_ref", sessionId: "session-cache-identity",
    timestamp: "2026-11-02T20:00:00Z",
    repository, commitSha: sha, discovery: "assistant",
    attribution: { state: "automatic" }
  });
  const data = h.analyze({
    events: [event(HASH), ...alternate.map(event)],
    commits: {
      [repository + "@" + HASH]: {
        repository, sha: alternate[0], status: "retrieved",
        files: [{ path: "src/wrong.ts", patch: "@@ -1 +1 @@\\n-a\\n+b" }]
      },
      [repository + "@" + alternate[0]]: {
        repository: "different/repository", sha: alternate[0], status: "retrieved",
        files: [{ path: "src/mismatch.ts", patch: "@@ -1 +1 @@\\n-x\\n+y" }]
      },
      [repository + "@" + alternate[1]]: {
        repository, sha: alternate[1], status: "queued", files: []
      },
      [repository + "@" + alternate[2]]: {
        repository, sha: alternate[2], status: "retrieved",
        files: [{ path: "src/correct.ts", patch: "@@ -1 +1 @@\\n-a\\n+b" }]
      }
    }
  });
  const d = data.captureDiagnostics;
  assert.equal(d.distinctNonhistoricalReferencedCommits, 4);
  assert.equal(d.retrieval.identityMismatch, 2);
  assert.equal(d.retrieval.unknownStatus, 1);
  assert.equal(d.retrieval.withTextPatches, 1);
  assert.equal(d.retrieval.metadataOnly, 0);
  assert.equal(d.retrieval.unavailable, 0);
  assert.equal(d.retrieval.notCached, 0);
  assert.ok(!JSON.stringify(d).includes("src/wrong.ts"),
    "diagnostics should never copy filenames or patch content");
});


test("capture diagnostics distinguish passive-only recordings from observed coding workflows", () => {
  const h = harness();
  const at = "2026-11-02T23:00:00Z";
  const passive = "passive-session", coded = "coded-session";
  const ev = (sessionId, type, rest = {}) => ({
    sessionId, type, timestamp: at, ...rest
  });
  const result = h.analyze({
    events: [
      ev(passive, "session_started"),
      ev(passive, "coding_tag", { codingMarked: true, method: "automatic_on_start" }),
      ev(passive, "visible_counts", { visibleUser: 4, visibleAssistant: 5 }),
      ev(coded, "session_started"),
      ev(coded, "coding_tag", { codingMarked: true, method: "automatic_on_start" }),
      ev(coded, "request_boundary", {
        taskId: coded + ":m-test-1", requestId: "m-test-1", confidence: "supported"
      }),
      ev(coded, "workflow_stage", {
        stage: "implementation", taskId: coded + ":m-test-1", requestId: "m-test-1"
      }),
      ev(coded, "assistant_response", {
        taskId: coded + ":m-test-1", responseId: "m-test-2"
      }),
      ev(coded, "workflow_stage", { stage: "made_up_stage" })
    ],
    commits: {}
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.captureDiagnostics.workflow)), {
    sessionsStarted: 2,
    sessionsWithRequestBoundaries: 1,
    sessionsWithoutWorkflowEvidence: 1,
    requestBoundaries: 1,
    assistantResponses: 1,
    workflowStageEvents: 1,
    visibleCountUpdates: 1,
    automaticCodingTags: 2
  });
  assert.equal(result.tasks.length, 1,
    "automatic session tags and visible counts do not create phantom coding tasks");
  assert.equal(result.tasks[0].taskId, coded + ":m-test-1");
});

test("export exposes passive-only workflow diagnostics after one-click Start", async () => {
  const h = harness();
  await enable(h);
  await h.send({
    type: "visibleCounts", user: 2, assistant: 3, codeBlocks: 1
  }, origin);
  const first = await exported(h);
  const workflow = first.analysis.captureDiagnostics.workflow;
  assert.equal(workflow.sessionsStarted, 1);
  assert.equal(workflow.sessionsWithoutWorkflowEvidence, 1);
  assert.equal(workflow.requestBoundaries, 0);
  assert.equal(workflow.automaticCodingTags, 1);
  assert.equal(first.analysis.tasks.length, 0);

  await h.send({
    type: "requestBoundary", requestId: "m-test-1", confidence: "supported"
  }, origin);
  const second = await exported(h);
  assert.equal(second.analysis.captureDiagnostics.workflow.sessionsWithoutWorkflowEvidence, 0);
  assert.equal(second.analysis.captureDiagnostics.workflow.sessionsWithRequestBoundaries, 1);
  assert.equal(second.analysis.tasks.length, 1);
});


test("one-click recording captures a new assistant commit and exports attributable patch evidence", async () => {
  const h = harness();
  await enable(h);
  const d = domHarness(h, assistantTurn("before-opt-in", "Historical assistant response"));
  await d.enable();

  await d.change(userTurn("observed-request", "Implement a small regression fix"));
  await d.change(assistantTurn("observed-reply",
    '<a href="' + COMMIT + '">View the finished commit</a>'));
  const data = await exported(h);
  const diagnostic = data.analysis.captureDiagnostics;

  assert.equal(h.requests.length, 1, "one public GitHub commit should be fetched");
  assert.equal(data.analysis.tasks.length, 1, "start tag should not create a phantom task");
  assert.equal(data.analysis.tasks[0].commitReferences.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences[0].attribution.state, "automatic");
  assert.equal(diagnostic.discovery.assistant, 1);
  assert.equal(diagnostic.discovery.manual, 0);
  assert.equal(diagnostic.retrieval.withTextPatches, 1);
  assert.equal(diagnostic.workflow.sessionsStarted, 1);
  assert.equal(diagnostic.workflow.sessionsWithRequestBoundaries, 1);
  assert.equal(diagnostic.workflow.sessionsWithoutWorkflowEvidence, 0);
  assert.equal(diagnostic.workflow.requestBoundaries, 1);
  assert.equal(diagnostic.workflow.automaticCodingTags, 1);

  const replayed = h.analyze(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(data.analysis)),
    "export must be deterministically reanalyzable without prompt text");
});


test("complete assistant response inspection finds commits beyond 12k and 30 other links", async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("long-u", "Implement the requested change"));
  const otherLinks = Array.from({ length: 45 }, (_, i) =>
    '<a href="https://example.com/reference/' + i + '">Reference</a>').join("");
  const longText = "irrelevant visible text ".repeat(1100);
  await d.change(assistantTurn("long-a",
    '<div data-message-author-role="assistant"><p>' + longText + '</p>' +
      otherLinks + '<pre>const secretValue = "never export me";</pre></div>' +
      '<div class="assistant-footer"><a href="' + COMMIT + '">See commit</a></div>'));

  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences[0].sha, HASH);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedResponses, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCodeBlocks, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 1);
  assert.ok(data.analysis.tasks[0].responseMetadata.maxObservedResponseCharacters > 12000);
  assert.equal(data.analysis.captureDiagnostics.discovery.assistant, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(data.commits["testerinopapa/gentle-control-room@" + HASH].status, "retrieved");
  assert.ok(!JSON.stringify(data).includes("never export me"),
    "raw assistant text/code must not be sent to persistent storage");
  assert.ok(!JSON.stringify(data).includes("irrelevant visible text"),
    "only structured metadata and filtered GitHub patches are exported");
});

test("plain-text commit at very end of large reply is captured without an anchor", async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("plain-u", "Implement an update"));
  await d.change(assistantTurn("plain-a",
    "Large assistant response ".repeat(1500) + " Final commit: " + COMMIT));
  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 1);
  assert.equal(h.requests.length, 1);
});

test("assistant response metadata is updated during streaming and rejects historical or raw payloads", async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h, assistantTurn("old-a", '<pre>Historical code</pre>'));
  await d.enable();
  await d.change(userTurn("new-u", "Implement an update"));
  await d.change(assistantTurn("new-a", '<pre>const safe = true;</pre>'));
  let data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "assistant_evidence").length, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCodeBlocks, 1);
  const responseId = data.analysis.tasks[0].responseIds[0];
  assert.equal((await h.send({ type: "assistantEvidence", responseId,
    observedCharacters: 100, observedCodeBlocks: 2,
    observedCommitLinks: 1, rawText: "LEAK PRIVATE CHAT" }, origin)).ok, true);
  data = await exported(h);
  const records = data.events.filter(e => e.type === "assistant_evidence");
  assert.equal(records.length, 1, "one snapshot per assistant turn, not one event per token");
  assert.equal(records[0].observedCodeBlocks, 2);
  assert.equal(records[0].observedCommitLinks, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCodeBlocks, 2);
  assert.ok(!JSON.stringify(data).includes("LEAK PRIVATE CHAT"));
  assert.equal((await h.send({ type: "assistantEvidence", responseId,
    observedCharacters: -1, observedCodeBlocks: 0, observedCommitLinks: 0 }, origin)).ok, false);
  assert.equal((await h.send({ type: "assistantEvidence", responseId: "m-invalid!",
    observedCharacters: 1, observedCodeBlocks: 0, observedCommitLinks: 0 }, origin)).ok, false);
  await h.send({ type: "stop", tabId: 9 });
  assert.equal((await h.send({ type: "assistantEvidence", responseId,
    observedCharacters: 100, observedCodeBlocks: 0, observedCommitLinks: 0 }, origin)).ok, false);
});


test("complete assistant response yields safe stage mentions and command families without commands", async () => {
  const h = harness(); await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("commands-u", "Please implement this change"));
  await d.change(assistantTurn("commands-a",
    "<p>I tested the bug fix; commands mentioned below are not verified executions.</p>" +
    "<pre>git status\nnpm test\nSECRET_TOKEN=keep-private</pre>"));
  const data = await exported(h);
  assert.equal(data.analysis.tasks.length, 1);
  const evidence = data.analysis.tasks[0].responseMetadata;
  assert.deepEqual(Array.from(evidence.commandFamilies), ["git", "npm"]);
  assert.ok(evidence.mentionedStages.includes("testing"));
  assert.ok(evidence.mentionedStages.includes("version_control"));
  assert.equal(evidence.scope, "rendered_assistant_metadata_not_execution_proof");
  assert.ok(!JSON.stringify(data).includes("SECRET_TOKEN"));
  assert.ok(!JSON.stringify(data).includes("git status"));
  assert.ok(!JSON.stringify(data).includes("npm test"));
  const responseId = data.analysis.tasks[0].responseIds[0];
  assert.equal((await h.send({ type: "assistantEvidence", responseId,
    observedCharacters: 25, observedCodeBlocks: 1, observedCommitLinks: 0,
    commandFamilies: ["curl https://private.example/path"], mentionedStages: [] }, origin)).ok, false);
  assert.equal((await h.send({ type: "assistantEvidence", responseId,
    observedCharacters: 25, observedCodeBlocks: 1, observedCommitLinks: 0,
    commandFamilies: [], mentionedStages: ["unverified_execution"] }, origin)).ok, false);
});


test("link delivery diagnostics distinguish detected links from accepted commit evidence", async () => {
  const h = harness();
  await enable(h);
  await h.send({ type: "requestBoundary", requestId: "m-test-1", confidence: "supported" }, origin);
  await h.send({ type: "assistantBoundary", responseId: "m-test-2", requestId: "m-test-1" }, origin);
  const snapshot = { type: "assistantEvidence", responseId: "m-test-2",
    observedCharacters: 16500, observedCodeBlocks: 1, observedCommitLinks: 1 };
  assert.equal((await h.send(snapshot, origin)).ok, true);
  let data = await exported(h);
  assert.deepEqual(JSON.parse(JSON.stringify(data.analysis.captureDiagnostics.linkDelivery)), {
    inspectedAssistantResponses: 1,
    responsesWithDetectedCommitLinks: 1,
    detectedCommitLinks: 1,
    responsesWithAcceptedCommitReferences: 0,
    responsesWithMissingCommitReferences: 1,
    responsesWithPartialCommitReferences: 0
  });
  assert.equal((await h.send({
    type: "githubCommitReference", responseId: "m-test-2",
    repository: "Testerinopapa/gentle-control-room", sha: HASH
  }, origin)).ok, true);
  data = await exported(h);
  const delivery = data.analysis.captureDiagnostics.linkDelivery;
  assert.equal(delivery.responsesWithDetectedCommitLinks, 1);
  assert.equal(delivery.responsesWithAcceptedCommitReferences, 1);
  assert.equal(delivery.responsesWithMissingCommitReferences, 0);
  assert.equal(delivery.responsesWithPartialCommitReferences, 0);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 1);
});

test("link delivery counts are deduplicated per response and expose partial delivery", () => {
  const h = harness();
  const sha2 = "a".repeat(40);
  const sessionId = "session-link-delivery";
  const observed = (responseId, count) => ({
    type: "assistant_evidence", sessionId, responseId,
    observedCommitLinks: count, observedCharacters: 20000
  });
  const accepted = (responseId, sha) => ({
    type: "github_commit_ref", sessionId, repository: "testerinopapa/gentle-control-room",
    commitSha: sha, discovery: "assistant",
    attribution: { state: "automatic", responseId }
  });
  const data = h.analyze({ events: [
    observed("m-test-1", 1), accepted("m-test-1", HASH),
    observed("m-test-2", 1), observed("m-test-2", 2),
    accepted("m-test-2", sha2),
    observed("m-test-3", 1),
    observed("m-test-4", 0)
  ], commits: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(data.captureDiagnostics.linkDelivery)), {
    inspectedAssistantResponses: 4,
    responsesWithDetectedCommitLinks: 3,
    detectedCommitLinks: 4,
    responsesWithAcceptedCommitReferences: 2,
    responsesWithMissingCommitReferences: 1,
    responsesWithPartialCommitReferences: 1
  });
  assert.ok(!JSON.stringify(data.captureDiagnostics.linkDelivery).includes("m-test-"),
    "diagnostics must not contain response identifiers or source text");
});


test("a rendered reply with two distinct commit links captures both automatically", async () => {
  const second = "a".repeat(40);
  const repository = "testerinopapa/gentle-control-room";
  const url2 = "https://github.com/" + repository + "/commit/" + second;
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/change.js", status: "modified", additions: 1,
        deletions: 0, patch: "@@ -0,0 +1 @@\n+change" }]
    })
  }));
  await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("batch-u", "Implement the two changes"));
  await d.change(assistantTurn("batch-a",
    '<a href="' + COMMIT + '">First commit</a>' +
    '<a data-url="' + url2 + '">Second commit</a> ' + url2));
  const exportedData = await exported(h);
  const references = exportedData.events.filter(e => e.type === "github_commit_ref");
  assert.equal(references.length, 2);
  assert.deepEqual(Array.from(references, e => e.commitSha).sort(), [HASH, second].sort());
  assert.ok(references.every(e => e.attribution.state === "automatic"));
  assert.equal(exportedData.analysis.tasks.length, 1);
  assert.equal(exportedData.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(exportedData.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  assert.equal(exportedData.analysis.captureDiagnostics.linkDelivery.responsesWithPartialCommitReferences, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(exportedData.analysis.captureDiagnostics.retrieval.withTextPatches, 2);
  await d.scan();
  assert.equal((await exported(h)).events.filter(e => e.type === "github_commit_ref").length, 2,
    "rerender and repeated scans must not create duplicate references");
});

test("a second commit streamed into an earlier reply is still captured and counted", async () => {
  const second = "b".repeat(40);
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/stream.ts", status: "modified", additions: 1,
        deletions: 0, patch: "@@ -0,0 +1 @@\n+stream" }]
    })
  }));
  await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("stream-u", "Implement, then add regression tests"));
  await d.change(assistantTurn("stream-a", '<a href="' + COMMIT + '">First</a>'));
  d.root.lastElementChild.querySelector('div').insertAdjacentHTML("beforeend",
    '<a href="https://github.com/testerinopapa/gentle-control-room/commit/' + second + '">Second</a>');
  await d.scan();
  let data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 2);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  // Removing a streamed link must not erase that it was already observed.
  d.root.lastElementChild.querySelector('a').remove();
  await d.scan();
  data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 2);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  assert.equal(data.analysis.captureDiagnostics.linkDelivery.detectedCommitLinks, 2);
});

test("batch capture accepts remaining links when one reference is rejected", async () => {
  const second = "c".repeat(40);
  const h = harness();
  await enable(h);
  await h.send({ type: "requestBoundary", requestId: "m-test-1", confidence: "supported" }, origin);
  await h.send({ type: "assistantBoundary", responseId: "m-test-2", requestId: "m-test-1" }, origin);
  const result = await h.send({ type: "githubCommitReferences", responseId: "m-test-2",
    links: [
      { repository: "evil/invalid/path", sha: HASH, historical: false },
      { repository: "Testerinopapa/gentle-control-room", sha: HASH, historical: false },
      { repository: "Testerinopapa/gentle-control-room", sha: second, historical: false }
    ]
  }, origin);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.accepted), [false, true, true]);
  const data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 2);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(h.requests.length, 2);
});


test("one temporarily rejected commit retries without losing the other link", async () => {
  const second = "d".repeat(40);
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/retry.js", status: "modified", additions: 1,
        deletions: 0, patch: "@@ -0,0 +1 @@\\n+retry" }]
    })
  }));
  await enable(h);
  let firstBatch = true;
  const proxy = { send: async (message, sender) => {
    if (message.type === "githubCommitReferences" && firstBatch) {
      firstBatch = false;
      const accepted = await h.send({ ...message, links: [message.links[1]] }, sender);
      return { ok: true, accepted: [false, accepted.accepted[0]] };
    }
    return h.send(message, sender);
  } };
  const d = domHarness(proxy);
  await d.enable();
  await d.change(userTurn("retry-u", "Implement two updates"));
  await d.change(assistantTurn("retry-a", '<a href="' + COMMIT + '">First</a>' +
    '<a href="https://github.com/testerinopapa/gentle-control-room/commit/' + second + '">Second</a>'));
  let data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  await d.scan();
  data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 2);
  assert.equal(data.analysis.captureDiagnostics.linkDelivery.responsesWithMissingCommitReferences, 0);
  assert.equal(data.analysis.captureDiagnostics.linkDelivery.responsesWithPartialCommitReferences, 0);
  assert.equal(h.requests.length, 2);
});


test("missed first commit retries after its link disappears during streaming", async () => {
  const second = "e".repeat(40);
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/disappearing-link.ts", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\\n+streamed" }]
    })
  }));
  await enable(h);
  let firstBatch = true;
  const proxy = { send: async (message, sender) => {
    if (message.type === "githubCommitReferences" && firstBatch) {
      firstBatch = false;
      const secondAck = await h.send({
        ...message, links: [message.links[1]]
      }, sender);
      return { ok: true, accepted: [false, secondAck.accepted[0]] };
    }
    return h.send(message, sender);
  } };
  const d = domHarness(proxy);
  await d.enable();
  await d.change(userTurn("lost-link-u", "Implement two independent commits"));
  await d.change(assistantTurn("lost-link-a",
    '<a href="' + COMMIT + '">First</a>' +
    '<a href="https://github.com/testerinopapa/gentle-control-room/commit/' +
    second + '">Second</a>'));

  let data = await exported(h);
  assert.equal(data.events.filter(e => e.type === "github_commit_ref").length, 1);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);

  // ChatGPT re-renders away the first link before the worker acknowledges it.
  d.root.lastElementChild.querySelector("a").remove();
  await d.scan();
  data = await exported(h);
  const refs = data.events.filter(e => e.type === "github_commit_ref");
  assert.deepEqual(Array.from(refs, e => e.commitSha).sort(), [HASH, second].sort());
  assert.equal(data.analysis.tasks.length, 1);
  assert.equal(data.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(data.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  assert.equal(data.analysis.captureDiagnostics.linkDelivery.responsesWithPartialCommitReferences, 0);
  assert.equal(data.analysis.captureDiagnostics.retrieval.withTextPatches, 2);
  assert.equal(h.requests.length, 2);
  await d.scan();
  assert.equal((await exported(h)).events.filter(e => e.type === "github_commit_ref").length, 2);
});

// Minimal version-1 evidence envelope; no prompt/stage signals contribute.
function patchEvidence(taskNumbers = [0, 1]) {
  const repository = 'example/project';
  const timestamp = new Date().toISOString();
  const sessionId = 'session-patch-tests';
  const events = [...new Set(taskNumbers)].map(task => ({ timestamp, sessionId,
    type: 'request_boundary', taskId: sessionId + ':' + task, requestId: 'm-patch-' + task,
    confidence: 'supported' }));
  const commits = {};
  taskNumbers.forEach((task, index) => {
    const sha = String(index + 1).repeat(40), key = repository + '@' + sha;
    events.push({ timestamp, sessionId, type: 'github_commit_ref', repository, commitSha: sha,
      taskId: sessionId + ':' + task, discovery: 'assistant', attribution: { state: 'automatic' } });
    commits[key] = { repository, sha, status: 'retrieved', files: [
      { path: 'src/handler.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n-old();\n+if (!input) return;\n+throw new Error("invalid");' },
      { path: 'tests/handler.test.ts', status: index ? 'modified' : 'added', patch: '@@ -0,0 +1 @@\n+test("input", () => {});' }
    ] };
  });
  return { version: 1, events, commits };
}
const codePatterns = data => harness().analyze(data).patterns.filter(p => p.basis === 'captured_patch_changes');

test('patch patterns require separate tasks and cite only matching commits and paths', () => {
  const data = patchEvidence([0, 1, 2]);
  const keys = Object.keys(data.commits);
  data.commits[keys[2]].files = [{ path: 'README.md', status: 'modified', patch: '@@ -0,0 +1 @@\n+throw new Error("documentation example");' }];
  const patterns = codePatterns(data);
  for (const type of ['same_file_in_distinct_commits', 'test_file_changes', 'error_handling_additions']) {
    const pattern = patterns.find(p => p.type === type);
    assert.ok(pattern, type);
    assert.equal(pattern.distinctTasks, 2);
    assert.equal(pattern.distinctCommits, 2);
    assert.deepEqual(Array.from(pattern.supportingCommitRefs), keys.slice(0, 2));
    assert.ok(pattern.supportingEvidence.every(e => pattern.supportingTaskIds.includes(e.taskId) && pattern.supportingCommitRefs.includes(e.commitRef)));
    assert.equal(pattern.verifiedOutcome, false);
  }
  assert.ok(!JSON.stringify(patterns).includes('new Error'));
  assert.equal(JSON.stringify(codePatterns(data)), JSON.stringify(codePatterns(JSON.parse(JSON.stringify(data)))));
});

test('two commits on one task do not produce recurring patch patterns', () => {
  const result = harness().analyze(patchEvidence([0, 0]));
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].commitReferences.length, 2);
  assert.equal(result.patterns.length, 0);
});

test('missing, metadata-only, malformed, oversized and identity-mismatched patches cannot support recurrence', () => {
  for (const change of [
    commit => { commit.status = 'metadata_only'; },
    commit => { commit.files.forEach(file => { delete file.patch; }); },
    commit => { commit.files.forEach(file => { file.patch = 'not a patch'; }); },
    commit => { commit.files.forEach(file => { file.patch = '@@ -0,0 +1 @@\n+' + 'x'.repeat(24000); }); },
    commit => { commit.sha = 'f'.repeat(40); },
  ]) {
    const data = patchEvidence();
    change(Object.values(data.commits)[1]);
    assert.equal(codePatterns(data).length, 0);
  }
  const data = patchEvidence();
  delete data.commits[Object.keys(data.commits)[1]];
  assert.equal(codePatterns(data).length, 0);
});

test('the same commit referenced by two tasks is not a recurring patch change', () => {
  const data = patchEvidence();
  const refs = data.events.filter(e => e.type === 'github_commit_ref');
  refs[1].commitSha = refs[0].commitSha;
  assert.equal(codePatterns(data).length, 0);
});

test('error-handling rules ignore context, removals, comments, strings and generic conditions', () => {
  for (const line of [' throw new Error("context");', '-throw new Error("removed");', '+// throw new Error("comment");', '+const text = "catch (error)";', '+if (ready) work();']) {
    const data = patchEvidence();
    Object.values(data.commits)[1].files[0].patch = '@@ -1 +1,2 @@\n' + line + '\n+work();';
    assert.ok(!codePatterns(data).some(p => p.type === 'error_handling_additions'), line);
  }
  for (const line of ['+} catch (error) {', '+except ValueError:', '+assert input is not None', '+guard input != nil else {', '+if not input: raise ValueError()']) {
    const data = patchEvidence();
    Object.values(data.commits)[1].files[0].patch = '@@ -0,0 +1 @@\n' + line;
    assert.ok(codePatterns(data).some(p => p.type === 'error_handling_additions'), line);
  }
});

test('test-file patterns require changed test source, not deletion or prompt labels', () => {
  const data = patchEvidence();
  Object.values(data.commits)[1].files[1].status = 'removed';
  assert.ok(!codePatterns(data).some(p => p.type === 'test_file_changes'));
  Object.values(data.commits)[1].files[1].status = 'modified';
  Object.values(data.commits)[1].files[1].patch = '@@ -1 +1 @@\n test("unchanged", () => {});';
  assert.ok(!codePatterns(data).some(p => p.type === 'test_file_changes'));
});

test('existing Evidence panel shows patch pattern task counts and supporting commit links', async () => {
  const h = harness();
  h.local.set('gcrEvidenceV1', patchEvidence());
  const state = await h.send({ type: 'getState', tabId: 9 });
  assert.ok(state.patterns.some(p => p.type === 'error_handling_additions'));
  const dom = new JSDOM(markup);
  vm.runInNewContext(panel, { document: dom.window.document, Option: dom.window.Option, Date,
    setInterval() {}, chrome: { runtime: { sendMessage: h.send }, tabs: {
      query: async () => [{ id: 9 }], onActivated: { addListener() {} }, onUpdated: { addListener() {} }
    } } });
  for (let i = 0; i < 5; i++) await tick();
  const list = dom.window.document.getElementById('code-patterns');
  assert.match(list.textContent, /Test files added or modified across tasks/);
  assert.match(list.textContent, /2 tasks/);
  assert.ok([...list.querySelectorAll('a')].every(a => /^https:\/\/github.com\/example\/project\/commit\/[12]{40}$/.test(a.href)));
  assert.ok(list.querySelectorAll('a').length >= 6);
  dom.window.close();
});

test('patch patterns exclude unattributed evidence and the same SHA mirrored across repositories', () => {
  const unattributed = patchEvidence();
  unattributed.events.at(-1).attribution.state = 'unattributed';
  assert.equal(codePatterns(unattributed).length, 0);
  const mirrored = patchEvidence();
  const references = mirrored.events.filter(e => e.type === 'github_commit_ref');
  const oldKey = Object.keys(mirrored.commits)[1];
  const commit = mirrored.commits[oldKey];
  delete mirrored.commits[oldKey];
  references[1].repository = commit.repository = 'example/fork';
  references[1].commitSha = commit.sha = references[0].commitSha;
  mirrored.commits[commit.repository + '@' + commit.sha] = commit;
  assert.equal(codePatterns(mirrored).length, 0);
});


test("commit patches and recurring patterns survive recording Stop and Start", async () => {
  const otherSha = "a".repeat(40);
  const repository = "testerinopapa/gentle-control-room";
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/persistent.ts", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const persisted = true;" }]
    })
  }));

  await enable(h);
  const firstSession = (await h.send({ type: "getState", tabId: 9 })).active;
  assert.equal(firstSession, true);
  assert.equal((await h.send({ type: "requestBoundary",
    requestId: "m-persist-1", confidence: "supported" }, origin)).ok, true);
  assert.equal((await h.send({ type: "assistantBoundary",
    responseId: "m-persist-2", requestId: "m-persist-1" }, origin)).ok, true);
  assert.equal((await h.send({ type: "githubCommitReferences",
    responseId: "m-persist-2", links: [
      { repository, sha: HASH, historical: false }
    ] }, origin)).accepted[0], true);

  await waitForStoredCommit(h, repository + "@" + HASH);
  const before = await exported(h);
  assert.equal(before.commits[repository + "@" + HASH].status, "retrieved");
  assert.equal(before.analysis.tasks.length, 1);
  assert.equal(before.analysis.patterns.filter(p => p.basis === "captured_patch_changes").length, 0);

  assert.equal((await h.send({ type: "stop", tabId: 9 })).ok, true);
  const stopped = await exported(h);
  assert.equal(stopped.commits[repository + "@" + HASH].status, "retrieved",
    "Stop must not delete previously retrieved patches");

  await enable(h);
  const restarted = await exported(h);
  assert.equal(restarted.commits[repository + "@" + HASH].status, "retrieved",
    "Start must not reset persistent evidence");
  assert.equal(restarted.events.filter(e => e.type === "session_started").length, 2);

  assert.equal((await h.send({ type: "requestBoundary",
    requestId: "m-persist-3", confidence: "supported" }, origin)).ok, true);
  assert.equal((await h.send({ type: "assistantBoundary",
    responseId: "m-persist-4", requestId: "m-persist-3" }, origin)).ok, true);
  assert.equal((await h.send({ type: "githubCommitReferences",
    responseId: "m-persist-4", links: [
      { repository, sha: otherSha, historical: false }
    ] }, origin)).accepted[0], true);

  await waitForStoredCommit(h, repository + "@" + otherSha);
  const after = await exported(h);
  assert.equal(Object.keys(after.commits).length, 2);
  assert.equal(h.requests.length, 2);
  assert.equal(after.analysis.tasks.length, 2);
  assert.equal(after.analysis.coverage.episodesWithActualDiffPatches, 2);
  const sameFile = after.analysis.patterns.find(
    p => p.type === "same_file_in_distinct_commits" &&
      p.basis === "captured_patch_changes");
  assert.ok(sameFile, "cross-session edits to the same source file should be detected");
  assert.equal(sameFile.distinctTasks, 2);
  assert.equal(sameFile.distinctCommits, 2);
  assert.deepEqual(Array.from(sameFile.supportingCommitRefs).sort(),
    [repository + "@" + HASH, repository + "@" + otherSha].sort());
});


test("switching conversations keeps previously collected patches available", async () => {
  const repository = "testerinopapa/gentle-control-room";
  const nextSha = "b".repeat(40);
  const h = harness("https://chatgpt.com/c/first-conversation", null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/session-evidence.ts", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const retained = true;" }]
    })
  }));

  await enable(h);
  assert.equal((await h.send({
    type: "githubCommitReference", repository, sha: HASH
  }, origin)).ok, true);
  await waitForStoredCommit(h, repository + "@" + HASH);
  const original = await exported(h);
  assert.equal(original.commits[repository + "@" + HASH].status, "retrieved");

  h.navigate("https://chatgpt.com/c/second-conversation");
  for (let i = 0; i < 12; i++) await tick();
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, false);
  const navigated = await exported(h);
  assert.equal(navigated.commits[repository + "@" + HASH].status, "retrieved",
    "Changing conversations must stop recording without clearing local evidence");

  await enable(h);
  assert.equal((await h.send({
    type: "githubCommitReference", repository, sha: nextSha
  }, origin)).ok, true);
  await waitForStoredCommit(h, repository + "@" + nextSha);
  const after = await exported(h);
  assert.equal(after.events.filter(event => event.type === "session_started").length, 2);
  assert.equal(after.commits[repository + "@" + HASH].status, "retrieved");
  assert.equal(after.commits[repository + "@" + nextSha].status, "retrieved");
  assert.equal(h.requests.length, 2);
});


test("accessible ChatGPT link controls capture two commits without HTML anchors", async () => {
  const second = "f".repeat(40);
  const repository = "testerinopapa/gentle-control-room";
  const next = "https://github.com/" + repository + "/commit/" + second;
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/accessible-link.ts", status: "modified",
        additions: 1, deletions: 0,
        patch: "@@ -0,0 +1 @@" + "\\n+export const linked = true;" }]
    })
  }));
  await enable(h);
  const d = domHarness(h); await d.enable();
  await d.change(userTurn("aria-u", "Implement two changes"));
  await d.change(assistantTurn("aria-a",
    '<span role="link" aria-label="Open commit: ' + COMMIT + '">First</span>' +
    '<button data-clipboard-text="Copy commit ' + next + '">Second</button>' +
    '<div title="https://github.com/example/ignored/commit/' + "e".repeat(40) +
    '">Unrelated</div>'));

  const captured = await exported(h);
  const refs = captured.events.filter(e => e.type === "github_commit_ref" &&
    e.attribution?.state === "automatic");
  assert.deepEqual(Array.from(refs, e => e.commitSha).sort(), [HASH, second].sort());
  assert.equal(captured.analysis.tasks.length, 1);
  assert.equal(captured.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  assert.equal(captured.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(captured.analysis.captureDiagnostics.linkDelivery.responsesWithPartialCommitReferences, 0);
  assert.equal(h.requests.length, 2);
  assert.ok(!JSON.stringify(captured).includes("Open commit: "),
    "accessible descriptions must not be exported verbatim");
});


test("late link metadata updates capture two commits without reloading the page", async () => {
  const second = "a".repeat(40);
  const repository = "testerinopapa/gentle-control-room";
  const secondUrl = "https://github.com/" + repository + "/commit/" + second;
  const h = harness(undefined, null, async url => ({
    ok: true, status: 200, headers: { get() { return null; } },
    text: async () => JSON.stringify({
      sha: url.split("/").at(-1),
      files: [{ filename: "src/late-link.ts", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const captured = true;" }]
    })
  }));
  await enable(h);
  const d = domHarness(h);
  await d.enable();

  const attrs = d.observerOptions().attributeFilter;
  for (const name of ["href", "data-href", "data-url", "data-clipboard-text", "aria-label", "title"])
    assert.ok(attrs.includes(name), "content observer must watch " + name);

  await d.change(userTurn("attribute-u", "Implement two changes"));
  await d.change(assistantTurn("attribute-a",
    '<span role="link" aria-label="Commit link pending">First</span>' +
    '<button data-clipboard-text="Pending">Second</button>'));
  assert.equal((await exported(h)).analysis.tasks[0].commitReferences.length, 0);

  // Commit destinations appear ONLY through late attribute updates; no
  // child-list, text, or href mutation occurs.
  d.root.querySelector('[role="link"]').setAttribute("aria-label", "View " + COMMIT);
  d.root.querySelector("button").setAttribute("data-clipboard-text", "Copy " + secondUrl);
  await d.mutate();

  const captured = await exported(h);
  const refs = captured.events.filter(e => e.type === "github_commit_ref" &&
    e.attribution?.state === "automatic");
  assert.deepEqual(Array.from(refs, e => e.commitSha).sort(), [HASH, second].sort());
  assert.equal(captured.analysis.tasks[0].commitReferences.length, 2);
  assert.equal(captured.analysis.tasks[0].responseMetadata.observedCommitLinks, 2);
  assert.equal(captured.analysis.captureDiagnostics.linkDelivery.responsesWithPartialCommitReferences, 0);
  await waitForStoredCommit(h, repository + "@" + HASH);
  await waitForStoredCommit(h, repository + "@" + second);
  assert.equal((await exported(h)).analysis.captureDiagnostics.retrieval.withTextPatches, 2);
  await d.mutate();
  assert.equal((await exported(h)).events.filter(e => e.type === "github_commit_ref" &&
    e.attribution?.state === "automatic").length, 2,
    "repeat metadata updates must not duplicate commit references");
});
