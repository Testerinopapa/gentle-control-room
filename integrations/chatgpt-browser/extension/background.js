"use strict";
const HOST = "org.gentlecontrolroom.chatgpt";
const KEY = (tabId) => "gcrChatGPTTab:" + tabId;
const CHATGPT = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function eligible(url) {
  try {
    const u = new URL(url);
    return CHATGPT.has(u.origin) && u.protocol === "https:";
  } catch {
    return false;
  }
}
async function getSession(tabId) {
  const data = await chrome.storage.session.get(KEY(tabId));
  return data[KEY(tabId)] || null;
}
async function nativeEvent(event, sessionId, counts = undefined) {
  if (!UUID.test(sessionId)) throw new Error("Invalid session metadata.");
  const message = { version: 1, event, sessionId, ...(counts || {}) };
  const answer = await chrome.runtime.sendNativeMessage(HOST, message);
  if (!answer?.ok) throw new Error("The Windows native collector is unavailable.");
}
async function stop(tabId) {
  const session = await getSession(tabId);
  if (!session) return;
  // Revoke the browser's active collection state before any asynchronous work.
  await chrome.storage.session.remove(KEY(tabId));
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "gcrStop" }).catch(() => {});
  await nativeEvent("session_ended", session.id).catch(() => {});
}
async function start(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!eligible(tab.url)) throw new Error("Open chatgpt.com to enable collection.");
  if (await getSession(tabId)) return;
  const id = crypto.randomUUID();
  // Fail closed if the native host is not installed.
  await nativeEvent("session_started", id);
  await chrome.storage.session.set({ [KEY(tabId)]: { id, page: new URL(tab.url).pathname } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#166534" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    await stop(tabId);
    throw new Error("Cannot observe this tab. Reload ChatGPT and enable again.");
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!message || typeof message.type !== "string") throw new Error("Invalid request.");
    if (message.type === "visibleCounts" || message.type === "conversationChanged") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false };
      const session = await getSession(tabId);
      if (!session) return { ok: false };
      if (message.type === "conversationChanged") {
        await stop(tabId);
        return { ok: true };
      }
      if (!Number.isInteger(message.user) || message.user < 0 || message.user > 10000 ||
          !Number.isInteger(message.assistant) || message.assistant < 0 || message.assistant > 10000) {
        return { ok: false };
      }
      await nativeEvent("visible_counts", session.id, {
        visibleUser: message.user, visibleAssistant: message.assistant
      });
      return { ok: true };
    }

    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw new Error("No selected tab.");
    const tab = await chrome.tabs.get(tabId);
    if (message.type === "getState") {
      return { ok: true, allowed: eligible(tab.url), active: Boolean(await getSession(tabId)) };
    }
    if (message.type === "start") {
      await start(tabId);
      return { ok: true };
    }
    if (message.type === "stop") {
      await stop(tabId);
      return { ok: true };
    }
    throw new Error("Unsupported operation.");
  })().then(respond, (error) => respond({ ok: false, error: error?.message || "Unavailable" }));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { void stop(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) void stop(tabId);
});
