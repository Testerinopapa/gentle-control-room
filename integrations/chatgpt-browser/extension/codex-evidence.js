"use strict";

// Pure, reviewable outbound payload. No raw chat events, transcript text,
// cookies, tokens, or unrelated storage values are included.
globalThis.GcrCodexEvidence = Object.freeze({
  build(exported) {
    if (!exported?.analysis || !Array.isArray(exported.analysis.tasks) ||
        !Array.isArray(exported.analysis.patterns) || !exported.commits ||
        typeof exported.commits !== "object")
      throw new Error("No valid coding analysis evidence is available.");
    const commits = {};
    for (const [key, commit] of Object.entries(exported.commits)) {
      if (commit?.status !== "retrieved" || !Array.isArray(commit.files)) continue;
      commits[key] = {
        repository: commit.repository, sha: commit.sha,
        files: commit.files.map(file => ({
          path: file.path, status: file.status,
          additions: file.additions, deletions: file.deletions,
          patch: file.patch
        }))
      };
    }
    if (!exported.analysis.tasks.length)
      throw new Error("Record a coding task before requesting analysis.");
    const review = {
      source: "Gentle Control Room opt-in Edge evidence",
      analysis: {
        tasks: exported.analysis.tasks,
        patterns: exported.analysis.patterns,
        coverage: exported.analysis.coverage,
        limitations: exported.analysis.limitations
      },
      commits
    };
    const json = JSON.stringify(review, null, 2);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > 150_000)
      throw new Error("The evidence is too large for a single Codex review (150 KB limit).");
    return {
      json,
      taskCount: review.analysis.tasks.length,
      patternCount: review.analysis.patterns.length,
      commitCount: Object.keys(commits).length,
      bytes
    };
  }
});
