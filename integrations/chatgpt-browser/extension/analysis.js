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
            eventIndex: item.index, attribution: e.attribution || { state: "unattributed", confidence: "uncertain", method: "legacy_time_proximity" } });
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
        attribution: ref.attribution,
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
    const boundary = items.find(item => item.event.type === "request_boundary");
    const taskId = boundary?.event.taskId || sessionId + ":" + segment;
    return {
      id: taskId, taskId,
      completedAt: null,
      workflowStages: uniqueStages,
      attribution: { method: boundary ? "request_boundary" : "inactivity_fallback",
        confidence: boundary?.event.confidence || "uncertain", evidenceEventIndices: eventIndices },
      requestId: boundary?.event.requestId || null,
      responseIds: [...new Set(items.filter(item => item.event.type === "assistant_response").map(item => item.event.responseId))],
      filesChanged: [...new Set(capturedFiles.map(file => file.path))],
      lineChanges: { additions: reportedAdditions, deletions: reportedDeletions },
      verification: { testsExecuted: "unknown", testsPassed: "unknown", deployment: "unknown" },
      kind: "inferred_coding_episode",
      segmentation: boundary ? "observed_user_request" : "same_session_and_45_minute_meaningful_event_gap",
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
    const rawEvents = Array.isArray(evidence?.events) ? evidence.events : [];
    const events = rawEvents.map(e => e?.attribution ? { ...e, attribution: { ...e.attribution,
      evidenceEventIndices: rawEvents.flatMap((candidate, index) =>
        (candidate?.type === "request_boundary" && candidate.taskId === e.taskId) ||
        (candidate?.type === "assistant_response" && candidate.sessionId === e.sessionId &&
          candidate.responseId === e.attribution.responseId) ? [index] : [])
    } } : e);
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
        ["github_commit_ref", "request_boundary", "assistant_response"].includes(event.type);
      if (!relevant) continue;
      if (!sessions.has(event.sessionId)) sessions.set(event.sessionId, []);
      sessions.get(event.sessionId).push({ event, index, time });
    }

    let allTasks = [];
    const unresolved = [];
    const explicit = new Map();
    for (const records of sessions.values()) for (const item of records) {
      if (item.event.type === "request_boundary" && typeof item.event.taskId === "string" &&
          !explicit.has(item.event.taskId)) explicit.set(item.event.taskId, []);
    }
    // Later explicit user association resolves an earlier import without erasing
    // the original event. Raw chronology remains available for auditing.
    const resolved = new Set();
    for (const records of sessions.values()) for (const { event: e } of records) {
      if (e.type === "github_commit_ref" && ["manual", "automatic"].includes(e.attribution?.state) && explicit.has(e.taskId))
        resolved.add(e.repository + "@" + e.commitSha);
    }
    for (const [sessionId, records] of sessions) {
      records.sort((a, b) => a.time - b.time || a.index - b.index);
      let episode = [], segment = 0, last = null;
      function finish() {
        if (!episode.length) return;
        allTasks.push(makeEpisode(sessionId, ++segment, episode, commits));
        episode = [];
      }
      for (const item of records) {
        const e = item.event;
        if (e.type === "github_commit_ref" && (!e.taskId || !explicit.has(e.taskId) ||
            !["manual", "automatic"].includes(e.attribution?.state))) {
          const key = e.repository + "@" + e.commitSha;
          if (COMMIT_RE.test(key)) unresolved.push({ key, sessionId, eventIndex: item.index,
            state: e.attribution?.state === "historical" ? "historical" : "unattributed",
            resolved: resolved.has(key), attribution: e.attribution || { state: "unattributed", method: "legacy_unknown", confidence: "uncertain" } });
          // Legacy records remain inspectable, but proximity is no longer used
          // to attach even an old manual import to an inferred task.
          continue;
        }
        if (e.taskId && explicit.has(e.taskId)) { explicit.get(e.taskId).push(item); continue; }
        if (e.type === "assistant_response") continue;
        if (last !== null && item.time - last > GAP_MS) finish();
        episode.push(item); last = item.time;
      }
      finish();
    }
    for (const items of explicit.values()) {
      items.sort((a, b) => a.time - b.time || a.index - b.index);
      const boundary = items.find(item => item.event.type === "request_boundary");
      if (boundary) allTasks.push(makeEpisode(boundary.event.sessionId, 0, items, commits));
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
      else for (const ref of task.commitReferences) p.references.add(ref.key);
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

      for (let length = 3; length <= Math.min(5, task.stages.length); length++)
        for (let i = 0; i <= task.stages.length - length; i++) {
          const sequence = task.stages.slice(i, i + length).join("->");
          add("sequence:" + sequence, "Repeated observed request sequence: " + sequence,
            "request_stage_sequence", task);
        }
      for (const reference of task.commitReferences) {
        add("repository:" + reference.repository, "Repeated repository evidence: " + reference.repository,
          "repository_recurrence", task, reference.key);
        if (task.eventIndices.some(index => events[index]?.stage === "testing" && index < reference.eventIndex))
          add("testing:changes", "Commit references following test-related requests", "test_request_with_commit", task, reference.key);
        for (const file of reference.filesWithCapturedPatches) {
          const category = file.path.split(".").pop().toLowerCase();
          add("category:" + category, "Repeated file category: " + category,
            "file_category_recurrence", task, reference.key);
        }
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
      .filter(pattern => pattern.tasks.size >= 2 &&
        (!['repository_recurrence', 'file_category_recurrence', 'test_request_with_commit'].includes(pattern.type) || pattern.references.size >= 2))
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
      version: 2,
      method: "deterministic_local_evidence_rules",
      input: "bounded_exported_browser_events_and_public_commit_metadata",
      coverage: {
        unresolvedCommitReferences: unresolved.filter(ref => !ref.resolved).length,
        historicalCommitReferences: unresolved.filter(ref => ref.state === "historical").length,
        retainedEvents: events.length,
        sessionsWithCodingSignals: sessions.size,
        inferredCodingEpisodes: tasks.length,
        discardedOlderEpisodes: truncated ? allTasks.length - tasks.length : 0,
        episodesWithCommitReferences: tasks.filter(task => task.commitReferences.length).length,
        episodesWithActualDiffPatches: tasks.filter(task => task.evidence.retrievedCommitPatches).length,
        recurringPatternsMeetingTwoEpisodeThreshold: patterns.length
      },
      tasks,
      unattributedCommits: unresolved,
      patterns,
      limitations: [
        "Requests define conservative task boundaries, not semantic user goals; legacy episodes are heuristic time segments with uncertain attribution.",
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
