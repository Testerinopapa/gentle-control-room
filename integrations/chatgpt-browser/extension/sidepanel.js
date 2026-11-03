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
const commitInput = document.getElementById("commit-url");
const importButton = document.getElementById("import-commit");
const taskSelect = document.getElementById("commit-task");
const unresolvedNode = document.getElementById("unresolved-commits");
const importStatus = document.getElementById("import-status");
const patternsNode = document.getElementById("code-patterns");
const codeCountNode = document.getElementById("code-count");
let workflowEnabled = false;

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

function renderPatterns(patterns) {
  patternsNode.replaceChildren();
  const observed = (patterns || []).filter(pattern => pattern.basis === "captured_patch_changes");
  if (!observed.length) {
    const item = document.createElement("li");
    item.textContent = "No recurring code patterns yet. Each needs two tasks and two distinct commits with captured patches.";
    patternsNode.append(item);
  }
  for (const pattern of observed) {
    const item = document.createElement("li");
    item.textContent = pattern.label + " · " + pattern.distinctTasks + " tasks. Commits: ";
    for (const ref of pattern.supportingCommitRefs) {
      const match = /^([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})@([a-f0-9]{40})$/i.exec(ref);
      if (!match) continue;
      const link = document.createElement("a");
      link.href = "https://github.com/" + match[1] + "/commit/" + match[2];
      link.textContent = match[1] + "@" + match[2].slice(0, 7);
      link.target = "_blank"; link.rel = "noopener noreferrer";
      item.append(link, " ");
    }
    patternsNode.append(item);
  }
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

    renderPatterns(result.patterns);
    const selection = taskSelect.value;
    taskSelect.replaceChildren(new Option("Unattributed", ""));
    for (const task of result.attributionTasks || [])
      taskSelect.add(new Option(new Date(task.startedAt).toLocaleString() + " - " +
        (task.stages.join(" > ") || "Request") + " - " + task.taskId.slice(-8), task.taskId));
    taskSelect.value = selection;
    const unresolved = (result.unresolvedCommits || []).filter(ref => !ref.resolved);
    unresolvedNode.textContent = unresolved.length + " unresolved references. To associate later, paste the commit URL and select its task. " +
      [...new Set(unresolved.map(ref => ref.key + " (" + ref.state + ")"))].slice(0, 10).join("; ");
    const allowed = Boolean(result.allowed);
    const active = Boolean(result.active);
    stateNode.dataset.active = String(active);
    labelNode.textContent = active ? "Recording" : "Off";
    noteNode.textContent = !allowed
      ? (result.reason || "Open a ChatGPT conversation to enable collection.")
      : active
        ? "Recording coding-work metadata and analyzing workflow locally. Stop whenever you like."
        : "Start recording to enable coding and workflow analysis together. Visible request text is classified locally; only labels and task boundaries are saved. Public GitHub commits may be fetched.";
    startButton.disabled = busy || !allowed || active;
    stopButton.disabled = busy || !active;
    workflowEnabled = active && Boolean(result.workflowEnabled);
    importButton.disabled = busy || !workflowEnabled;
    importStatus.textContent = workflowEnabled
      ? "Paste a full GitHub commit URL to retrieve its public diff."
      : "Requires recording. Only public GitHub commits can be fetched.";
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
    importButton.disabled = true;
    workflowEnabled = false;
    codeCountNode.textContent = "—";
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

async function importCommit() {
  if (busy || !workflowEnabled || !Number.isInteger(selectedTab)) return;
  busy = true; importButton.disabled = true; lastError = "";
  importStatus.textContent = "Checking the GitHub commit…";
  try {
    const tab = await activeTab();
    if (!tab || tab.id !== selectedTab) throw Error("Active tab changed; select the ChatGPT conversation.");
    const response = await chrome.runtime.sendMessage({
      type: "importCommitUrl", tabId: selectedTab, url: commitInput.value.trim(), taskId: taskSelect.value || null
    });
    if (!response?.ok) throw Error(response?.error || "Commit import failed.");
    importStatus.textContent = response.duplicate
      ? "This commit was already recorded for this conversation."
      : "Commit reference recorded. Export JSON to inspect the public patch or retrieval status.";
    commitInput.value = "";
    taskSelect.value = "";
  } catch (error) {
    lastError = error?.message || "Commit import failed.";
    importStatus.textContent = "Commit not imported.";
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

startButton.addEventListener("click", () => void command("start"));
stopButton.addEventListener("click", () => void command("stop"));
importButton.addEventListener("click", () => void importCommit());
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
