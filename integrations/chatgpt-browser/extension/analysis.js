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

  const PATCH_PATTERN_TYPES = new Set([
    "same_file_in_distinct_commits", "test_file_changes", "error_handling_additions"
  ]);
  const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|java|cs|go|rs|rb|php|swift|kt|kts|scala|c|cc|cpp|h|hpp|sh|ps1|vue|svelte)$/i;
  const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/)|(?:^|\/)(?:test_[^/]+|[^/]+(?:[._-](?:test|spec)|Tests?))\.[^/]+$/i;

  function patchSignals(file) {
    // Apply the capture limits again when analyzing an older/imported export.
    if (!file || typeof file.patch !== "string" || file.patch.length > 24000 ||
        !file.patch.startsWith("@@ ") || !SOURCE_FILE.test(file.path || "")) return null;
    let inHunk = false, changed = false;
    const additions = [];
    for (const line of file.patch.split(/\r?\n/)) {
      if (/^@@ /.test(line)) { inHunk = true; continue; }
      if (!inHunk || /^(?:\+\+\+|---)/.test(line)) continue;
      if (/^[+-]/.test(line) && line.slice(1).trim()) changed = true;
      if (line.startsWith("+")) additions.push(line.slice(1).trim());
    }
    if (!changed) return null;
    // Syntax observations only: added catch/except/throw/raise/assert, Swift
    // guards, or a single-line conditional return/throw/raise. Plain `if`,
    // context lines, removed code and comment-only keywords are insufficient.
    const errorHandling = additions.some(line => !/^(?:\/\/|\/\*|\*|#)/.test(line) && (
      /^(?:}\s*)?(?:catch\s*(?:\(|\{)|except(?:\s+[^:]+)?:|throw\s+|raise(?:\s|$)|assert(?:\s|\())/.test(line) ||
      /^guard\s+.+\belse\s*\{/.test(line) ||
      /^if\s*(?:\(.+\)|.+:)\s*(?:\{\s*)?(?:return\b|throw\b|raise\b)/.test(line)
    ));
    return { testing: TEST_FILE.test(file.path) && ["added", "modified"].includes(file.status), errorHandling };
  }

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
    const responseEvidence = items.filter(item => item.event.type === "assistant_evidence" &&
      typeof item.event.responseId === "string").map(item => item.event);
    const responseSummaries = [...new Map(responseEvidence.map(e => [e.responseId, e])).values()];
    const responseMetadata = {
      observedResponses: responseSummaries.length,
      observedCodeBlocks: responseSummaries.reduce((sum, e) => sum + finite(e.observedCodeBlocks), 0),
      observedCommitLinks: responseSummaries.reduce((sum, e) => sum + finite(e.observedCommitLinks), 0),
      maxObservedResponseCharacters: Math.max(0, ...responseSummaries.map(e => finite(e.observedCharacters))),
      mentionedStages: [...new Set(responseSummaries.flatMap(e =>
        Array.isArray(e.mentionedStages) ? e.mentionedStages.filter(s => STAGES.has(s)) : []))].sort(),
      commandFamilies: [...new Set(responseSummaries.flatMap(e =>
        Array.isArray(e.commandFamilies) ? e.commandFamilies.filter(s =>
          ["git", "npm", "npx", "pnpm", "yarn", "node", "python",
            "pytest", "docker", "dotnet", "powershell"].includes(s)) : []))].sort(),
      scope: "rendered_assistant_metadata_not_execution_proof"
    };
    return {
      id: taskId, taskId,
      completedAt: null,
      workflowStages: uniqueStages,
      attribution: { method: boundary ? "request_boundary" : "inactivity_fallback",
        confidence: boundary?.event.confidence || "uncertain", evidenceEventIndices: eventIndices },
      requestId: boundary?.event.requestId || null,
      responseIds: [...new Set(items.filter(item => item.event.type === "assistant_response").map(item => item.event.responseId))],
      filesChanged: [...new Set(capturedFiles.map(file => file.path))],
      responseMetadata,
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

  // Provide explicit capture diagnostics in the JSON export. Counts describe
  // recorded evidence, not work performed or verified GitHub authorship.
  function captureDiagnostics(events, commits) {
    const refs = events.filter(e => e && e.type === "github_commit_ref" &&
      typeof e.repository === "string" && typeof e.commitSha === "string" &&
      COMMIT_RE.test(e.repository.toLowerCase() + "@" + e.commitSha.toLowerCase()));
    const discovery = { assistant: 0, manual: 0, unknown: 0 };
    const attribution = { automatic: 0, manual: 0, unattributed: 0, historical: 0, unknown: 0 };
    const eligibleKeys = new Set();
    const historicalKeys = new Set();

    for (const ref of refs) {
      const origin = ref.discovery === "assistant" || ref.discovery === "manual"
        ? ref.discovery : "unknown";
      discovery[origin]++;
      const state = ref.attribution?.state;
      attribution[Object.hasOwn(attribution, state) ? state : "unknown"]++;
      const key = ref.repository.toLowerCase() + "@" + ref.commitSha.toLowerCase();
      if (state === "historical") historicalKeys.add(key);
      else eligibleKeys.add(key);
    }

    let retrievedWithPatches = 0;
    let metadataOnly = 0;
    let unavailable = 0;
    let notCached = 0;
    let identityMismatch = 0;
    let unknownStatus = 0;
    for (const key of eligibleKeys) {
      const record = commits[key];
      if (!record || typeof record !== "object") { notCached++; continue; }
      // A mismatched cache entry must not be presented as evidence of this
      // commit. Legacy fixtures lacking identity fields remain readable.
      if ((typeof record.repository === "string" &&
           record.repository.toLowerCase() !== key.split("@")[0]) ||
          (typeof record.sha === "string" &&
           record.sha.toLowerCase() !== key.split("@")[1])) {
        identityMismatch++; continue;
      }
      if (record.status === "unavailable") { unavailable++; continue; }
      if (record.status === "metadata_only") { metadataOnly++; continue; }
      if (record.status !== "retrieved") { unknownStatus++; continue; }
      if (!Array.isArray(record.files) ||
          !record.files.some(f => f && typeof f.patch === "string" && f.patch.length > 0)) {
        metadataOnly++; continue;
      }
      retrievedWithPatches++;
    }
    // A session can successfully record visible counts but never observe a
    // new coding request. Report that absence explicitly rather than treating
    // the automatic session tag as proof of workflow capture.
    const startedSessions = new Set();
    const sessionsWithWorkflowEvidence = new Set();
    const sessionsWithRequestBoundaries = new Set();
    const workflow = {
      sessionsStarted: 0,
      sessionsWithRequestBoundaries: 0,
      sessionsWithoutWorkflowEvidence: 0,
      requestBoundaries: 0,
      assistantResponses: 0,
      workflowStageEvents: 0,
      visibleCountUpdates: 0,
      automaticCodingTags: 0
    };
    for (const entry of events) {
      if (!entry || typeof entry !== "object") continue;
      const id = typeof entry.sessionId === "string" && SESSION_RE.test(entry.sessionId)
        ? entry.sessionId : null;
      if (entry.type === "visible_counts") workflow.visibleCountUpdates++;
      if (entry.type === "coding_tag" && entry.method === "automatic_on_start" &&
          entry.codingMarked === true) workflow.automaticCodingTags++;
      if (entry.type === "session_started" && id) startedSessions.add(id);
      if (entry.type === "request_boundary") {
        workflow.requestBoundaries++;
        if (id) sessionsWithRequestBoundaries.add(id);
      }
      if (entry.type === "assistant_response") workflow.assistantResponses++;
      if (entry.type === "workflow_stage" && STAGES.has(entry.stage))
        workflow.workflowStageEvents++;
      if (id && (entry.type === "request_boundary" ||
          entry.type === "assistant_response" ||
          (entry.type === "workflow_stage" && STAGES.has(entry.stage)) ||
          entry.type === "github_commit_ref"))
        sessionsWithWorkflowEvidence.add(id);
    }
    workflow.sessionsStarted = startedSessions.size;
    workflow.sessionsWithRequestBoundaries = [...startedSessions]
      .filter(id => sessionsWithRequestBoundaries.has(id)).length;
    workflow.sessionsWithoutWorkflowEvidence = [...startedSessions]
      .filter(id => !sessionsWithWorkflowEvidence.has(id)).length;

    // Compare what the content script found in each rendered assistant reply
    // with the commit references actually accepted by the background worker.
    // Counts only: do not echo response text, URLs, or opaque message IDs.
    const acceptedByResponse = new Map();
    for (const ref of refs) {
      if (ref.discovery !== "assistant" || typeof ref.sessionId !== "string" ||
          typeof ref.attribution?.responseId !== "string") continue;
      const key = ref.sessionId + ":" + ref.attribution.responseId;
      if (!acceptedByResponse.has(key)) acceptedByResponse.set(key, new Set());
      acceptedByResponse.get(key).add(ref.repository.toLowerCase() + "@" + ref.commitSha.toLowerCase());
    }
    const snapshots = new Map();
    for (const e of events) {
      if (e?.type !== "assistant_evidence" || typeof e.sessionId !== "string" ||
          typeof e.responseId !== "string" ||
          !Number.isInteger(e.observedCommitLinks) || e.observedCommitLinks < 0) continue;
      // A response is represented once, even in older files containing
      // multiple streaming snapshots for the same message.
      snapshots.set(e.sessionId + ":" + e.responseId, e);
    }
    const linkDelivery = {
      inspectedAssistantResponses: snapshots.size,
      responsesWithDetectedCommitLinks: 0,
      detectedCommitLinks: 0,
      responsesWithAcceptedCommitReferences: 0,
      responsesWithMissingCommitReferences: 0,
      responsesWithPartialCommitReferences: 0
    };
    for (const [response, snapshot] of snapshots) {
      const detected = snapshot.observedCommitLinks;
      const accepted = acceptedByResponse.get(response)?.size || 0;
      linkDelivery.detectedCommitLinks += detected;
      if (detected === 0) continue;
      linkDelivery.responsesWithDetectedCommitLinks++;
      if (accepted > 0) linkDelivery.responsesWithAcceptedCommitReferences++;
      if (accepted === 0) linkDelivery.responsesWithMissingCommitReferences++;
      else if (accepted < detected) linkDelivery.responsesWithPartialCommitReferences++;
    }

    return {
      workflow,
      linkDelivery,
      observedReferenceEvents: refs.length,
      distinctNonhistoricalReferencedCommits: eligibleKeys.size,
      distinctHistoricalReferencedCommits: historicalKeys.size,
      discovery,
      attribution,
      retrieval: { withTextPatches: retrievedWithPatches, metadataOnly, unavailable,
        notCached, identityMismatch, unknownStatus },
      note: "Diagnostics summarize recorded references and available public code patches. A mismatched cache identity cannot confirm code retrieval; manual imports and assistant references do not prove authorship."
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
      // Automatic session-level coding tags identify the recording mode, not
      // a new coding task. Only explicit tag events can serve as legacy signals.
      const relevant = (event.type === "workflow_stage" && STAGES.has(event.stage)) ||
        (event.type === "coding_tag" && event.codingMarked === true &&
          event.method !== "automatic_on_start") ||
        ["github_commit_ref", "request_boundary", "assistant_response", "assistant_evidence"].includes(event.type);
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
    const add = (key, label, type, task, referenceKey = null, path = null) => {
      if (!candidates.has(key))
        candidates.set(key, { id: key, label, type, tasks: new Set(), references: new Set(), evidence: new Map() });
      const p = candidates.get(key);
      p.tasks.add(task.id);
      if (path) p.evidence.set(task.id + ":" + referenceKey + ":" + path,
        { taskId: task.id, commitRef: referenceKey, path });
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
          const stored = commits[reference.key];
          const patchFile = stored?.files?.slice(0, 20).find(entry => entry.path === file.path);
          const signals = patchSignals(patchFile);
          if (!signals) continue;
          if (signals.testing)
            add("patch:testing", "Test files added or modified across tasks",
              "test_file_changes", task, reference.key, file.path);
          if (signals.errorHandling)
            add("patch:error-handling", "Guard or exception-handling syntax added across tasks",
              "error_handling_additions", task, reference.key, file.path);
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
            "same_file_in_distinct_commits", task, ref, file.slice(ref.split("@")[0].length + 1));
      }
    }

    const distinctCommitCount = pattern => new Set([...pattern.references].map(ref => ref.split("@")[1])).size;
    const patterns = [...candidates.values()]
      .filter(pattern => pattern.tasks.size >= 2 &&
        (!PATCH_PATTERN_TYPES.has(pattern.type) || distinctCommitCount(pattern) >= 2) &&
        (!['repository_recurrence', 'file_category_recurrence', 'test_request_with_commit'].includes(pattern.type) || pattern.references.size >= 2))
      .map(pattern => ({
        id: pattern.id, type: pattern.type, label: pattern.label,
        distinctTasks: pattern.tasks.size,
        supportingTaskIds: [...pattern.tasks].slice(0, MAX_MATCHES),
        supportingCommitRefs: [...pattern.references].slice(0, MAX_MATCHES),
        basis: PATCH_PATTERN_TYPES.has(pattern.type) ? "captured_patch_changes" : "observed_recurring_metadata",
        ...(PATCH_PATTERN_TYPES.has(pattern.type) ? {
          distinctCommits: distinctCommitCount(pattern),
          supportingEvidence: [...pattern.evidence.values()].slice(0, MAX_MATCHES),
          evidenceTruncated: pattern.evidence.size > MAX_MATCHES
        } : {}),
        verifiedOutcome: false,
        note: PATCH_PATTERN_TYPES.has(pattern.type)
          ? "Observed file changes or added syntax in captured patches; not proof of execution, intent, code quality or successful results."
          : "Repeated classifications of visible requests; not proof these actions were performed."
      }))
      .sort((a, b) => Number(PATCH_PATTERN_TYPES.has(b.type)) - Number(PATCH_PATTERN_TYPES.has(a.type)) ||
        b.distinctTasks - a.distinctTasks || a.id.localeCompare(b.id))
      .slice(0, MAX_PATTERNS);

    return {
      version: 2,
      captureDiagnostics: captureDiagnostics(events, commits),
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
