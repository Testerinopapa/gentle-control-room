// In the extension SIDE PANEL DevTools console:
// const d = await import(chrome.runtime.getURL("stage2-diagnostic.js"));
// const report = await d.prepare();
// Inspect report.payload before calling await d.analyze(report, { approved: true }).
const prepared = new WeakSet();
function fail(message) { throw new Error("Stage 2 diagnostic: " + message); }
export async function prepare(tabId) {
  if (!globalThis.GcrCodexEvidence) fail("Open the extension side panel console, not ChatGPT's console.");
  if (!Number.isInteger(tabId)) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
  }
  if (!Number.isInteger(tabId)) fail("No active tab; select your ChatGPT conversation.");
  const response = await chrome.runtime.sendMessage({ type: "testCodexGitHub", tabId });
  if (!response?.ok) fail(response?.error || "No response from extension.");
  const d = response.diagnostics || {};
  if (!d.retrieved) fail("No retrieved patches. " + JSON.stringify(d));
  const built = globalThis.GcrCodexEvidence.build(response.data, response.snapshot);
  const payload = JSON.parse(built.json);
  const commits = Object.values(payload.commits);
  const explicit = payload.conversationCorrelation.requests.flatMap(request =>
    request.candidateCommits.filter(ref => ref.evidence === "commit_link_in_assistant_reply"));
  const checks = {
    capturedConversation: d.messages > 0 && payload.conversationCorrelation.available,
    discoveredCommitLinks: d.discovered > 0,
    retrievedRealDiffs: commits.length > 0 && commits.every(c =>
      c.provenance === "conversation_link" && c.files.length > 0 && c.files.every(f => typeof f.patch === "string" && f.patch.startsWith("@@ "))),
    substantiveSourceFiles: Array.isArray(d.sourceFiles) && d.sourceFiles.length > 0,
    explicitRequestLink: explicit.some(ref => payload.commits[ref.commit]?.files.some(f => d.sourceFiles.includes(f.path))),
    completeRetrievedSelection: d.unavailable === 0 && d.metadataOnly === 0 && d.omitted === 0
  };
  const essential = Object.entries(checks).filter(([name]) => name !== "completeRetrievedSelection");
  const report = { version: chrome.runtime.getManifest().version, pass: essential.every(([,ok]) => ok),
    checks, diagnostics: d, matchedRequests: built.matchedRequests, commits: commits.map(c =>
      ({ sha: c.sha, files: c.files.map(f => f.path) })), payload: built.json };
  Object.freeze(report); prepared.add(report);
  console.table(checks); console.log("Stage 2 retrieval:", report.pass ? "PASS" : "FAIL", d);
  console.log("Exact payload for review:", report.payload);
  return report;
}
function native(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendNativeMessage("org.gentlecontrolroom.chatgpt", message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}
export async function analyze(report, { approved = false } = {}) {
  if (!prepared.has(report) || !report.pass) fail("Prepare a passing report first.");
  if (!approved) fail("Review the exact payload before explicitly approving Codex submission.");
  prepared.delete(report);
  const capability = await native({ type: "codex_capabilities", version: 1 });
  if (!capability?.ok || capability.protocolVersion !== 1 || capability.codexAnalyze !== true)
    fail("Native bridge does not support Codex analysis; reinstall the host if needed.");
  const response = await native({ type: "codex_analyze", version: 1, approved: true, evidence: report.payload });
  if (!response?.ok || typeof response.output !== "string" || !response.output.trim())
    fail(response?.error || "Codex did not return an analysis.");
  const payload = JSON.parse(report.payload);
  const filenames = Object.values(payload.commits).flatMap(c => c.files.map(f => f.path));
  const mentionedFiles = [...new Set(filenames.filter(path =>
    response.output.includes(path) || response.output.includes(path.split("/").at(-1))))];
  const result = { bridge: "PASS", analysisReturned: true, mentionedFiles,
    fileReferenceCheck: mentionedFiles.length > 0 ? "PASS" : "REVIEW REQUIRED",
    output: response.output };
  console.log("Codex diagnostic (not saved):", result);
  return result;
}
