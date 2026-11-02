import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const panel = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const HASH = "3d3812a0aade7b5e7c661741054184fd09886613";
const COMMIT = "https://github.com/Testerinopapa/gentle-control-room/commit/" + HASH;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(url = "https://chatgpt.com/c/test-conversation", commitResponse = null) {
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
    return {
      ok: true, status: 200,
      headers: { get() { return null; } },
      text: async () => JSON.stringify(record)
    };
  };
  vm.runInNewContext(background, {
    chrome, URL, crypto: { randomUUID }, Date, JSON, fetch,
    setTimeout, clearTimeout, console, AbortController
  }, { filename: "background.js" });
  async function send(message, sender = {}) {
    return await new Promise(resolve => listener(message, sender, resolve));
  }
  return {
    send, local, sessions, badge, requests, pageCommands,
    navigate(next) { currentUrl = next; tabUpdated(9, { url: next }); },
    tabRemoved
  };
}
const origin = { tab: { id: 9 } };
async function enable(h) {
  assert.equal((await h.send({ type: "start", tabId: 9 })).ok, true);
  assert.equal((await h.send({ type: "setWorkflowAnalysis", tabId: 9, enabled: true })).ok, true);
}
async function exported(h) {
  const result = await h.send({ type: "exportEvidence" });
  assert.equal(result.ok, true);
  return result.data;
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
});

test("starts locally without a host and stores minimal session metadata", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, false);
  assert.equal(h.local.size, 0);
  assert.equal((await h.send({ type: "start", tabId: 9 })).ok, true);
  const state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.active, true);
  assert.equal(state.workflowEnabled, false);
  assert.equal(h.badge.at(-1).text, "ON");
  const data = await exported(h);
  assert.equal(data.version, 1);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].type, "session_started");
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
  assert.equal((await exported(h)).events.length, 1);
});

test("counts and tags remain metadata only, with optional workflow categorization", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  assert.equal((await h.send({ type: "workflowStage", stage: "debugging" }, origin)).ok, false);
  const counts = await h.send({
    type: "visibleCounts", user: 3, assistant: 4, codeBlocks: 2,
    prompt: "PRIVATE CHAT", url: "https://chatgpt.com/c/private"
  }, origin);
  assert.equal(counts.ok, true);
  assert.equal((await h.send({ type: "setCodingTag", tabId: 9, codingMarked: true })).ok, true);
  assert.equal((await h.send({ type: "setWorkflowAnalysis", tabId: 9, enabled: true })).ok, true);
  assert.equal((await h.send({ type: "workflowStage", stage: "debugging", prompt: "SECRET" }, origin)).ok, true);
  assert.equal((await h.send({ type: "workflowStage", stage: "arbitrary" }, origin)).ok, false);
  const data = await exported(h);
  assert.deepEqual(Array.from(data.events, x => x.type), ["session_started", "visible_counts", "coding_tag", "workflow_stage"]);
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

test("workflow analysis consent is required for public GitHub fetches", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  const reference = { type: "githubCommitReference",
    repository: "Testerinopapa/gentle-control-room", sha: HASH };
  assert.equal((await h.send(reference, origin)).ok, false);
  assert.equal(h.requests.length, 0);
  await h.send({ type: "setWorkflowAnalysis", tabId: 9, enabled: true });
  assert.equal((await h.send({ ...reference, sha: "bad" }, origin)).ok, false);
  assert.equal((await h.send({ ...reference, repository: "example.com.evil/a" }, origin)).ok, false);
  assert.equal(h.requests.length, 0);
  await h.send({ type: "setWorkflowAnalysis", tabId: 9, enabled: false });
  assert.equal((await h.send(reference, origin)).ok, false);
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

test("a navigation away ends approval and rejects further page events", async () => {
  const h = harness();
  await enable(h);
  h.navigate("https://example.com/");
  await tick();
  assert.equal((await h.send({ type: "workflowStage", stage: "testing" }, origin)).ok, false);
  assert.equal(h.sessions.size, 0);
});

test("content observer reports only categories and GitHub commit identifiers", async () => {
  const seen = [], message = { innerText: "Fix the issue, then test it." };
  const link = { getAttribute: () => COMMIT };
  const assistant = { querySelectorAll: () => [link] };
  let command;
  const region = {
    querySelectorAll(selector) {
      if (selector.includes("data-user-message-bubble")) return [message];
      if (selector.includes(":assistant")) return [assistant];
      if (selector.includes(":user")) return [];
      if (selector === "pre") return [];
      return [];
    }
  };
  const chrome = { runtime: {
    async sendMessage(m) { seen.push(m); return { ok: true }; },
    onMessage: { addListener(fn) { command = fn; }, removeListener() {} }
  } };
  vm.runInNewContext(content, {
    URL, document: { documentElement: {}, querySelector() { return region; } },
    location: { pathname: "/c/test" }, chrome,
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    Date: { now: () => 10000 }
  });
  await tick();
  assert.equal(seen.some(e => e.type === "githubCommitReference"), false);
  command({ type: "gcrWorkflowMode", enabled: true });
  await tick();
  assert.equal(seen.find(e => e.type === "workflowStage").stage, "debugging");
  assert.equal(seen.find(e => e.type === "githubCommitReference").sha, HASH);
  assert.ok(!JSON.stringify(seen).includes("Fix the issue"));
  assert.ok(!JSON.stringify(seen).includes("/c/test"));
});


test("GitHub capture does not require recognized message-count markup", async () => {
  const sent = [];
  let enable;
  const assistant = { querySelectorAll(selector) {
    return selector === "a[href]" ? [{ getAttribute: () => COMMIT }] : [];
  } };
  const user = { innerText: "Fix the issue" };
  const region = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector === '[data-message-author-role="user"]') return [user];
      return [];
    }
  };
  vm.runInNewContext(content, {
    URL, document: { documentElement: {}, querySelector() { return region; } },
    location: { pathname: "/c/approved" },
    chrome: { runtime: {
      async sendMessage(message) { sent.push(message); return { ok: true }; },
      onMessage: { addListener(fn) { enable = fn; }, removeListener() {} }
    } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    Date: { now: () => 10000 }
  }, { filename: "content.js" });
  await tick();
  assert.equal(sent.find(m => m.type === "observerStatus").detector, "waiting");
  enable({ type: "gcrWorkflowMode", enabled: true });
  await tick();
  assert.equal(sent.find(m => m.type === "githubCommitReference").sha, HASH);
  assert.equal(sent.find(m => m.type === "workflowStage").stage, "debugging");
});
