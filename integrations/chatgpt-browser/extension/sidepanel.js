"use strict";

const stateNode = document.getElementById("state");
const labelNode = document.getElementById("state-label");
const noteNode = document.getElementById("note");
const errorNode = document.getElementById("error");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const userNode = document.getElementById("user-count");
const assistantNode = document.getElementById("assistant-count");
const connectionNode = document.getElementById("connection-state");
const checkButton = document.getElementById("check-connection");

let selectedTab = null;
let busy = false;
let lastError = "";

async function activeTab() {
  // Last focused browser window is the one whose right sidebar the user opened.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function showError(message) {
  errorNode.textContent = message;
  errorNode.hidden = !message;
}

async function refresh() {
  if (busy) return;
  try {
    const tab = await activeTab();
    selectedTab = Number.isInteger(tab?.id) ? tab.id : null;
    if (selectedTab === null) throw new Error("No active browser tab.");

    const result = await chrome.runtime.sendMessage({
      type: "getState", tabId: selectedTab
    });
    if (!result?.ok) throw new Error(result?.error || "Unable to read the current tab.");

    const allowed = Boolean(result.allowed);
    const active = Boolean(result.active);
    stateNode.dataset.active = String(active);
    labelNode.textContent = active ? "Recording" : "Off";
    noteNode.textContent = !allowed
      ? "Open a ChatGPT conversation to enable collection."
      : active
        ? "This conversation is explicitly enabled. Stop whenever you like."
        : "Not recording. Select Start to enable this conversation.";
    startButton.disabled = busy || !allowed || active;
    stopButton.disabled = busy || !active;
    userNode.textContent = active && Number.isInteger(result.visibleUser)
      ? String(result.visibleUser) : "—";
    assistantNode.textContent = active && Number.isInteger(result.visibleAssistant)
      ? String(result.visibleAssistant) : "—";
    showError(lastError);
  } catch (error) {
    selectedTab = null;
    stateNode.dataset.active = "false";
    labelNode.textContent = "Unavailable";
    noteNode.textContent = "The current browser tab could not be checked.";
    startButton.disabled = true;
    stopButton.disabled = true;
    userNode.textContent = "—";
    assistantNode.textContent = "—";
    showError(lastError || (error?.message || "Try opening ChatGPT again."));
  }
}

async function command(type) {
  if (busy || !Number.isInteger(selectedTab)) return;
  busy = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  lastError = "";
  try {
    // A sidebar can remain open while Edge changes active tabs. Make sure
    // the button still targets the tab the user actually sees.
    const tab = await activeTab();
    if (!tab || tab.id !== selectedTab) {
      throw new Error("The active tab changed. Select Start or Stop again.");
    }
    const result = await chrome.runtime.sendMessage({ type, tabId: selectedTab });
    if (!result?.ok) throw new Error(result?.error || "The local collector is unavailable.");
    connectionNode.textContent = "Connected to the Windows collector.";
  } catch (error) {
    lastError = error?.message || "The local collector is unavailable.";
    connectionNode.textContent = "Windows connection needs attention.";
  } finally {
    busy = false;
    await refresh();
  }
}

async function testConnection() {
  if (busy) return;
  busy = true;
  checkButton.disabled = true;
  connectionNode.textContent = "Checking the local Windows collector…";
  lastError = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "testConnection" });
    if (!result?.ok || !result.connected) {
      throw new Error(result?.error || "The Windows collector did not respond.");
    }
    connectionNode.textContent = "Connected. You can start recording a conversation.";
  } catch (error) {
    lastError = error?.message || "Cannot connect to the Windows collector.";
    connectionNode.textContent = "Not connected.";
  } finally {
    checkButton.disabled = false;
    busy = false;
    await refresh();
  }
}

startButton.addEventListener("click", () => void command("start"));
stopButton.addEventListener("click", () => void command("stop"));
checkButton.addEventListener("click", () => void testConnection());

// Edge keeps a side panel open across tab switches; never leave stale controls
// showing the previous tab's consent state.
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "loading" || info.url) void refresh();
});
setInterval(() => void refresh(), 2500);
void refresh();
