"use strict";
const stateNode = document.getElementById("state");
const noteNode = document.getElementById("note");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
let currentTabId = null;

async function command(type) {
  if (!Number.isInteger(currentTabId)) return;
  startButton.disabled = true;
  stopButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type, tabId: currentTabId });
    if (!result?.ok) throw new Error(result?.error || "The local collector is unavailable.");
    await refresh();
  } catch (error) {
    noteNode.textContent = error.message || "Unable to contact the local collector.";
    await refresh(false);
  }
}

async function refresh(replaceNote = true) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id ?? null;
    if (!Number.isInteger(currentTabId)) throw new Error("No active tab.");
    const result = await chrome.runtime.sendMessage({ type: "getState", tabId: currentTabId });
    stateNode.textContent = result?.active ? "Recording this conversation" : "Off";
    startButton.disabled = !result?.allowed || Boolean(result?.active);
    stopButton.disabled = !result?.active;
    if (replaceNote) {
      noteNode.textContent = !result?.allowed
        ? "Open a conversation at chatgpt.com first."
        : result?.active
          ? "Only activity in this tab is monitored. Stop at any time."
          : "Not recording. Start only if you want this conversation counted.";
    }
  } catch {
    stateNode.textContent = "Unavailable";
    startButton.disabled = true;
    stopButton.disabled = true;
  }
}
startButton.addEventListener("click", () => command("start"));
stopButton.addEventListener("click", () => command("stop"));
void refresh();
