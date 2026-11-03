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
    tasks: [{ taskId: "task-1", commitReferences: [{ sha: "a".repeat(40) }] }],
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

test("Codex review refuses absent tasks and oversized payloads rather than silently truncating", () => {
  const empty = example();
  empty.analysis.tasks = [];
  assert.throws(() => build(empty), /Record a coding task/);
  const oversized = example();
  oversized.commits["example/repo@" + "a".repeat(40)].files[0].patch = "x".repeat(151000);
  assert.throws(() => build(oversized), /too large/);
  assert.throws(() => build({}), /No valid coding analysis/);
});
