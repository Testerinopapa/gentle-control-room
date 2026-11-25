"use strict";

// Pure, reviewable outbound payload. Conversation excerpts appear only after
// the user explicitly captures a chat and reviews the Codex payload.

// The saved browser transcript is consulted only for the on-screen Codex review.
// No conversation text is added to automatic evidence exports or sent by scanning.
const CORRELATION_STOP = new Set((
  "a an and are as at be been but by can could did do does for from had has have " +
  "how i if in into is it its me my of on or our so that the their them there these " +
  "this those to was we were what when where which who why will with would you your " +
  "about after again all also already any before each even first get getting go just " +
  "make more much need now only other out please really some still than then there " +
  "through too use used using want work working yet github git code coding chatgpt " +
  "gentle control room extension browser project repo repository commit commits changes " +
  "change update updated push pushed main file files task tasks request requests fix " +
  "fixed issue problem done analyze analysis test tests"
).split(/\s+/));
const CORRELATION_KEY = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}@[a-f0-9]{40}$/i;
const CODING_INTENT = /\b(?:fix|implement|build|add|remove|replace|update|debug|install|installer|reinstall|native|codex|bridge|deploy|commit|push|error|issue|broken|analy[sz]|scan|capture|test|workflow|coding|code|extension|github|repository|repo|patch)\b/i;

function correlateWords(value) {
  const matches = String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  return new Set(matches.map(word => {
    if (/^reinstall(?:ed|ing)?$/.test(word) || /^install(?:er|ers|ation|ations|ed|ing)?$/.test(word))
      return "install";
    if (/^captur(?:e|ed|ing)$/.test(word)) return "capture";
    if (/^par(?:se|ser|sing|sed)$/.test(word)) return "parse";
    if (/^scann?(?:er|ing|ed|s)?$/.test(word)) return "scan";
    if (/^messag(?:e|es)$/.test(word)) return "message";
    if (/^retriev(?:e|al|ed|ing)$/.test(word)) return "retrieve";
    return word;
  }).filter(word => word.length > 2 && !CORRELATION_STOP.has(word)));
}
function conversationCommitRefs(message) {
  const refs = new Set();
  for (const ref of message?.github?.commits || []) {
    const key = String(ref?.repository || "").toLowerCase() + "@" +
      String(ref?.sha || "").toLowerCase();
    if (CORRELATION_KEY.test(key)) refs.add(key);
  }
  // Older saved snapshots may contain a displayed URL without structured hrefs.
  const text = String(message?.text || "");
  const regex = /https?:\/\/github\.com\/([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})\/commit\/([a-f0-9]{40})(?![a-f0-9])/gi;
  for (const match of text.matchAll(regex))
    refs.add(match[1].toLowerCase() + "@" + match[2].toLowerCase());
  return refs;
}
function correlateConversation(snapshot, commits) {
  if (!snapshot || !Array.isArray(snapshot.messages))
    return { available: false, requests: [], matchedRequests: 0, unmatchedCommits: Object.keys(commits).length,
      limitation: "No saved browser conversation for this ChatGPT tab; code evidence is still available." };
  const available = new Set(Object.keys(commits).filter(key => CORRELATION_KEY.test(key)));
  const descriptors = [...available].map(key => {
    const commit = commits[key], title = correlateWords(commit.message);
    const fileWords = correlateWords((commit.files || []).map(file => file.path).join(" "));
    return { key, title, fileWords };
  });
  const turns = [];
  for (const message of snapshot.messages.slice(-160)) {
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    if (message.role === "user") turns.push({ user: message, replies: [] });
    else if (turns.length) turns[turns.length - 1].replies.push(message);
  }
  const requests = [];
  for (const [index, turn] of turns.entries()) {
    const userText = String(turn.user.text || "").trim();
    const directUser = conversationCommitRefs(turn.user);
    const directReplies = new Set(turn.replies.flatMap(reply => [...conversationCommitRefs(reply)]));
    // A user may simply say "proceed"; an explicit commit in the assistant
    // response still belongs in the reviewed conversation linkage.
    if (!userText || (!CODING_INTENT.test(userText) &&
        !directUser.size && !directReplies.size)) continue;
    const requestedWords = correlateWords(userText.slice(0, 1600));
    const matches = [];
    for (const candidate of descriptors) {
      const { key, title, fileWords } = candidate;
      if (directReplies.has(key)) {
        matches.push({ commit: key, evidence: "commit_link_in_assistant_reply",
          confidence: "explicit_reference_not_authorship" });
        continue;
      }
      if (directUser.has(key)) {
        matches.push({ commit: key, evidence: "commit_link_in_user_request",
          confidence: "explicit_reference_not_authorship" });
        continue;
      }
      const titleHits = [...requestedWords].filter(term => title.has(term));
      const pathHits = [...requestedWords].filter(term => fileWords.has(term));
      const shared = [...new Set([...titleHits, ...pathHits])];
      // Two distinctive words are required. Mere repository membership,
      // timing, shared generic terms or a single matching filename never
      // becomes a claimed connection.
      if (shared.length < 2 || titleHits.length * 2 + pathHits.length < 3) continue;
      matches.push({ commit: key, evidence: "request_to_commit_topic_overlap",
        confidence: "possible_only", matchingTerms: shared.slice(0, 5),
        score: titleHits.length * 2 + pathHits.length });
    }
    matches.sort((a, b) =>
      Number(b.confidence === "explicit_reference_not_authorship") -
      Number(a.confidence === "explicit_reference_not_authorship") ||
      (b.score || 0) - (a.score || 0) || a.commit.localeCompare(b.commit));
    requests.push({
      turn: index + 1, request: userText.slice(0, 450),
      assistantReported: turn.replies.length
        ? String(turn.replies[turn.replies.length - 1].text || "").slice(0, 220)
        : null,
      candidateCommits: matches.slice(0, 3).map(({ score, ...match }) => match),
      matchTruncated: matches.length > 3
    });
  }
  // Prefer the most recent requests, preserving transcript ordering.
  const kept = requests.slice(-30);
  const matched = new Set(kept.flatMap(item => item.candidateCommits.map(match => match.commit)));
  return {
    available: true, capturedAt: snapshot.capturedAt || null,
    scanMayBeIncomplete: snapshot.truncated === true ||
      snapshot.orderUncertain === true || snapshot.coverage?.verifiedComplete !== true,
    requests: kept, matchedRequests: kept.filter(item => item.candidateCommits.length).length,
    unmatchedCommits: [...available].filter(key => !matched.has(key)).length,
    limitation: "Explicit links establish a conversation reference, not authorship or completion. Topic overlap is a suggestion only; browser turns have no verified historical timestamps. Tests and outcomes remain unverified."
  };
}

globalThis.GcrCodexEvidence = Object.freeze({
  build(exported, snapshot = null) {
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
        message: typeof commit.message === "string" ? commit.message.slice(0, 160) : "",
        committedAt: typeof commit.committedAt === "string" ? commit.committedAt.slice(0, 40) : null,
        files: commit.files.map(file => ({
          path: file.path, status: file.status,
          additions: file.additions, deletions: file.deletions,
          patch: file.patch
        }))
      };
    }
    const conversationCorrelation = correlateConversation(snapshot, commits);
    // Context-only reviews are useful when no task boundary/commit event was
    // captured; they must never claim verified source edits.
    if (!exported.analysis.tasks.length && !Object.keys(commits).length &&
        !conversationCorrelation.requests.length)
      throw new Error("No captured coding tasks, saved coding requests, or GitHub patches yet. Scan this conversation first.");
    const capturedRepos = new Set((snapshot?.messages || [])
      .flatMap(message => message.github?.repositories || [])
      .filter(repo => /^[a-z0-9-]{1,39}\\/[a-z0-9_.-]{1,100}$/i.test(repo)));
    const capturedLinks = new Set((snapshot?.messages || [])
      .flatMap(message => message.github?.commits || [])
      .map(ref => String(ref?.repository || "").toLowerCase() + "@" + String(ref?.sha || "").toLowerCase())
      .filter(ref => CORRELATION_KEY.test(ref)));
    const refs = (exported.events || []).filter(event => event?.type === "github_commit_ref");
    const records = Object.values(exported.commits);
    const unavailable = records.filter(record => record?.status === "unavailable").length;
    const metadataOnly = records.filter(record => record?.status === "metadata_only").length;
    const retrievalStatus = Object.keys(commits).length ? "retrieved_patches" :
      unavailable ? "github_fetch_failed" :
      metadataOnly ? "metadata_only_no_safe_patch" :
      !snapshot ? "conversation_not_captured_for_tab" :
      !capturedRepos.size && !capturedLinks.size ? "no_repository_or_commit_link_in_captured_chat" :
      !refs.length ? "github_references_not_recorded" : "no_retrieved_patches";
    const review = {
      source: "Gentle Control Room opt-in Edge evidence",
      analysis: {
        tasks: exported.analysis.tasks,
        patterns: exported.analysis.patterns,
        coverage: exported.analysis.coverage,
        limitations: exported.analysis.limitations
      },
      commits,
      conversationCorrelation,
      evidenceCoverage: {
        retrievedPatchCommits: Object.keys(commits).length,
        capturedRepositoryIdentities: capturedRepos.size,
        capturedCommitLinks: capturedLinks.size,
        recordedGitHubReferences: refs.length,
        failedPublicGitHubFetches: unavailable,
        metadataOnlyCommits: metadataOnly,
        retrievalStatus,
        limitation: "Conversation reports and stage labels do not verify edits, command execution, test results, or authorship. Public GitHub patches require a detectable repository or full commit URL and a successful accessible API response."
      }
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
      matchedRequests: review.conversationCorrelation.matchedRequests,
      retrievalStatus,
      bytes
    };
  }
});
