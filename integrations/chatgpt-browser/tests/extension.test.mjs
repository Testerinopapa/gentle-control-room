import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const panelMarkup = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const panelLogic = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
function harness(url = "https://chatgpt.com/c/synthetic-conversation") {
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
      async sendNativeMessage(_host, message) { native.push(message); return { ok: true }; }
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
    "user-count", "assistant-count"]) {
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
