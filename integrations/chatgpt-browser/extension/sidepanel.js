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
const historySummaryNode = document.getElementById("history-summary");
const historySummaryScope = document.getElementById("history-summary-scope");
const historySummaryPatterns = document.getElementById("history-summary-patterns");
const downloadHistoryButton = document.getElementById("download-history-summary");
const captureBrowserButton = document.getElementById("capture-browser-conversation");
const browserConversationStatus = document.getElementById("browser-conversation-status");
const browserConversationPreview = document.getElementById("browser-conversation-preview");
const downloadBrowserButton = document.getElementById("download-browser-conversation");
const deleteBrowserButton = document.getElementById("delete-browser-conversation");
const codexPrepare = document.getElementById("prepare-codex");
const codexReview = document.getElementById("codex-review");
const codexPreview = document.getElementById("codex-preview");
const codexApproval = document.getElementById("codex-approval");
const codexAnalyze = document.getElementById("analyze-codex");
const codexStatus = document.getElementById("codex-status");
const codexOutput = document.getElementById("codex-output");
const CODEX_HOST = "org.gentlecontrolroom.chatgpt";
const CODEX_INSIGHTS_KEY = "gcrCodexInsightsV1";
let reviewedEvidence = null;
let workflowEnabled = false;

let selectedTab = null;
let busy = false;
let lastError = "";
let currentHistorySummary = null;
let currentBrowserConversation = null;
let loadedBrowserSnapshotKey = null;

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

function browserConversationText(snapshot) {
  return (snapshot?.messages || []).map(item =>
    (item.role === "user" ? "YOU" : "CHATGPT") + "\n" + item.text).join("\n\n---\n\n");
}

function renderBrowserConversation(snapshot) {
  currentBrowserConversation = snapshot || null;
  loadedBrowserSnapshotKey = snapshot
    ? snapshot.sessionId + ":" + snapshot.capturedAt : null;
  browserConversationPreview.value = snapshot ? browserConversationText(snapshot) : "";
  browserConversationPreview.hidden = !snapshot;
  downloadBrowserButton.disabled = !snapshot;
  deleteBrowserButton.disabled = !snapshot;
  browserConversationStatus.textContent = snapshot
    ? snapshot.messages.length + " messages retained across browser history scans (last scan: " +
      snapshot.renderedCount + " rendered). Captured " +
      new Date(snapshot.capturedAt).toLocaleString() + "." +
      (snapshot.orderUncertain ? " Some older and newer windows had no overlap; message order may be incomplete." : "") +
      (snapshot.truncated ? " Capture limits were reached; this may not be the full conversation." : "")
    : "No browser conversation has been captured yet.";
}

async function loadBrowserConversation(meta) {
  if (!meta) { renderBrowserConversation(null); return; }
  const key = meta.sessionId + ":" + meta.capturedAt;
  if (key === loadedBrowserSnapshotKey) return;
  const result = await chrome.runtime.sendMessage({
    type: "getBrowserConversation", tabId: selectedTab
  });
  if (result?.ok) renderBrowserConversation(result.snapshot || null);
}

function renderHistorySummary(summary, isCurrent) {
  currentHistorySummary = summary || null;
  downloadHistoryButton.disabled = !summary || !summary.requests;
  historySummaryNode.textContent = summary?.overview ||
    "No recorded coding conversation summary yet. Start recording to scan visible history.";
  historySummaryScope.textContent = summary
    ? (isCurrent ? "Current recording" : "Most recently recorded conversation") +
      " · Local metadata summary, not a transcript. Older unloaded messages are not included."
    : "Derived from local metadata only. Conversation text is never stored.";
  historySummaryPatterns.replaceChildren();
  for (const pattern of summary?.repeatedSignals || []) {
    const item = document.createElement("li");
    item.textContent = pattern;
    historySummaryPatterns.append(item);
  }
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
    renderHistorySummary(result.conversationSummary, Boolean(result.active));
    captureBrowserButton.disabled = busy || !result.active || !result.workflowEnabled;
    await loadBrowserConversation(result.browserConversation);
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
        ? "Recording metadata, including rendered history captured at Start. Stop whenever you like."
        : "Start reads the messages currently loaded in this ChatGPT tab and saves a local text snapshot. Coding activity is recorded separately. No chat text is sent to Codex.";
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
    renderHistorySummary(null, false);
    captureBrowserButton.disabled = true;
    renderBrowserConversation(null);
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
    if (type === "start") {
      // Explicit Start also captures the currently rendered transcript. The
      // button and nearby notice disclose that text will be stored locally.
      const capture = await chrome.runtime.sendMessage({
        type: "captureBrowserConversation", tabId: selectedTab
      });
      if (capture?.ok) loadedBrowserSnapshotKey = null;
      else lastError = "Recording started, but the page transcript was not captured. Use Capture conversation from browser to retry.";
    }
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

function downloadHistorySummary() {
  const summary = currentHistorySummary;
  if (!summary || !summary.requests) return;
  const content = [
    "Gentle Control Room — Conversation Summary",
    "",
    summary.overview,
    "",
    "Recurring signals:",
    ...(summary.repeatedSignals.length
      ? summary.repeatedSignals.map(label => "- " + label)
      : ["- None identified"]),
    "",
    summary.limitation,
    "",
    "This is a local metadata-based activity overview, not a full conversation recap."
  ].join("\n");
  const blob = new Blob([content + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "gentle-control-room-conversation-summary.txt";
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function captureBrowserConversation() {
  if (busy || !workflowEnabled || !Number.isInteger(selectedTab)) return;
  busy = true;
  captureBrowserButton.disabled = true;
  browserConversationStatus.textContent = "Reading rendered ChatGPT messages…";
  try {
    const tab = await activeTab();
    if (!tab || tab.id !== selectedTab)
      throw Error("Select the ChatGPT conversation you want to capture.");
    const result = await chrome.runtime.sendMessage({
      type: "captureBrowserConversation", tabId: selectedTab
    });
    if (!result?.ok) throw Error(result?.error || "Could not read browser conversation.");
    // The next refresh loads the freshly stored transcript from Edge.
    loadedBrowserSnapshotKey = null;
  } catch (error) {
    lastError = error?.message || "Unable to capture conversation.";
    browserConversationStatus.textContent = lastError;
  } finally {
    busy = false;
    await refresh();
  }
}

function downloadBrowserConversation() {
  if (!currentBrowserConversation) return;
  const text = "Gentle Control Room — Captured Browser Conversation\n" +
    "Captured: " + currentBrowserConversation.capturedAt + "\n" +
    "Only ChatGPT messages loaded in the browser at capture time.\n\n" +
    browserConversationText(currentBrowserConversation) + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = "gentle-control-room-browser-conversation.txt";
    a.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

async function deleteBrowserConversation() {
  if (busy || !currentBrowserConversation ||
      !confirm("Delete captured browser conversations stored by this extension?")) return;
  busy = true; deleteBrowserButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearBrowserConversation" });
    if (!result?.ok) throw Error("Could not delete captured conversation.");
    renderBrowserConversation(null);
  } catch (error) { lastError = error?.message || "Could not delete conversation."; }
  finally { busy = false; await refresh(); }
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
    await chrome.storage.local.remove(CODEX_INSIGHTS_KEY);
    renderBrowserConversation(null);
    reviewedEvidence = null;
    codexReview.hidden = true;
    codexOutput.hidden = true;
    codexOutput.textContent = "";
    codexStatus.textContent = "No Codex insights yet.";
  } catch (error) { lastError = error?.message || "Could not delete evidence."; }
  finally { busy = false; clearButton.disabled = false; await refresh(); }
}


async function reviewCodexEvidence() {
  if (busy) return;
  busy = true;
  codexPrepare.disabled = true;
  codexStatus.textContent = "Preparing evidence review…";
  reviewedEvidence = null;
  codexReview.hidden = true;
  codexApproval.checked = false;
  codexAnalyze.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "exportEvidence" });
    if (!response?.ok || !response.data) throw new Error("Unable to read recorded evidence.");
    reviewedEvidence = GcrCodexEvidence.build(response.data);
    codexPreview.value = reviewedEvidence.json;
    codexReview.hidden = false;
    codexStatus.textContent = reviewedEvidence.taskCount + " tasks · " +
      reviewedEvidence.commitCount + " retrieved commits · " +
      reviewedEvidence.patternCount + " patterns. Review the JSON before approving.";
  } catch (error) {
    codexStatus.textContent = error?.message || "Unable to prepare evidence.";
  } finally {
    busy = false;
    codexPrepare.disabled = false;
  }
}

function runNativeCodex(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(CODEX_HOST, message, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(
        "Codex bridge unavailable. Install/reinstall the native host with install-host.ps1 and check Codex CLI login."
      ));
      else resolve(result);
    });
  });
}

async function analyzeWithCodex() {
  if (busy || !reviewedEvidence || !codexApproval.checked) return;
  busy = true;
  codexAnalyze.disabled = true;
  codexPrepare.disabled = true;
  codexStatus.textContent = "Codex is analyzing the approved evidence…";
  try {
    const result = await runNativeCodex({
      type: "codex_analyze",
      version: 1,
      approved: true,
      evidence: reviewedEvidence.json
    });
    if (!result?.ok || typeof result.output !== "string")
      throw new Error(result?.error || "Codex could not analyze the evidence.");
    codexOutput.textContent = result.output;
    codexOutput.hidden = false;
    await chrome.storage.local.set({
      [CODEX_INSIGHTS_KEY]: { output: result.output, analyzedAt: new Date().toISOString() }
    });
    codexStatus.textContent = "Codex analysis complete. Saved locally in Edge.";
    reviewedEvidence = null;
    codexReview.hidden = true;
    codexApproval.checked = false;
  } catch (error) {
    codexStatus.textContent = error?.message || "Codex analysis failed.";
  } finally {
    busy = false;
    codexPrepare.disabled = false;
    codexAnalyze.disabled = !reviewedEvidence || !codexApproval.checked;
  }
}

async function restoreCodexInsights() {
  try {
    const saved = (await chrome.storage.local.get(CODEX_INSIGHTS_KEY))[CODEX_INSIGHTS_KEY];
    if (!saved || typeof saved.output !== "string") return;
    codexOutput.textContent = saved.output;
    codexOutput.hidden = false;
    codexStatus.textContent = "Last Codex analysis saved " +
      new Date(saved.analyzedAt).toLocaleString() + ". Review new evidence to analyze again.";
  } catch {
    // Recording works normally even if insight storage is unavailable.
  }
}

codexPrepare.addEventListener("click", () => void reviewCodexEvidence());
codexApproval.addEventListener("change", () => {
  codexAnalyze.disabled = !reviewedEvidence || !codexApproval.checked || busy;
});
codexAnalyze.addEventListener("click", () => void analyzeWithCodex());

startButton.addEventListener("click", () => void command("start"));
stopButton.addEventListener("click", () => void command("stop"));
importButton.addEventListener("click", () => void importCommit());
exportButton.addEventListener("click", () => void exportEvidence());
downloadHistoryButton.addEventListener("click", downloadHistorySummary);
captureBrowserButton.addEventListener("click", () => void captureBrowserConversation());
downloadBrowserButton.addEventListener("click", downloadBrowserConversation);
deleteBrowserButton.addEventListener("click", () => void deleteBrowserConversation());
clearButton.addEventListener("click", () => void clearEvidence());

// Edge keeps a side panel open across tab switches; never leave stale controls
// showing the previous tab's consent state.
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "loading" || info.url) void refresh();
});
setInterval(() => void refresh(), 2500);
void refresh();
void restoreCodexInsights();
