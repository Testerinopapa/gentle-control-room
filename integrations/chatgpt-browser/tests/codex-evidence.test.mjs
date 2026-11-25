import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(fileURLToPath(new URL("../extension/codex-evidence.js", import.meta.url)), "utf8");
const context = { TextEncoder };
vm.runInNewContext(source, context);
const build = context.GcrCodexEvidence.build;

const example = () => ({
  events: [{ type: "assistant_response", prompt: "SECRET CHAT CONTENT" }],
  cookies: "SECRET COOKIE",
  analysis: {
    tasks: [{ taskId: "task-1", commitReferences: [{
      key: "example/repo@" + "a".repeat(40), repository: "example/repo",
      sha: "a".repeat(40)
    }] }],
    patterns: [{ label: "Repeated test updates", supportingTaskIds: ["task-1"] }],
    coverage: { episodesWithActualDiffPatches: 1 },
    limitations: ["Tests are not verified."]
  },
  commits: {
    ["example/repo@" + "a".repeat(40)]: {
      status: "retrieved", repository: "example/repo", sha: "a".repeat(40),
      files: [{ path: "tests/regression.js", status: "modified",
        additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\\n+test();" }],
      untrustedExtra: "DO NOT FORWARD"
    },
    ["example/repo@" + "b".repeat(40)]: {
      status: "unavailable", repository: "example/repo", files: []
    }
  }
});

test("Codex review includes actual patches and patterns but excludes raw session events", () => {
  const data = build(example());
  const parsed = JSON.parse(data.json);
  assert.equal(data.taskCount, 1);
  assert.equal(data.patternCount, 1);
  assert.equal(data.commitCount, 1);
  assert.equal(parsed.analysis.tasks[0].taskId, "task-1");
  assert.equal(parsed.commits["example/repo@" + "a".repeat(40)].files[0].path, "tests/regression.js");
  assert.equal(parsed.analysis.coverage.episodesWithActualDiffPatches, 1);
  for (const secret of ["SECRET CHAT CONTENT", "SECRET COOKIE", "DO NOT FORWARD"])
    assert.ok(!data.json.includes(secret));
  assert.equal(parsed.events, undefined);
  assert.equal(parsed.cookies, undefined);
});

test("Codex review excludes cached patches that have no task attribution", () => {
  const evidence = example();
  const orphanKey = "example/repo@" + "c".repeat(40);
  evidence.commits[orphanKey] = {
    status: "retrieved", repository: "example/repo", sha: "c".repeat(40),
    files: [{ path: "src/unrelated.js", status: "modified",
      additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\\n+unrelated();" }]
  };
  const reviewed = build(evidence);
  assert.equal(reviewed.commitCount, 1);
  assert.ok(!reviewed.json.includes("src/unrelated.js"));
  assert.ok(!Object.hasOwn(JSON.parse(reviewed.json).commits, orphanKey));
  // A later task can explicitly reference the cached commit.
  evidence.analysis.tasks.push({
    taskId: "task-2",
    commitReferences: [{ key: orphanKey, repository: "example/repo", sha: "c".repeat(40) }]
  });
  const withTask = build(evidence);
  assert.equal(withTask.commitCount, 2);
  assert.equal(JSON.parse(withTask.json).commits[orphanKey].files[0].path, "src/unrelated.js");
});

test("Codex review refuses absent tasks and oversized payloads rather than silently truncating", () => {
  const empty = example();
  empty.analysis.tasks = [];
  assert.throws(() => build(empty), /No captured coding tasks or GitHub patches/);
  const oversized = example();
  oversized.commits["example/repo@" + "a".repeat(40)].files[0].patch = "x".repeat(151000);
  assert.throws(() => build(oversized), /too large/);
  assert.throws(() => build({}), /No valid coding analysis/);
});

test("Codex accepts retrieved public repository history even when no chat task was recorded", () => {
  const evidence = example();
  evidence.analysis.tasks = [];
  evidence.analysis.patterns = [];
  const key = "example/repo@" + "a".repeat(40);
  evidence.events = [{
    type: "github_commit_ref", repository: "example/repo",
    commitSha: "a".repeat(40), discovery: "repository_history",
    taskId: null, attribution: { state: "unattributed" }
  }];
  const reviewed = build(evidence);
  assert.equal(reviewed.taskCount, 0);
  assert.equal(reviewed.commitCount, 1);
  assert.equal(JSON.parse(reviewed.json).commits[key].provenance, "public_repository_history");
  assert.equal(JSON.parse(reviewed.json).commits[key].attribution, "unattributed");
  assert.equal(JSON.parse(reviewed.json).events, undefined);
  // No authorization to forward unrelated cached patches.
  evidence.events = [];
  assert.throws(() => build(evidence), /No captured coding tasks or GitHub patches/);
});

test("Codex includes captured conversation commits with an explicit unverified provenance", () => {
  const evidence = example();
  evidence.analysis.tasks = [];
  evidence.events = [{
    type: "github_commit_ref", repository: "example/repo",
    commitSha: "a".repeat(40), discovery: "conversation_scan",
    taskId: null, attribution: { state: "unattributed" }
  }];
  const result = build(evidence);
  assert.equal(result.commitCount, 1);
  assert.equal(JSON.parse(result.json).commits["example/repo@" + "a".repeat(40)]
    .provenance, "conversation_link");
});


test("Codex review links saved conversation turns to explicit and topic-matched commits", () => {
  const evidence = example();
  const shaA = "a".repeat(40), shaB = "b".repeat(40);
  const keyA = "example/repo@" + shaA, keyB = "example/repo@" + shaB;
  evidence.analysis.tasks = [];
  evidence.analysis.patterns = [];
  evidence.events = [shaA, shaB].map(sha => ({
    type: "github_commit_ref", repository: "example/repo",
    commitSha: sha, discovery: "repository_history"
  }));
  evidence.commits[keyA].message = "Save GitHub reference metadata";
  evidence.commits[keyB] = {
    status: "retrieved", repository: "example/repo", sha: shaB,
    message: "Repair native host installer validation",
    files: [{
      path: "integrations/chatgpt-browser/install-host.ps1",
      status: "modified", additions: 3, deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new"
    }]
  };
  const chat = { capturedAt: "2026-11-24T01:00:00.000Z", messages: [
    { role: "user", text: "Get commit links from the browser scanner" },
    { role: "assistant", text: "I found the exact GitHub commit", github: {
      commits: [{ repository: "example/repo", sha: shaA }]
    }},
    { role: "user", text: "Repair native host installer validation in PowerShell" },
    { role: "assistant", text: "The patch is reported to fix the installer" },
    { role: "user", text: "Add an unrelated button" },
    { role: "assistant", text: "Discussed it" }
  ] };
  const parsed = JSON.parse(build(evidence, chat).json);
  const linked = parsed.conversationCorrelation;
  assert.equal(linked.available, true);
  assert.equal(linked.matchedRequests, 2);
  assert.equal(linked.requests[0].candidateCommits[0].commit, keyA);
  assert.equal(linked.requests[0].candidateCommits[0].evidence, "commit_link_in_assistant_reply");
  assert.equal(linked.requests[1].candidateCommits[0].commit, keyB);
  assert.equal(linked.requests[1].candidateCommits[0].confidence, "possible_only");
  assert.equal(linked.requests[2].candidateCommits.length, 0);
  assert.equal(parsed.commits[keyB].message, "Repair native host installer validation");
  assert.equal(parsed.conversationCorrelation.unmatchedCommits, 0);
  assert.equal(parsed.analysis.tasks.length, 0);
  assert.equal(parsed.events, undefined);
});

test("No raw chat is transmitted unless a saved browser snapshot is expressly reviewed", () => {
  const evidence = example();
  const noChat = build(evidence);
  assert.equal(JSON.parse(noChat.json).conversationCorrelation.available, false);
  assert.ok(!noChat.json.includes("PRIVATE USER REQUEST"));
  const snapshot = { messages: [
    { role: "user", text: "Fix the PRIVATE USER REQUEST installer issue" },
    { role: "assistant", text: "The installer was changed, reportedly." }
  ] };
  const reviewed = build(evidence, snapshot);
  assert.ok(reviewed.json.includes("PRIVATE USER REQUEST"));
  assert.ok(reviewed.json.includes("unverified"));
  assert.ok(!reviewed.json.includes("SECRET COOKIE"));
});

test("Generic requests do not become author or completion attributions", () => {
  const evidence = example();
  const sha = "a".repeat(40);
  evidence.commits["example/repo@" + sha].message = "Update parser";
  const snapshot = { messages: [
    { role: "user", text: "Fix my code and update the project" },
    { role: "assistant", text: "Pushed to main." }
  ] };
  const parsed = JSON.parse(build(evidence, snapshot).json);
  assert.equal(parsed.conversationCorrelation.matchedRequests, 0);
  assert.equal(parsed.conversationCorrelation.unmatchedCommits, 1);
  assert.ok(parsed.conversationCorrelation.limitation.includes("not authorship"));
});


test("A short 'proceed' reply still captures an explicit assistant commit link", () => {
  const evidence = example();
  const sha = "a".repeat(40);
  const parsed = JSON.parse(build(evidence, {
    messages: [
      { role: "user", text: "Go ahead" },
      { role: "assistant", text: "Pushed an updated commit", github: {
        commits: [{ repository: "example/repo", sha }]
      }}
    ]
  }).json);
  assert.equal(parsed.conversationCorrelation.matchedRequests, 1);
  assert.equal(parsed.conversationCorrelation.requests[0].request, "Go ahead");
  assert.equal(parsed.conversationCorrelation.requests[0].candidateCommits[0].evidence,
    "commit_link_in_assistant_reply");
});

test("saved conversation alone can be reviewed without invented commit evidence", () => {
  const evidence = example();
  evidence.analysis.tasks = [];
  evidence.analysis.patterns = [];
  evidence.commits = {};
  evidence.events = [];
  const snapshot = { messages: [
    { role: "user", text: "Please fix the missing browser capture result" },
    { role: "assistant", text: "I said I repaired the capture flow." }
  ] };
  const result = build(evidence, snapshot);
  const payload = JSON.parse(result.json);
  assert.equal(payload.evidenceCoverage.retrievalStatus,
    "no_repository_or_commit_link_in_captured_chat");
  assert.equal(payload.evidenceCoverage.retrievedPatchCommits, 0);
  assert.equal(payload.conversationCorrelation.requests.length, 1);
  assert.equal(payload.conversationCorrelation.requests[0].candidateCommits.length, 0);
  assert.ok(payload.conversationCorrelation.requests[0].assistantReported.includes("said I repaired"));
});

test("failed GitHub lookups remain explicitly unverified in the review", () => {
  const evidence = example();
  const key = "example/repo@" + "a".repeat(40);
  evidence.analysis.tasks = [];
  evidence.analysis.patterns = [];
  evidence.commits[key].status = "unavailable";
  evidence.events = [{ type: "github_commit_ref", discovery: "conversation_scan",
    repository: "example/repo", commitSha: "a".repeat(40) }];
  const snapshot = { messages: [
    { role: "user", text: "Fix the GitHub parser" },
    { role: "assistant", text: "Repository: example/repo" }
  ] };
  const payload = JSON.parse(build(evidence, snapshot).json);
  assert.equal(payload.evidenceCoverage.retrievalStatus, "github_fetch_failed");
  assert.equal(payload.evidenceCoverage.failedPublicGitHubFetches, 1);
  assert.equal(payload.evidenceCoverage.retrievedPatchCommits, 0);
  assert.equal(payload.conversationCorrelation.matchedRequests, 0);
});
