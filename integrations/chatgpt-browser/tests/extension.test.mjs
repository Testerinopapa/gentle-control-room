import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const panelMarkup = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const panelLogic = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const contentLogic = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
function harness(url = "https://chatgpt.com/c/synthetic-conversation", nativeResponse = { ok: true }) {
  let listener, updatedListener, removedListener;
  const stored = new Map();
  const native = [];
  const badge = [];
  const sidePanelBehavior = [];
  const chrome = {
    storage: { session: {
      async get(key) { return { [key]: stored.get(key) }; },
      async set(items) { for (const [k, v] of Object.entries(items)) stored.set(k, v); },
      async remove(key) { stored.delete(key); }
    } },
    sidePanel: {
      async setPanelBehavior(options) { sidePanelBehavior.push(options); }
    },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendNativeMessage(_host, message) {
        native.push(message);
        if (nativeResponse instanceof Error) throw nativeResponse;
        return nativeResponse;
      }
    },
    tabs: {
      async get(id) { assert.equal(id, 9); return { id, url }; },
      onUpdated: { addListener(fn) { updatedListener = fn; } },
      onRemoved: { addListener(fn) { removedListener = fn; } },
      async sendMessage() {}
    },
    action: {
      async setBadgeText(args) { badge.push(args); },
      async setBadgeBackgroundColor() {}
    },
    scripting: { async executeScript() {} }
  };
  const context = vm.createContext({ chrome, URL, crypto: { randomUUID }, console });
  vm.runInContext(source, context, { filename: "background.js" });
  async function send(message, sender = {}) {
    return await new Promise((done) => listener(message, sender, done));
  }
  return { send, native, stored, badge, sidePanelBehavior, updatedListener, removedListener };
}

test("off by default; only explicit ChatGPT tab opt-in starts recording", async () => {
  const h = harness();
  const initial = await h.send({ type: "getState", tabId: 9 });
  assert.equal(initial.active, false);
  assert.equal(h.native.length, 0);
  assert.equal((await h.send({ type: "start", tabId: 9 })).ok, true);
  assert.equal(h.native.length, 1);
  assert.equal(h.native[0].event, "session_started");
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, true);
  assert.equal(h.badge.at(-1).text, "ON");
});

test("records only allowlisted numeric metadata, without supplied content", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  const response = await h.send({
    type: "visibleCounts", user: 3, assistant: 2, secret: "DO-NOT-SAVE",
    url: "https://chatgpt.com/c/private"
  }, { tab: { id: 9 } });
  assert.equal(response.ok, true);
  assert.equal(h.native.at(-1).visibleUser, 3);
  assert.equal(h.native.at(-1).visibleAssistant, 2);
  assert.equal(JSON.stringify(h.native).includes("DO-NOT-SAVE"), false);
  assert.equal(JSON.stringify(h.native).includes("/c/private"), false);
});

test("rejects invalid message counts and unapproved tabs", async () => {
  const h = harness();
  assert.equal((await h.send({
    type: "visibleCounts", user: 2, assistant: 1
  }, { tab: { id: 9 } })).ok, false);
  await h.send({ type: "start", tabId: 9 });
  assert.equal((await h.send({
    type: "visibleCounts", user: "PRIVATE", assistant: 1
  }, { tab: { id: 9 } })).ok, false);
  assert.equal((await h.send({
    type: "visibleCounts", user: 2, assistant: 10001
  }, { tab: { id: 9 } })).ok, false);
  assert.equal(h.native.length, 1);
});

test("manual stop revokes collection and emits a session end", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  await h.send({ type: "stop", tabId: 9 });
  assert.equal(h.native.at(-1).event, "session_ended");
  assert.equal(h.stored.size, 0);
  assert.equal(h.badge.at(-1).text, "");
});

test("conversation change ends approved session", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  await h.send({ type: "conversationChanged" }, { tab: { id: 9 } });
  assert.equal(h.stored.size, 0);
  assert.equal(h.native.at(-1).event, "session_ended");
});

test("does not activate recording on non-ChatGPT origins", async () => {
  const h = harness("https://example.com/c/demo");
  const response = await h.send({ type: "start", tabId: 9 });
  assert.equal(response.ok, false);
  assert.equal(h.native.length, 0);
});

test("persistent sidebar has access limited to ChatGPT domains", () => {
  assert.deepEqual(manifest.host_permissions, [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*"
  ]);
  assert.equal(manifest.host_permissions.length, 2);
  assert.ok(panelLogic.includes("currentWindow: true"));
});

test("unavailable tab URL displays a site-permission explanation", async () => {
  const h = harness(null);
  const result = await h.send({ type: "getState", tabId: 9 });
  assert.equal(result.allowed, false);
  assert.equal(result.active, false);
  assert.match(result.reason, /site access/i);
  assert.equal(h.native.length, 0);
});
test("Edge action opens the persistent sidebar without granting consent", async () => {
  assert.equal(manifest.side_panel?.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(Object.hasOwn(manifest.action, "default_popup"), false);
  assert.ok(panelMarkup.includes('src="sidepanel.js"'));
  assert.ok(panelMarkup.includes('id="start"'));
  assert.ok(panelMarkup.includes('id="stop"'));

  const h = harness();
  assert.equal(h.sidePanelBehavior.length, 1);
  assert.equal(h.sidePanelBehavior[0].openPanelOnActionClick, true);
  assert.equal(h.native.length, 0, "opening the sidebar must not start collection");
  assert.equal((await h.send({ type: "getState", tabId: 9 })).active, false);
});

test("approved conversation counts can be displayed without exposing content", async () => {
  const h = harness();
  await h.send({ type: "start", tabId: 9 });
  let state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.active, true);
  assert.equal(state.visibleUser, null);
  await h.send({ type: "visibleCounts", user: 6, assistant: 7, privateText: "SECRET" }, { tab: { id: 9 } });
  state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.visibleUser, 6);
  assert.equal(state.visibleAssistant, 7);
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
  await h.send({ type: "stop", tabId: 9 });
  state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.active, false);
  assert.equal(state.visibleUser, null);
  assert.equal(h.stored.size, 0);
});

test("sidebar updates when the active tab changes and has no automatic start", () => {
  assert.ok(panelLogic.includes("chrome.tabs.onActivated.addListener"));
  assert.ok(panelLogic.includes('type: "getState"'));
  assert.ok(panelLogic.includes('type, tabId: selectedTab'));
  assert.ok(panelLogic.includes('addEventListener("click"'));
  assert.equal(panelLogic.includes('sendMessage({ type: "start"'), false);
  assert.ok(!panelMarkup.includes("popup.js"));
});

test("sidebar controls follow tab switches and retain explicit opt-in", async () => {
  const dom = new Map();
  const listeners = new Map();
  for (const id of ["state", "state-label", "note", "error", "start", "stop",
    "user-count", "assistant-count", "connection-state", "check-connection",
    "observer-state", "code-count", "coding-toggle", "coding-hint"]) {
    dom.set(id, {
      dataset: {}, textContent: "", disabled: false, hidden: true,
      addEventListener(kind, callback) { listeners.set(id + ":" + kind, callback); }
    });
  }

  let tabId = 9;
  let active = false;
  let tabActivated;
  let nativeStarts = 0;
  let lastTimer;
  const chromeMock = {
    tabs: {
      async query() { return [{ id: tabId }]; },
      onActivated: { addListener(fn) { tabActivated = fn; } },
      onUpdated: { addListener() {} }
    },
    runtime: {
      async sendMessage(message) {
        if (message.type === "getState") {
          return { ok: true, allowed: tabId === 9, active,
            visibleUser: active ? 2 : null,
            visibleAssistant: active ? 3 : null };
        }
        if (message.type === "testConnection") {
          return { ok: true, connected: true };
        }
        if (message.type === "start") { active = true; nativeStarts++; return { ok: true }; }
        if (message.type === "stop") { active = false; return { ok: true }; }
        throw new Error("Unexpected operation");
      }
    }
  };
  vm.runInNewContext(panelLogic, {
    chrome: chromeMock,
    document: { getElementById(id) { return dom.get(id); } },
    setInterval(fn) { lastTimer = fn; }
  }, { filename: "sidepanel.js" });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  assert.equal(nativeStarts, 0, "opening the panel must never start collection");
  assert.equal(dom.get("state-label").textContent, "Off");
  assert.equal(dom.get("start").disabled, false);
  listeners.get("check-connection:click")();
  await settle();
  assert.equal(nativeStarts, 0, "diagnosing the host must not start tracking");
  assert.match(dom.get("connection-state").textContent, /Connected/);
  listeners.get("start:click")();
  await settle();
  assert.equal(nativeStarts, 1);
  assert.equal(dom.get("state-label").textContent, "Recording");
  assert.equal(dom.get("user-count").textContent, "2");
  assert.equal(dom.get("assistant-count").textContent, "3");

  tabId = 8;
  tabActivated();
  await settle();
  assert.equal(dom.get("state-label").textContent, "Off");
  assert.equal(dom.get("start").disabled, true);
  assert.equal(dom.get("user-count").textContent, "—");
  assert.equal(typeof lastTimer, "function");
});

test("modern ChatGPT DOM reports visible role counts without reading messages", async () => {
  const sent = [];
  const modern = { user: 2, assistant: 1 };
  const region = {
    querySelectorAll(selector) {
      if (selector.includes("data-user-message-bubble")) return Array(modern.user).fill({});
      if (selector.includes(":user")) return Array(modern.user).fill({});
      if (selector.includes(":assistant")) return Array(modern.assistant).fill({});
      return [];
    }
  };
  let interval;
  let now = 10000;
  let mutationConfig;
  const observer = class {
    observe(_element, config) { mutationConfig = config; }
    disconnect() {}
  };
  const sentMessage = async (message) => { sent.push(message); return { ok: true }; };
  const context = {
    document: {
      documentElement: {},
      querySelector(selector) {
        return selector.includes("data-app-action-timeline-scroll") ? region : null;
      }
    },
    location: { pathname: "/c/approved" },
    chrome: {
      runtime: {
        sendMessage: sentMessage,
        onMessage: { addListener() {}, removeListener() {} }
      }
    },
    MutationObserver: observer,
    setInterval(fn) { interval = fn; return 1; },
    clearInterval() {},
    setTimeout() { return 10; },
    clearTimeout() {},
    Date: { now: () => now }
  };
  vm.runInNewContext(contentLogic, context, { filename: "content.js" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(mutationConfig.attributes);
  assert.ok(mutationConfig.childList);
  assert.equal(sent.find(x => x.type === "observerStatus")?.detector, "current");
  assert.deepEqual(
    { user: sent.find(x => x.type === "visibleCounts")?.user,
      assistant: sent.find(x => x.type === "visibleCounts")?.assistant },
    { user: 2, assistant: 1 }
  );
  modern.assistant = 2;
  now += 4000;
  interval();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(x => x.type === "visibleCounts").at(-1).assistant, 2);
  assert.ok(!JSON.stringify(sent).includes("approved"),
    "conversation pathname must never leave the page observer");
});

test("unknown ChatGPT layout reports unsupported rather than false zero counts", async () => {
  const sent = [];
  const context = {
    document: {
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    location: { pathname: "/c/approved" },
    chrome: {
      runtime: {
        async sendMessage(m) { sent.push(m); return { ok: true }; },
        onMessage: { addListener() {}, removeListener() {} }
      }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    Date: { now: () => 10000 }
  };
  vm.runInNewContext(contentLogic, context, { filename: "content.js" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].type, "observerStatus");
  assert.equal(sent[0].detector, "unsupported");
  assert.ok(!sent.some(x => x.type === "visibleCounts"));
});

test("legacy author-role markers remain supported when modern timeline is absent", async () => {
  const sent = [];
  const context = {
    document: {
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll(selector) {
        if (selector === '[data-message-author-role="user"]') return [{}, {}];
        if (selector === '[data-message-author-role="assistant"]') return [{}];
        return [];
      }
    },
    location: { pathname: "/c/approved" },
    chrome: {
      runtime: {
        async sendMessage(m) { sent.push(m); return { ok: true }; },
        onMessage: { addListener() {}, removeListener() {} }
      }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    Date: { now: () => 10000 }
  };
  vm.runInNewContext(contentLogic, context, { filename: "content.js" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].detector, "legacy");
  assert.equal(sent.find(x => x.type === "visibleCounts").user, 2);
  assert.equal(sent.find(x => x.type === "visibleCounts").assistant, 1);
});

test("page observer status is local-only metadata and is authorized per session", async () => {
  const h = harness();
  const before = await h.send({ type: "observerStatus", detector: "current",
    privateText: "PRIVATE" }, { tab: { id: 9 } });
  assert.equal(before.ok, false);
  await h.send({ type: "start", tabId: 9 });
  const result = await h.send({ type: "observerStatus", detector: "current",
    privateText: "PRIVATE" }, { tab: { id: 9 } });
  assert.equal(result.ok, true);
  const state = await h.send({ type: "getState", tabId: 9 });
  assert.equal(state.detector, "current");
  assert.ok(Number.isFinite(state.lastObservedAt));
  assert.equal(h.native.length, 1,
    "observer heartbeat must not write additional events to Windows");
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
  const invalid = await h.send({ type: "observerStatus", detector: "secret-pattern" },
    { tab: { id: 9 } });
  assert.equal(invalid.ok, false);
  const stateAgain = await h.send({ type: "getState", tabId: 9 });
  assert.equal(stateAgain.detector, "current");
});

test("code examples and user-tagged coding work remain metadata only", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "setCodingTag", tabId: 9, codingMarked: true })).ok, false);
  await h.send({ type: "start", tabId: 9 });
  const count = await h.send({
    type: "visibleCounts", user: 3, assistant: 4, codeBlocks: 2, code: "PRIVATE CODE"
  }, { tab: { id: 9 } });
  assert.equal(count.ok, true);
  assert.equal(h.native.at(-1).visibleCodeBlocks, 2);
  assert.equal(JSON.stringify(h.native).includes("PRIVATE CODE"), false);
  assert.equal((await h.send({
    type: "setCodingTag", tabId: 9, codingMarked: true, title: "PRIVATE TITLE"
  })).ok, true);
  let status = await h.send({ type: "getState", tabId: 9 });
  assert.equal(status.visibleCodeBlocks, 2);
  assert.equal(status.codingMarked, true);
  assert.equal(h.native.at(-1).event, "coding_tag");
  assert.equal(h.native.at(-1).codingMarked, true);
  assert.equal(JSON.stringify(h.native).includes("PRIVATE TITLE"), false);
  assert.equal((await h.send({ type: "setCodingTag", tabId: 9, codingMarked: "yes" })).ok, false);
  assert.equal((await h.send({ type: "setCodingTag", tabId: 9, codingMarked: false })).ok, true);
  status = await h.send({ type: "getState", tabId: 9 });
  assert.equal(status.codingMarked, false);
  assert.equal(h.native.at(-1).codingMarked, false);
});

test("code block changes trigger a new count even if message totals stay fixed", async () => {
  const sent = [];
  const current = { user: 2, assistant: 2, blocks: 1 };
  let tick;
  let now = 10000;
  const region = {
    querySelectorAll(selector) {
      if (selector.includes("data-user-message-bubble")) return Array(current.user).fill({});
      if (selector.includes(":user")) return Array(current.user).fill({});
      if (selector.includes(":assistant")) return Array(current.assistant).fill({});
      if (selector === "pre") return Array(current.blocks).fill({});
      return [];
    }
  };
  vm.runInNewContext(contentLogic, {
    document: { documentElement: {}, querySelector() { return region; } },
    location: { pathname: "/c/approved" },
    chrome: { runtime: {
      async sendMessage(msg) { sent.push(msg); return { ok: true }; },
      onMessage: { addListener() {}, removeListener() {} }
    } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    Date: { now: () => now }
  }, { filename: "content.js" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.find(x => x.type === "visibleCounts").codeBlocks, 1);
  current.blocks = 2;
  now += 4000;
  tick();
  await new Promise(resolve => setImmediate(resolve));
  const counts = sent.filter(x => x.type === "visibleCounts");
  assert.equal(counts.length, 2);
  assert.equal(counts.at(-1).codeBlocks, 2);
  assert.equal(counts.at(-1).assistant, 2);
  assert.ok(!JSON.stringify(sent).includes("/c/approved"));
});

test("native host health check does not start or save a conversation", async () => {
  const h = harness();
  const answer = await h.send({ type: "testConnection" });
  assert.equal(answer.ok, true);
  assert.equal(answer.connected, true);
  assert.equal(h.native.length, 1);
  assert.equal(h.native[0].event, "health_check");
  assert.equal(h.native[0].sessionId, undefined);
  assert.equal(h.stored.size, 0);
});

test("connection errors explain missing host and keep recording off", async () => {
  const h = harness("https://chatgpt.com/c/demo",
    new Error("Specified native messaging host not found."));
  const ping = await h.send({ type: "testConnection" });
  assert.equal(ping.ok, false);
  assert.match(ping.error, /install-host\.ps1/);
  const start = await h.send({ type: "start", tabId: 9 });
  assert.equal(start.ok, false);
  assert.match(start.error, /install-host\.ps1/);
  assert.equal(h.stored.size, 0);
});

test("sidebar exposes independent Windows connection diagnostics", () => {
  assert.ok(panelMarkup.includes('id="check-connection"'));
  assert.ok(panelMarkup.includes('id="connection-state"'));
  assert.ok(panelLogic.includes('type: "testConnection"'));
  assert.ok(panelLogic.includes('checkButton.addEventListener("click"'));
});
