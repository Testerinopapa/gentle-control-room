import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function harness(url = "https://chatgpt.com/c/synthetic-conversation") {
  let listener, updatedListener, removedListener;
  const stored = new Map();
  const native = [];
  const badge = [];
  const chrome = {
    storage: { session: {
      async get(key) { return { [key]: stored.get(key) }; },
      async set(items) { for (const [k, v] of Object.entries(items)) stored.set(k, v); },
      async remove(key) { stored.delete(key); }
    } },
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
  return { send, native, stored, badge, updatedListener, removedListener };
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
