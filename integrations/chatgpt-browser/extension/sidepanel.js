"use strict";

const stateNode = document.getElementById("state");
const labelNode = document.getElementById("state-label");
const noteNode = document.getElementById("note");
const errorNode = document.getElementById("error");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const userNode = document.getElementById("user-count");
const assistantNode = document.getElementById("assistant-count");
const observerNode = document.getElementById("observer-state");
const evidenceCount = document.getElementById("evidence-count");
const exportButton = document.getElementById("export-evidence");
const clearButton = document.getElementById("clear-evidence");
const codeCountNode = document.getElementById("code-count");
const codingToggle = document.getElementById("coding-toggle");
const codingHint = document.getElementById("coding-hint");
const workflowToggle = document.getElementById("workflow-toggle");
const workflowState = document.getElementById("workflow-state");
let workflowEnabled = false;
let codingMarked = false;

let selectedTab = null;
let busy = false;
let lastError = "";

async function activeTab() {
  // The sidebar lives inside the current Edge window. Do not blindly use the
  // last-focused window, which can select another window or an extension page.
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current.length > 0) return current[0];
  const fallback = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback[0] || null;
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
      ? (result.reason || "Open a ChatGPT conversation to enable collection.")
      : active
        ? "This conversation is explicitly enabled. Stop whenever you like."
        : "Not recording. Select Start to enable this conversation.";
    startButton.disabled = busy || !allowed || active;
    stopButton.disabled = busy || !active;
    workflowEnabled = active && Boolean(result.workflowEnabled);
    workflowToggle.disabled = busy || !active;
    workflowToggle.textContent = workflowEnabled
      ? "Disable workflow analysis" : "Enable workflow analysis";
    workflowState.textContent = !active
      ? "Off · start recording this conversation first."
      : workflowEnabled
        ? "On · " + (result.workflowStages || 0) + " categorized requests recorded locally."
        : "Off · no message text is being inspected.";
    codingMarked = active && Boolean(result.codingMarked);
    codingToggle.disabled = busy || !active;
    codingToggle.textContent = codingMarked ? "Remove coding tag" : "Mark as coding work";
    codingHint.textContent = codingMarked
      ? "Marked as coding work for local recurring patterns."
      : "Mark this session if you use ChatGPT to work on code without displaying a code example.";
    codeCountNode.textContent = active && Number.isInteger(result.visibleCodeBlocks)
      ? String(result.visibleCodeBlocks) : "—";
    userNode.textContent = active && Number.isInteger(result.visibleUser)
      ? String(result.visibleUser) : "—";
    assistantNode.textContent = active && Number.isInteger(result.visibleAssistant)
      ? String(result.visibleAssistant) : "—";
    evidenceCount.textContent = (result.recordedEvents || 0) + " recorded events · " +
      (result.recordedCommits || 0) + " retrieved GitHub commits.";

    if (!active) {
      observerNode.textContent = "Start recording to check the page observer.";
    } else if (!Number.isFinite(result.lastObservedAt)) {
      observerNode.textContent = "Waiting for the ChatGPT page observer. If this persists, stop, reload the page, and start again.";
    } else if (Date.now() - result.lastObservedAt > 20000) {
      observerNode.textContent = "Page observer is not responding. Stop, reload ChatGPT, and start again.";
    } else if (result.detector === "unsupported") {
      observerNode.textContent = "ChatGPT's message layout is not recognized. Recording is on, but message counts are unavailable.";
    } else if (result.detector === "waiting") {
      observerNode.textContent = "Observer connected. Waiting for message containers to render.";
    } else if (Number.isFinite(result.lastCountAt) && Date.now() - result.lastCountAt > 20000) {
      observerNode.textContent = "Observer is connected, but the visible message count has not changed recently. Long conversations may keep only a fixed number of messages rendered.";
    } else if (Number.isFinite(result.lastCountAt)) {
      observerNode.textContent = "Page observer working. Counts will update as visible messages change.";
    } else {
      observerNode.textContent = "Page observer connected. Waiting for the first count update.";
    }
    showError(lastError);
  } catch (error) {
    selectedTab = null;
    stateNode.dataset.active = "false";
    labelNode.textContent = "Unavailable";
    noteNode.textContent = "The current browser tab could not be checked.";
    startButton.disabled = true;
    stopButton.disabled = true;
    codingToggle.disabled = true;
    workflowToggle.disabled = true;
    workflowEnabled = false;
    workflowToggle.textContent = "Enable workflow analysis";
    workflowState.textContent = "Unavailable.";
    codingMarked = false;
    codingToggle.textContent = "Mark as coding work";
    codeCountNode.textContent = "—";
    codingHint.textContent = "Coding status unavailable.";
    userNode.textContent = "—";
    assistantNode.textContent = "—";
    evidenceCount.textContent = "Evidence count unavailable.";
    observerNode.textContent = "Unable to check the page observer.";
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
    if (!result?.ok) throw new Error(result?.error || "Extension storage unavailable.");
  } catch (error) {
    lastError = error?.message || "Extension storage unavailable.";
  } finally {
    busy = false;
    await refresh();
  }
}

async function exportEvidence() {
  if (busy) return;
  busy = true; exportButton.disabled = true; lastError = "";
  try {
    const response = await chrome.runtime.sendMessage({ type: "exportEvidence" });
    if (!response?.ok || !response.data) throw Error("Unable to read local evidence.");
    // A local object URL keeps JSON off all remote services.
    const blob = new Blob([JSON.stringify(response.data, null, 2) + "\n"],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url; link.download = "gentle-control-room-evidence.json";
      link.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) { lastError = error?.message || "Could not export evidence."; }
  finally { busy = false; exportButton.disabled = false; await refresh(); }
}
async function clearEvidence() {
  if (busy || !confirm("Delete all evidence stored by this extension? Active recording will continue.")) return;
  busy = true; clearButton.disabled = true; lastError = "";
  try {
    const response = await chrome.runtime.sendMessage({ type: "clearEvidence" });
    if (!response?.ok) throw Error("Unable to delete local evidence.");
  } catch (error) { lastError = error?.message || "Could not delete evidence."; }
  finally { busy = false; clearButton.disabled = false; await refresh(); }
}

async function toggleCodingTag() {
  if (busy || !Number.isInteger(selectedTab)) return;
  busy = true;
  codingToggle.disabled = true;
  lastError = "";
  try {
    const tab = await activeTab();
    if (!tab || tab.id !== selectedTab) {
      throw new Error("The active tab changed. Select coding work again.");
    }
    const result = await chrome.runtime.sendMessage({
      type: "setCodingTag", tabId: selectedTab,
      codingMarked: !codingMarked
    });
    if (!result?.ok) throw new Error(result?.error || "Cannot save coding work tag.");
  } catch (error) {
    lastError = error?.message || "Cannot update coding work tag.";
  } finally {
    busy = false;
    await refresh();
  }
}

async function toggleWorkflow() {
  if (busy || !Number.isInteger(selectedTab)) return;
  busy = true;
  workflowToggle.disabled = true;
  lastError = "";
  try {
    const tab = await activeTab();
    if (!tab || tab.id !== selectedTab)
      throw new Error("Active tab changed. Choose workflow analysis again.");
    const result = await chrome.runtime.sendMessage({
      type: "setWorkflowAnalysis",
      tabId: selectedTab,
      enabled: !workflowEnabled
    });
    if (!result?.ok) throw new Error(result?.error || "Cannot change workflow analysis.");
  } catch (error) {
    lastError = error?.message || "Cannot change workflow analysis.";
  } finally {
    busy = false;
    await refresh();
  }
}
workflowToggle.addEventListener("click", () => void toggleWorkflow());
codingToggle.addEventListener("click", () => void toggleCodingTag());
startButton.addEventListener("click", () => void command("start"));
stopButton.addEventListener("click", () => void command("stop"));
exportButton.addEventListener("click", () => void exportEvidence());
clearButton.addEventListener("click", () => void clearEvidence());

// Edge keeps a side panel open across tab switches; never leave stale controls
// showing the previous tab's consent state.
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "loading" || info.url) void refresh();
});
setInterval(() => void refresh(), 2500);
void refresh();
