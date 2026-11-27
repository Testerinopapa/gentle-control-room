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
const codexStatus = document.getElementById("codex-status");
const codexOutput = document.getElementById("codex-output");
const CODEX_HOST = "org.gentlecontrolroom.chatgpt";
const CODEX_INSIGHTS_KEY = "gcrCodexInsightsV1";
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
  return (snapshot?.messages || []).map(item => {
    const github = item.github || {};
    const links = (github.commits || []).filter(ref =>
      typeof ref?.url === "string" && !item.text.includes(ref.url))
      .map(ref => "GitHub commit: " + ref.url);
    const repos = (github.repositories || []).filter(repo =>
      typeof repo === "string" && !item.text.includes(repo) &&
      !(github.commits || []).some(ref => ref.repository === repo))
      .map(repo => "GitHub repository: " + repo);
    return (item.role === "user" ? "YOU" : "CHATGPT") + "\n" + item.text +
      (links.length || repos.length ? "\n\n" + [...links, ...repos].join("\n") : "");
  }).join("\n\n---\n\n");
}

function possibleReplyGaps(snapshot) {
  const messages = snapshot?.messages || [];
  let gaps = 0;
  for (let i = 1; i < messages.length; i++)
    if (messages[i - 1].role === "user" && messages[i].role === "user") gaps++;
  return gaps;
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
      (snapshot.coverage?.scanMethod === "live_archiver_dom_two_pass"
        ? " Browser scan: " +
          (snapshot.coverage.atTop && snapshot.coverage.atBottom
            ? "visited both scroll boundaries (NOT proof of full history)." :
              "did not confirm both scroll boundaries.") +
          (snapshot.coverage.observedWindows
            ? " " + snapshot.coverage.observedWindows + " rendered windows inspected." : "") +
          (snapshot.coverage.recoveredUserTurns || snapshot.coverage.recoveredFromUpwardPass
            ? " Recovered " + (snapshot.coverage.recoveredUserTurns || 0) +
              " earlier prompts and " + (snapshot.coverage.recoveredFromUpwardPass || 0) +
              " replies from the first pass." : "") +
          (snapshot.coverage.disconnectedWindows || snapshot.coverage.uncertainPlacements
            ? " Warning: " + (snapshot.coverage.disconnectedWindows || 0) +
              " window transitions had no shared message identifiers, and " +
              (snapshot.coverage.uncertainPlacements || 0) +
              " recovered turns have uncertain placement." : "") : "") +
      (snapshot.coverage?.tabWasHidden
        ? " The ChatGPT tab was backgrounded during this scan; rendering may have been delayed." : "") +
      (Number(snapshot.coverage?.supplementalReplies || 0) > 0
        ? " Recovered " + snapshot.coverage.supplementalReplies +
          " additional assistant replies with the legacy reader." : "") +
      (possibleReplyGaps(snapshot)
        ? " " + possibleReplyGaps(snapshot) +
          " possible reply gaps (consecutive user messages); capture may be incomplete." : "") +
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
    : "This metadata summary is separate from your locally saved conversation text.";
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
        : "Start reads currently rendered ChatGPT messages and saves them locally. Limited chat excerpts are sent to Codex only after you review and approve the exact payload.";
    // A single recording control is visible at a time. Starting also
    // captures the transcript, so manual capture stays in Advanced options.
    startButton.hidden = active;
    stopButton.hidden = !active;
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
    if (result.githubEvidence && !result.recordedCommits) {
      const evidence = result.githubEvidence;
      evidenceCount.textContent += evidence.unavailable
        ? " " + evidence.unavailable + " public GitHub fetches failed; re-scan to retry."
        : evidence.metadataOnly
          ? " GitHub returned commit metadata but no safe source diffs."
          : !evidence.capturedRepositories && !evidence.capturedCommitLinks
            ? " No GitHub repository or full commit URL found in the saved chat."
            : evidence.referenceEvents
              ? " Commit references were found, but no source patch was retrieved."
              : " A repository was detected, but no commit was captured yet.";
    }

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
    startButton.hidden = false;
    stopButton.hidden = true;
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
      else lastError = "Recording started, but the transcript could not be captured. Try Re-scan conversation in Advanced options.";
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
    "Captured from rendered ChatGPT messages with Live Archiver DOM scanning.\n" +
    "Not a verified complete history; unrendered messages may remain inaccessible.\n" +
    (currentBrowserConversation.coverage?.scanMethod === "live_archiver_dom_two_pass"
      ? "Scan boundaries: top=" + Boolean(currentBrowserConversation.coverage.atTop) +
        ", bottom=" + Boolean(currentBrowserConversation.coverage.atBottom) +
        "; windows inspected=" + (currentBrowserConversation.coverage.observedWindows ?? "unknown") +
        "; disconnected windows=" + (currentBrowserConversation.coverage.disconnectedWindows ?? "unknown") +
        "; restored first-pass turns=" + (currentBrowserConversation.coverage.recoveredUserTurns ?? "unknown") +
        "; restored first-pass replies=" + (currentBrowserConversation.coverage.recoveredFromUpwardPass ?? "unknown") +
        "; tab backgrounded=" + Boolean(currentBrowserConversation.coverage.tabWasHidden) +
        ".\n"
      : "") +
    "Possible reply gaps: " + possibleReplyGaps(currentBrowserConversation) +
    " (consecutive user messages do not prove a missing reply).\n\n" +
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
    codexPrepare.textContent = "Analyze coding activity with Codex";
    codexOutput.hidden = true;
    codexOutput.textContent = "";
    codexStatus.textContent = "No Codex insights yet.";
  } catch (error) { lastError = error?.message || "Could not delete evidence."; }
  finally { busy = false; clearButton.disabled = false; await refresh(); }
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

// An older installed Windows host can accept native messaging and reply
// {ok:true} without actually implementing the Codex analysis response.
// Keep this distinct from missing CLI login, invalid evidence, or timeouts.
function codexResponseProblem(result) {
  if (!result || typeof result !== "object")
    return "The local Codex bridge returned no usable response. Reinstall the native host with install-host.ps1, then restart Edge.";
  if (result.ok === false) {
    if (typeof result.error === "string" && result.error.trim())
      return result.error.trim().slice(0, 400);
    return "The local Codex bridge rejected the request without details. Reinstall the native host with install-host.ps1, then retry.";
  }
  if (result.ok !== true)
    return "The local Codex bridge returned an unrecognized response. Reinstall the native host with install-host.ps1, then restart Edge.";
  if (typeof result.output !== "string")
    return "The local Codex bridge connected but did not return an analysis. The installed Windows host may be outdated. Reinstall it with install-host.ps1 and restart Edge.";
  if (!result.output.trim())
    return "Codex returned an empty analysis. Check 'codex login status' in PowerShell and retry.";
  return null;
}

// A native host installed before Codex support responds with a generic
// {ok:false} to unknown message types. Probe without sending any evidence,
// so the user sees a version-specific error instead of a misleading CLI error.
function codexCapabilityProblem(result) {
  if (result?.ok === true && result.codexAnalyze === true &&
      result.protocolVersion === 1) return null;
  if (result?.ok === false || result?.ok === true)
    return "The installed Windows native host is outdated or does not support Codex analysis. Updating the Edge extension does not update the native host. From the repository folder, run .\\integrations\\chatgpt-browser\\install-host.ps1 and restart Edge.";
  return "The Windows native host did not confirm Codex analysis support. From the repository folder, run .\\integrations\\chatgpt-browser\\install-host.ps1 and restart Edge.";
}

// The explicitly labeled click authorizes this one bounded submission.
// Never send metadata-only or unlinked patches as a successful Stage 2 run.
// Strictly validate model-produced suggestions against the actual outbound evidence.
// Rendering is plain text; suggestions are never executed or written to project files.
function formatActionableReport(raw, payload) {
  let report;
  try { report = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, "$1")); }
  catch { throw Error("Codex did not return a structured improvement report. Retry analysis."); }
  const fail = () => { throw Error("Codex improvement report failed validation. No drafts were applied; retry analysis."); };
  const str = (v, max = 3000) => typeof v === "string" && !!v.trim() && v.length <= max;
  const kinds = new Set(["project-rule", "prompt", "skill", "test", "script", "ci-check", "documentation"]);
  const turnIds = new Set((payload.conversationCorrelation?.requests || []).map(request => request.turn));
  const ids = new Set();
  if (report?.version !== 1 || !str(report.summary) || !Array.isArray(report.limitations) ||
      report.limitations.length > 12 || !report.limitations.every(v => str(v)) ||
      !Array.isArray(report.findings) || report.findings.length > 5 ||
      !Array.isArray(report.actions) || report.actions.length > 5) fail();
  for (const f of report.findings) {
    if (!f || !str(f.id, 30) || ids.has(f.id) || !["friction", "win"].includes(f.kind) ||
        ![f.title, f.observation, f.hypothesis, f.impact].every(v => str(v)) ||
        !Array.isArray(f.evidence) || !f.evidence.length || f.evidence.length > 12) fail();
    for (const ref of f.evidence) {
      if (!ref || typeof ref !== "object") fail();
      const hasTurn = Object.hasOwn(ref, "turn"), hasCommit = Object.hasOwn(ref, "commit");
      if (hasTurn === hasCommit) fail();
      if (hasTurn && !turnIds.has(ref.turn)) fail();
      if (hasCommit && (!str(ref.commit, 200) || !str(ref.path, 300) ||
          !Object.hasOwn(payload.commits || {}, ref.commit) ||
          !payload.commits[ref.commit].files?.some(file => file.path === ref.path))) fail();
    }
    ids.add(f.id);
  }
  for (const a of report.actions) {
    if (!a || !ids.has(a.findingId) || !kinds.has(a.kind) ||
        !["high", "medium", "low"].includes(a.priority) ||
        ![a.title, a.destination, a.validation].every(v => str(v)) || !str(a.content, 12000)) fail();
  }
  const blocks = ["DEVELOPMENT IMPROVEMENTS", report.summary, "FINDINGS"];
  if (!report.findings.length) blocks.push("Not enough evidence for a reliable finding.");
  for (const f of report.findings) {
    const refs = f.evidence.map(ref => Object.hasOwn(ref, "turn") ? "Conversation turn " + ref.turn : ref.commit + " / " + ref.path);
    blocks.push(f.id + " | " + f.kind.toUpperCase() + " | " + f.title +
      "\nObserved: " + f.observation + "\nPossible cause: " + f.hypothesis + "\nImpact: " + f.impact +
      "\nEvidence: " + refs.join("; "));
  }
  blocks.push("READY-TO-COPY PROPOSALS (not applied or tested)");
  if (!report.actions.length) blocks.push("No justified improvement draft from this evidence.");
  const rank = { high: 0, medium: 1, low: 2 };
  for (const a of [...report.actions].sort((a, b) => rank[a.priority] - rank[b.priority])) {
    blocks.push(a.priority.toUpperCase() + " | " + a.kind + " | " + a.title +
      "\nAddresses: " + a.findingId + "\nSuggested destination: " + a.destination +
      "\n\n" + a.content + "\n\nValidate: " + a.validation);
  }
  blocks.push("EVIDENCE LIMITS", ...(report.limitations.length ? report.limitations : ["No additional limits reported."]),
    "Captured changes do not verify execution, authorship or outcomes. Conversation coverage may be incomplete.");
  return { text: blocks.join("\n\n"), count: report.actions.length, report };
}

// Every draft is rendered and exported as inert text. No agent-generated
// path is resolved on disk; downloads use a sanitized standalone draft name.
function assetDownloadName(action) {
  const slug = String(action.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64) || "improvement";
  if (action.kind === "prompt") return slug + "-draft.txt";
  const basename = String(action.destination).trim().split(/[\\/]/).at(-1) || "";
  const match = /^([a-z0-9][a-z0-9_.-]{0,95})\.(md|txt|js|mjs|cjs|jsx|ts|tsx|py|ps1|sh|bash|yml|yaml|json|toml|sql|cs|go|rs|java|rb|php|css|html|xml|ini|cfg|bat|cmd)$/i.exec(basename);
  if (!match) return slug + "-draft." + (["project-rule", "skill", "documentation"].includes(action.kind) ? "md" : "txt");
  const stem = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(match[1]) ? "improvement" : match[1];
  // HTML and batch files may execute when opened: retain them as text drafts.
  const extension = /^(html|bat|cmd)$/i.test(match[2]) ? match[2] + ".txt" : match[2];
  return stem + "-draft." + extension;
}

function renderImprovementAssets(container, formatted, io = {}) {
  const report = formatted.report;
  const doc = container.ownerDocument;
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const categories = [
    { title: "Automations", kinds: ["script"] },
    { title: "Reusable skills", kinds: ["skill"] },
    { title: "Preventative measures", kinds: ["test", "ci-check", "project-rule", "documentation"] },
    { title: "Better prompts", kinds: ["prompt"] }
  ];
  const rank = { high: 0, medium: 1, low: 2 };
  const byId = new Map(report.findings.map(f => [f.id, f]));
  const copy = io.copy || (text => navigator.clipboard.writeText(text));
  const download = io.download || ((filename, content) => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = make("a");
    link.href = url;
    link.download = filename;
    doc.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
  container.replaceChildren();
  container.append(make("h3", "Development improvements", "asset-heading"),
    make("p", report.summary, "asset-summary"),
    make("p", formatted.count + " reusable drafts · Review before applying. None have been executed or installed.", "hint"));
  const overview = make("div", undefined, "asset-overview");
  for (const group of categories) {
    const count = report.actions.filter(a => group.kinds.includes(a.kind)).length;
    overview.append(make("span", group.title + " · " + count, "asset-count"));
  }
  container.append(overview);
  for (const group of categories) {
    const actions = report.actions.filter(a => group.kinds.includes(a.kind)).sort((a,b) => rank[a.priority] - rank[b.priority]);
    if (!actions.length) continue;
    const groupNode = make("div", undefined, "asset-group");
    groupNode.append(make("h4", group.title + " (" + actions.length + ")", "asset-group-title"));
    for (const action of actions) {
      const finding = byId.get(action.findingId);
      const card = make("article", undefined, "asset-card");
      const meta = make("div", undefined, "asset-meta");
      const priority = make("span", action.priority + " priority", "asset-priority");
      priority.dataset.priority = action.priority;
      meta.append(priority, make("span", action.kind));
      card.append(meta, make("h5", action.title, "asset-title"),
        make("p", action.destination, "asset-destination"));
      const controls = make("div", undefined, "asset-controls");
      const copyButton = make("button", "Copy"), downloadButton = make("button", "Download");
      copyButton.type = downloadButton.type = "button";
      copyButton.setAttribute("aria-label", "Copy " + action.title);
      downloadButton.setAttribute("aria-label", "Download " + action.title);
      const status = make("p", "", "asset-feedback");
      status.setAttribute("role", "status");
      copyButton.addEventListener("click", async () => {
        try { await copy(action.content); status.textContent = "Copied draft."; }
        catch { status.textContent = "Copy failed. Open the draft and select its text."; }
      });
      downloadButton.addEventListener("click", async () => {
        try { await download(assetDownloadName(action), action.content); status.textContent = "Download requested."; }
        catch { status.textContent = "Download failed. Copy the draft instead."; }
      });
      controls.append(copyButton, downloadButton);
      card.append(controls, status);
      const draft = make("details", undefined, "asset-details");
      draft.append(make("summary", "View draft"), make("pre", action.content, "asset-code"),
        make("p", "Validate: " + action.validation, "hint"));
      card.append(draft);
      const evidence = make("details", undefined, "asset-details");
      evidence.append(make("summary", "Why this helps · Evidence"), make("p", finding.title),
        make("p", "Observed: " + finding.observation), make("p", "Possible cause: " + finding.hypothesis),
        make("p", "Impact: " + finding.impact));
      const refs = make("ul");
      for (const ref of finding.evidence)
        refs.append(make("li", Object.hasOwn(ref, "turn") ? "Conversation turn " + ref.turn : ref.commit + " / " + ref.path));
      evidence.append(refs); card.append(evidence); groupNode.append(card);
    }
    container.append(groupNode);
  }
  if (!report.actions.length) container.append(make("p", "No justified reusable drafts from the captured evidence.", "hint"));
  const limits = make("details", undefined, "asset-details");
  limits.append(make("summary", "Evidence coverage and limitations"));
  for (const line of report.limitations) limits.append(make("p", line));
  limits.append(make("p", "Captured patches do not verify authorship, execution or outcomes. The conversation scan may be incomplete."));
  const other = report.findings.filter(f => !report.actions.some(a => a.findingId === f.id));
  for (const f of other) {
    limits.append(make("p", f.title + ": " + f.observation + " Possible cause: " + f.hypothesis + " Impact: " + f.impact));
    const refs = make("ul");
    for (const ref of f.evidence) refs.append(make("li", Object.hasOwn(ref, "turn") ? "Conversation turn " + ref.turn : ref.commit + " / " + ref.path));
    limits.append(refs);
  }
  container.append(limits);
}

async function analyzeWithCodex() {
  if (busy) return;
  busy = true;
  codexPrepare.disabled = true;
  codexPrepare.textContent = "Scanning conversation…";
  codexOutput.hidden = true;
  codexOutput.textContent = "";
  codexStatus.textContent = "Checking real GitHub patches in this conversation…";
  try {
    const tab = await activeTab();
    if (!Number.isInteger(tab?.id)) throw Error("Select the ChatGPT conversation.");
    const response = await chrome.runtime.sendMessage({ type: "testCodexGitHub", tabId: tab.id });
    if (!response?.ok || !response.data) throw Error(response?.error || "Conversation scan failed.");
    const d = response.diagnostics || {};
    if (!d.retrieved) throw Error("No real patches retrieved (" + (d.discovered || 0) + " links found). " +
      (d.failures || []).map(f => f.error).join("; "));
    const evidence = GcrCodexEvidence.build(response.data, response.snapshot);
    const payload = JSON.parse(evidence.json);
    const explicitSourceLink = payload.conversationCorrelation.requests.some(request =>
      request.candidateCommits.some(ref => ref.evidence === "commit_link_in_assistant_reply" &&
        payload.commits[ref.commit]?.files.some(file => (d.sourceFiles || []).includes(file.path))));
    if (!evidence.commitCount || !d.sourceFiles?.length || !explicitSourceLink)
      throw Error("Stage 2 check failed: no real source patch explicitly linked to a conversation request. Scroll to the request and implementation reply, then retry. Nothing sent to Codex.");
    const counts = evidence.commitCount + " commits · " + d.sourceFiles.length + " source files · " +
      evidence.matchedRequests + " candidate request matches · " + (d.unavailable || 0) + " unavailable · " +
      (d.metadataOnly || 0) + " metadata only · " + (d.omitted || 0) + " omitted";
    codexStatus.textContent = "Retrieval checks passed: " + counts + ". Checking Codex bridge…";
    let capabilities;
    try { capabilities = await runNativeCodex({ type: "codex_capabilities", version: 1 }); }
    catch { throw Error("Cannot verify the Windows Codex bridge. Reinstall the native host if needed and restart Edge."); }
    const mismatch = codexCapabilityProblem(capabilities);
    if (mismatch) throw Error(mismatch);
    if (capabilities.actionableReportVersion !== 1)
      throw Error("Update the Windows native host using install-host.ps1 to enable actionable improvement reports. No evidence sent.");
    const current = await activeTab();
    if (current?.id !== tab.id || current?.url !== tab.url)
      throw Error("Active conversation changed before submission. Nothing sent to Codex.");
    codexPrepare.textContent = "Analyzing…";
    codexStatus.textContent = counts + ". Codex is analyzing the retrieved evidence…";
    const result = await runNativeCodex({ type: "codex_analyze", version: 1, approved: true, evidence: evidence.json });
    const problem = codexResponseProblem(result);
    if (problem) throw Error(problem);
    const report = formatActionableReport(result.output, payload);
    renderImprovementAssets(codexOutput, report);
    codexOutput.hidden = false;
    codexStatus.textContent = "Codex analysis complete: " + counts + " · " + report.count + " reusable drafts. No changes applied; normal history unchanged.";
  } catch (error) {
    codexStatus.textContent = error?.message || "Codex analysis failed.";
  } finally {
    busy = false;
    codexPrepare.disabled = false;
    codexPrepare.textContent = "Analyze coding activity with Codex";
  }
}
codexPrepare.addEventListener("click", () => void analyzeWithCodex());

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
