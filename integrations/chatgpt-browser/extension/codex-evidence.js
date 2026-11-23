"use strict";

// Pure, reviewable outbound payload. No raw chat events, transcript text,
// cookies, tokens, or unrelated storage values are included.
globalThis.GcrCodexEvidence = Object.freeze({
  build(exported) {
    if (!exported?.analysis || !Array.isArray(exported.analysis.tasks) ||
        !Array.isArray(exported.analysis.patterns) || !exported.commits ||
        typeof exported.commits !== "object")
      throw new Error("No valid coding analysis evidence is available.");
    // Only include retrieved patches that have a recorded evidence source.
    // Historical conversation references and public repository lookups are
    // not attributable to ChatGPT's actions, but they are valid code evidence.
    const taskCommits = new Set(exported.analysis.tasks.flatMap(task =>
      Array.isArray(task?.commitReferences)
        ? task.commitReferences.map(ref => ref?.key).filter(Boolean)
        : []));
    const discovery = new Map();
    for (const event of exported.events || []) {
      if (event?.type !== "github_commit_ref" ||
          !["conversation_scan", "repository_history", "manual"].includes(event.discovery) ||
          typeof event.repository !== "string" || typeof event.commitSha !== "string") continue;
      const key = event.repository.toLowerCase() + "@" + event.commitSha.toLowerCase();
      const origin = event.discovery === "conversation_scan" ? "conversation_link" :
        event.discovery === "repository_history" ? "public_repository_history" : "manual_link";
      if (!discovery.has(key)) discovery.set(key, origin);
    }
    const commits = {};
    for (const [key, commit] of Object.entries(exported.commits)) {
      if ((!taskCommits.has(key) && !discovery.has(key)) ||
          commit?.status !== "retrieved" || !Array.isArray(commit.files)) continue;
      commits[key] = {
        repository: commit.repository, sha: commit.sha,
        provenance: taskCommits.has(key) ? "task_linked" : discovery.get(key),
        attribution: taskCommits.has(key) ? "task_reference_not_authorship" : "unattributed",
        files: commit.files.map(file => ({
          path: file.path, status: file.status,
          additions: file.additions, deletions: file.deletions,
          patch: file.patch
        }))
      };
    }
    if (!exported.analysis.tasks.length && !Object.keys(commits).length)
      throw new Error("No captured coding tasks or GitHub patches yet. Scan a conversation with commit or repository links first.");
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
