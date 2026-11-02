"use strict";

// Pure, local, deterministic transformation of exported extension evidence.
// No AI requests, no network, no ChatGPT text, and no writes to browser storage.
(() => {
  const STAGES = new Set([
    "investigation", "implementation", "debugging",
    "testing", "version_control", "deployment"
  ]);
  const SESSION_RE = /^[a-zA-Z0-9-]{8,72}$/;
  const COMMIT_RE = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}@[a-f0-9]{40}$/i;
  const GAP_MS = 45 * 60 * 1000;
  const MAX_TASKS = 200;
  const MAX_PATTERNS = 30;
  const MAX_MATCHES = 12;

  const validTime = value => {
    if (typeof value !== "string" || value.length > 50) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  const finite = value => Number.isInteger(value) && value >= 0 ? value : 0;

  function makeEpisode(sessionId, segment, items, commits) {
    const stages = [];
    const stageCounts = Object.create(null);
    const referenceMap = new Map();
    const eventIndices = [];
    const observedKinds = new Set();
    let isTagged = false;

    for (const item of items) {
      const e = item.event;
      eventIndices.push(item.index);
      observedKinds.add(e.type);
      if (e.type === "coding_tag" && e.codingMarked === true) isTagged = true;
      if (e.type === "workflow_stage" && STAGES.has(e.stage)) {
        stages.push(e.stage);
        stageCounts[e.stage] = (stageCounts[e.stage] || 0) + 1;
      }
      if (e.type === "github_commit_ref" &&
          typeof e.repository === "string" && typeof e.commitSha === "string") {
        const key = e.repository.toLowerCase() + "@" + e.commitSha.toLowerCase();
        if (COMMIT_RE.test(key) && !referenceMap.has(key))
          referenceMap.set(key, { key, discovery: e.discovery === "manual" ? "manual" : "assistant",
            eventIndex: item.index });
      }
    }
    const uniqueStages = stages.filter((stage, i) => !i || stage !== stages[i - 1]);
    const references = [];
    for (const ref of referenceMap.values()) {
      const code = commits?.[ref.key];
      const stored = code && typeof code === "object" &&
        code.repository?.toLowerCase() + "@" + code.sha?.toLowerCase() === ref.key
        ? code : null;
      const paths = stored?.status === "retrieved" && Array.isArray(stored.files)
        ? stored.files.filter(file => typeof file.path === "string" && file.patch)
          .slice(0, 20).map(file => ({
            path: file.path,
            additions: finite(file.additions),
            deletions: finite(file.deletions),
            status: typeof file.status === "string" ? file.status : "unknown"
          })) : [];
      references.push({
        key: ref.key,
        repository: ref.key.split("@")[0],
        sha: ref.key.split("@")[1],
        discovery: ref.discovery,
        eventIndex: ref.eventIndex,
        retrieval: stored?.status || "not_available",
        changedFilesReported: finite(stored?.changedFiles),
        filesWithCapturedPatches: paths
      });
    }
    const repositories = [...new Set(references.map(ref => ref.repository))].sort();
    // Count file-level GitHub additions/deletions only when a textual patch
    // was retained. The same reference is already deduplicated per episode.
    const capturedFiles = references.flatMap(ref => ref.filesWithCapturedPatches);
    const reportedAdditions = capturedFiles.reduce((sum, file) => sum + file.additions, 0);
    const reportedDeletions = capturedFiles.reduce((sum, file) => sum + file.deletions, 0);
    return {
      id: sessionId + ":" + segment,
      kind: "inferred_coding_episode",
      segmentation: "same_session_and_45_minute_meaningful_event_gap",
      sessionId, startedAt: new Date(items[0].time).toISOString(),
      lastObservedAt: new Date(items[items.length - 1].time).toISOString(),
      eventIndices,
      codedByUser: isTagged,
      observedEventTypes: [...observedKinds].sort(),
      stages: uniqueStages,
      stageCounts: Object.fromEntries(Object.entries(stageCounts).sort(([a], [b]) => a.localeCompare(b))),
      commitReferences: references,
      repositories,
      evidence: {
        observedCommitReferences: references.length,
        retrievedCommitPatches: references.filter(ref => ref.filesWithCapturedPatches.length).length,
        capturedChangedFiles: capturedFiles.length,
        reportedLineChanges: {
          additions: reportedAdditions,
          deletions: reportedDeletions,
          total: reportedAdditions + reportedDeletions,
          scope: "github_file_counts_for_retained_text_patches",
          note: "GitHub-reported file totals, not work effort or a verification of success."
        },
        testExecution: "not_verified",
        testsPassed: "unknown",
        deployment: "unknown",
        authorship: "unknown"
      }
    };
  }

  function analyze(evidence) {
    const events = Array.isArray(evidence?.events) ? evidence.events : [];
    const commits = evidence?.commits && typeof evidence.commits === "object" ?
      evidence.commits : {};
    const sessions = new Map();
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (!event || typeof event !== "object" ||
          typeof event.sessionId !== "string" || !SESSION_RE.test(event.sessionId)) continue;
      const time = validTime(event.timestamp);
      if (time === null) continue;
      const relevant = (event.type === "workflow_stage" && STAGES.has(event.stage)) ||
        (event.type === "coding_tag" && event.codingMarked === true) ||
        (event.type === "github_commit_ref");
      if (!relevant) continue;
      if (!sessions.has(event.sessionId)) sessions.set(event.sessionId, []);
      sessions.get(event.sessionId).push({ event, index, time });
    }

    let allTasks = [];
    for (const [sessionId, records] of sessions) {
      records.sort((a, b) => a.time - b.time || a.index - b.index);
      let episode = [], segment = 0, last = null;
      function finish() {
        if (!episode.length) return;
        allTasks.push(makeEpisode(sessionId, ++segment, episode, commits));
        episode = [];
      }
      for (const item of records) {
        if (last !== null && item.time - last > GAP_MS) finish();
        episode.push(item); last = item.time;
      }
      finish();
    }
    allTasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const truncated = allTasks.length > MAX_TASKS;
    const tasks = allTasks.slice(-MAX_TASKS);

    const candidates = new Map();
    const add = (key, label, type, task, referenceKey = null) => {
      if (!candidates.has(key))
        candidates.set(key, { id: key, label, type, tasks: new Set(), references: new Set() });
      const p = candidates.get(key);
      p.tasks.add(task.id);
      if (referenceKey) p.references.add(referenceKey);
    };
    const fileEvidence = new Map();
    for (const task of tasks) {
      for (const stage of new Set(task.stages))
        add("stage:" + stage, "Repeated request classification: " + stage,
          "request_stage_recurrence", task);

      const transitions = new Set();
      for (let i = 1; i < task.stages.length; i++)
        transitions.add(task.stages[i - 1] + "->" + task.stages[i]);
      for (const transition of transitions)
        add("transition:" + transition,
          "Repeated observed request sequence: " + transition.replace("->", " → "),
          "request_stage_sequence", task);

      for (const reference of task.commitReferences) {
        for (const file of reference.filesWithCapturedPatches) {
          const key = reference.repository + "/" + file.path;
          if (!fileEvidence.has(key)) fileEvidence.set(key, new Map());
          const byTask = fileEvidence.get(key);
          if (!byTask.has(task.id)) byTask.set(task.id, new Set());
          byTask.get(task.id).add(reference.key);
        }
      }
    }
    for (const [file, evidenceByTask] of fileEvidence) {
      const distinctCommits = new Set();
      for (const refs of evidenceByTask.values())
        for (const ref of refs) distinctCommits.add(ref);
      // One commit linked in two different chats is NOT two separate edits.
      if (evidenceByTask.size < 2 || distinctCommits.size < 2) continue;
      const id = "file:" + file;
      for (const task of tasks) {
        const refs = evidenceByTask.get(task.id);
        if (!refs) continue;
        for (const ref of refs)
          add(id, "Repeated code edits observed for: " + file,
            "same_file_in_distinct_commits", task, ref);
      }
    }

    const patterns = [...candidates.values()]
      .filter(pattern => pattern.tasks.size >= 2)
      .map(pattern => ({
        id: pattern.id, type: pattern.type, label: pattern.label,
        distinctTasks: pattern.tasks.size,
        supportingTaskIds: [...pattern.tasks].slice(0, MAX_MATCHES),
        supportingCommitRefs: [...pattern.references].slice(0, MAX_MATCHES),
        basis: "observed_recurring_metadata",
        verifiedOutcome: false,
        note: pattern.type === "same_file_in_distinct_commits"
          ? "Distinct public commit patches reference this same file in multiple task episodes. No author or successful result inferred."
          : "Repeated classifications of visible requests; not proof these actions were performed."
      }))
      .sort((a, b) => b.distinctTasks - a.distinctTasks || a.id.localeCompare(b.id))
      .slice(0, MAX_PATTERNS);

    return {
      version: 1,
      method: "deterministic_local_evidence_rules",
      input: "bounded_exported_browser_events_and_public_commit_metadata",
      coverage: {
        retainedEvents: events.length,
        sessionsWithCodingSignals: sessions.size,
        inferredCodingEpisodes: tasks.length,
        discardedOlderEpisodes: truncated ? allTasks.length - tasks.length : 0,
        episodesWithCommitReferences: tasks.filter(task => task.commitReferences.length).length,
        episodesWithActualDiffPatches: tasks.filter(task => task.evidence.retrievedCommitPatches).length,
        recurringPatternsMeetingTwoEpisodeThreshold: patterns.length
      },
      tasks,
      patterns,
      limitations: [
        "Coding episodes are heuristic time segments, not confirmed user-defined tasks.",
        "Request-stage labels are inferred from visible user text and are not evidence an action happened.",
        "A GitHub link is not proof the assistant authored the commit or that the changes worked.",
        "Tests, execution, deployment, authorship, and outcomes are unverified unless separate evidence is provided.",
        "Only currently retained and consented browser events and available public GitHub patches are analyzed.",
        "No data is sent to DeepSeek or other AI services by this analysis."
      ]
    };
  }

  globalThis.GentleCodingAnalysis = Object.freeze({ analyze });
})();
