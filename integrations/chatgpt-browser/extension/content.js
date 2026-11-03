"use strict";
// Injected only after the user starts recording this ChatGPT conversation.
// Local classification and complete rendered-response scanning run under this
// one opt-in. Raw message text and code never leave the content script.
(() => {
  if (globalThis.__gcrChatGPTObserver) globalThis.__gcrChatGPTObserver.stop();

  const pathname = location.pathname;
  const statusEveryMs = 12000;
  const countIntervalMs = 3000;
  let stopped = false;
  let lastAcknowledged = null;
  let lastDetector = null;
  let lastStatusAt = 0;
  let nextCountAt = 0;
  let countInFlight = false;
  let statusInFlight = false;
  // Deeper analysis is a separate explicit opt-in and is never enabled by
  // ordinary Start. Text is inspected inside the webpage process only.
  let workflowEnabled = false;
  let workflowSent = 0;
  const maxWorkflowStages = 120;
  const seenCommitLinks = new Set();
  const baselineCommitLinks = new Set();
  const maxCommitLinks = 30;
  let newCommitLinks = 0, historicalCommitLinks = 0;
  const identities = new Map();
  let nodes = new WeakMap();
  let workflowEpoch = 0;
  const prefix = "m-" + Math.random().toString(36).slice(2, 12);
  let serial = 0, scanning = false, scanAgain = false;
  let baselinePending = false, frontier = null;
  const roleSelectors = role => [
    `[data-content-search-unit-key$=":${role}"]`,
    `[data-message-author-role="${role}"]`, `article[data-turn="${role}"]`,
    `[data-role="${role}"]`, `[data-message-author="${role}"]`,
    ...(role === "user" ? ['[data-user-message-bubble="true"]'] : [])
  ].join(",");

  function units() {
    const root = document.querySelector('[data-app-action-timeline-scroll][role="region"]') || document;
    const selector = roleSelectors("user") + "," + roleSelectors("assistant");
    // Select the outermost matching turn, not the innermost text wrapper:
    // assistant replies may have links/code blocks OUTSIDE the inner body.
    // Ignore nested matches to avoid generating duplicate message identities.
    const found = Array.from(root.querySelectorAll(selector));
    const matches = new Set(found);
    return found.filter(node => {
      for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (matches.has(parent)) return false;
      }
      return true;
    }).slice(-240);
  }
  function identity(node, role) {
    if (nodes.has(node)) return nodes.get(node);
    const wrapper = node.closest('[data-message-id], [data-content-search-unit-key], [data-turn-id], article[id]');
    const raw = wrapper && ["data-message-id", "data-content-search-unit-key", "data-turn-id", "id"]
      .map(name => wrapper.getAttribute(name)).find(Boolean);
    // Raw page identifiers never leave this ephemeral map or enter storage.
    let fingerprint = 2166136261;
    const text = role === "user" ? String(node.innerText ?? node.textContent ?? "").slice(0, 2400) : "";
    for (const char of text) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
    const key = raw ? role + ":" + raw : text ? role + ":fallback:" + (fingerprint >>> 0) : null;
    let record = key && identities.get(key);
    if (!record) {
      record = { id: prefix + "-" + (++serial), stable: Boolean(raw), role,
        historical: baselinePending, sent: false, stages: new Set(), taskId: null,
        lastEvidenceSignature: null, lastEvidenceAt: 0,
        lastAcknowledgedCommitCount: 0, observedCommitKeys: new Set() };
      if (key && identities.size < 1000) identities.set(key, record);
    }
    nodes.set(node, record);
    return record;
  }
  // Scan every accessible link and the COMPLETE rendered message text,
  // including code blocks. Only validated GitHub owner/repo/SHA pairs cross
  // the extension boundary; neither raw text nor other URLs are transmitted.
  const COMMIT_URL = /https:\/\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}\/commit\/[a-f0-9]{40}\b/gi;
  function commitIdentifiers(node) {
    const references = new Map();
    const add = href => {
      if (typeof href !== "string" || references.size >= maxCommitLinks) return;
      let url;
      try { url = new URL(href.trim()); } catch { return; }
      if (url.origin !== "https://github.com" || url.search || url.hash) return;
      const match = /^\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})\/commit\/([a-f0-9]{40})\/?$/i.exec(url.pathname);
      if (!match) return;
      const repository = (match[1] + "/" + match[2]).toLowerCase(), sha = match[3].toLowerCase();
      references.set(repository + "@" + sha, { repository, sha });
    };
    for (const anchor of node.querySelectorAll("a[href], [data-href], [data-url]")) {
      add(anchor.getAttribute("href"));
      add(anchor.getAttribute("data-href"));
      add(anchor.getAttribute("data-url"));
      if (references.size >= maxCommitLinks) break;
    }
    const visible = String(node.innerText ?? node.textContent ?? "");
    for (const match of visible.matchAll(COMMIT_URL)) {
      add(match[0]);
      if (references.size >= maxCommitLinks) break;
    }
    return [...references.values()];
  }
  function assistantMetadata(node, commitLinks) {
    // Whitelisted labels and counts only. No response, source code, commands,
    // file paths, or arbitrary URLs leave this content script.
    const text = String(node.innerText ?? node.textContent ?? "");
    const blocks = Math.max(
      node.querySelectorAll("pre").length,
      node.querySelectorAll('[data-testid="code-block"]').length
    );
    const mentionedStages = workflowCategories
      .filter(([, expression]) => expression.test(text))
      .map(([stage]) => stage);
    const commandPatterns = [
      ["git", /^\s*(?:\$\s*)?git\s+/mi],
      ["npm", /^\s*(?:\$\s*)?npm\s+/mi],
      ["npx", /^\s*(?:\$\s*)?npx\s+/mi],
      ["pnpm", /^\s*(?:\$\s*)?pnpm\s+/mi],
      ["yarn", /^\s*(?:\$\s*)?yarn\s+/mi],
      ["node", /^\s*(?:\$\s*)?node\s+/mi],
      ["python", /^\s*(?:\$\s*)?(?:python|python3)\s+/mi],
      ["pytest", /^\s*(?:\$\s*)?pytest(?:\s+|$)/mi],
      ["docker", /^\s*(?:\$\s*)?docker\s+/mi],
      ["dotnet", /^\s*(?:\$\s*)?dotnet\s+/mi],
      ["powershell", /^\s*(?:\$\s*)?(?:pwsh|powershell)\s+/mi]
    ];
    const code = Array.from(node.querySelectorAll("pre"), element =>
      String(element.innerText ?? element.textContent ?? "")).join("\n");
    const commandFamilies = commandPatterns.filter(([, pattern]) =>
      pattern.test(code)).map(([family]) => family);
    return {
      observedCharacters: Math.min(text.length, 10000000),
      observedCodeBlocks: Math.min(blocks, 1000),
      observedCommitLinks: Math.min(commitLinks, maxCommitLinks),
      mentionedStages,
      commandFamilies
    };
  }
  function validPage() { return !stopped && workflowEnabled && location.pathname === pathname; }
  async function scanEvidence() {
    if (!validPage()) return;
    if (scanning) { scanAgain = true; return; }
    scanning = true;
    const epoch = workflowEpoch;
    const active = () => validPage() && epoch === workflowEpoch;
    try {
      const entries = units().map(node => {
        const role = node.matches(roleSelectors("user")) ? "user" : "assistant";
        return { node, record: identity(node, role) };
      });
      for (const { record } of entries) record.newlySupported = false;
      const isBaseline = baselinePending;
      if (isBaseline) for (const { node, record } of entries) {
        if (record.role !== "assistant") continue;
        for (const ref of commitIdentifiers(node))
          if (baselineCommitLinks.size < 2000) baselineCommitLinks.add(ref.repository + "@" + ref.sha);
      }
      baselinePending = false;
      let previous = null, lastRequest = null;
      for (const { node, record } of entries) {
        if (!active()) break;
        if (record.role === "user") {
          if (!record.sent && !record.historical && workflowSent < maxWorkflowStages) {
            // A request appended after an already observed turn is a supported
            // boundary. Newly mounted history and identifier-free replacements
            // remain uncertain. No message text is persisted.
            const supported = record.stable && previous?.record.stable &&
              (previous.record.id === frontier || previous.record.newlySupported === true);
            record.newlySupported = supported;
            record.taskId = record.id;
            const reply = await chrome.runtime.sendMessage({ type: "requestBoundary",
              requestId: record.id, confidence: supported ? "supported" : "uncertain" });
            if (!active()) break;
            if (reply?.ok) { record.sent = true; workflowSent++; }
          }
          if (record.sent && !record.historical) {
            const text = String(node.innerText ?? node.textContent ?? "").slice(0, 2400);
            const stages = workflowCategories.flatMap(([stage, pattern]) =>
              Array.from(text.matchAll(new RegExp(pattern.source, "gi")), match => ({ stage, index: match.index })))
              .sort((a, b) => a.index - b.index).filter((match, index, matches) => !index || match.stage !== matches[index - 1].stage)
              .slice(0, 20);
            for (const [ordinal, { stage }] of stages.entries()) {
              const key = ordinal + ":" + stage;
              if (!active() || record.stages.has(key)) continue;
              const reply = await chrome.runtime.sendMessage({ type: "workflowStage", stage, ordinal, requestId: record.id });
              if (reply?.ok) record.stages.add(key);
            }
          }
        } else {
          if (!record.sent) {
            const request = lastRequest;
            record.taskId = !record.historical && record.stable && request?.role === "user" &&
              !request.historical && request.sent ? request.taskId : null;
            const reply = await chrome.runtime.sendMessage({ type: "assistantBoundary",
              responseId: record.id, requestId: record.taskId,
              historical: record.historical });
            if (reply?.ok) record.sent = true;
          }
          const commitRefs = commitIdentifiers(node);
          // Keep a bounded union across streaming updates: a link may appear
          // before ChatGPT rerenders the response with a different DOM shape.
          for (const { repository, sha } of commitRefs) {
            if (record.observedCommitKeys.size < maxCommitLinks)
              record.observedCommitKeys.add(repository + "@" + sha);
          }
          const pending = [];
          // Retry ALL links observed in this assistant turn, even when a
          // streaming rerender has since removed one from the live DOM.
          // Keep the historical baseline and per-response quotas unchanged.
          for (const reference of record.observedCommitKeys) {
            if (!active()) break;
            const [repository, sha] = reference.split("@");
            const historical = baselineCommitLinks.has(reference);
            // Exhausting one quota must not starve valid links in the other.
            if ((historical ? historicalCommitLinks : newCommitLinks) >= maxCommitLinks) continue;
            const key = record.id + ":" + repository + "@" + sha;
            if (!seenCommitLinks.has(key))
              pending.push({ repository, sha, historical, key });
          }
          if (pending.length && active()) {
            try {
              const reply = await chrome.runtime.sendMessage({
                type: "githubCommitReferences", responseId: record.id,
                links: pending.map(({ repository, sha, historical }) =>
                  ({ repository, sha, historical }))
              });
              if (reply?.ok && active() && Array.isArray(reply.accepted)) {
                for (const [index, accepted] of reply.accepted.entries()) {
                  if (accepted !== true || !pending[index]) continue;
                  const item = pending[index];
                  seenCommitLinks.add(item.key);
                  if (item.historical) historicalCommitLinks++; else newCommitLinks++;
                }
              }
            } catch {
              // A failed batch is retried on the next scan, without dropping
              // later links or accidentally marking an unacknowledged link seen.
            }
          }
          if (!record.historical && record.sent) {
            const metadata = assistantMetadata(node, record.observedCommitKeys.size);
            const signature = Object.values(metadata).join(":");
            const now = Date.now();
            // Update a single stored snapshot per response during streaming;
            // avoid flooding storage for every emitted token.
            if (signature !== record.lastEvidenceSignature &&
                (metadata.observedCommitLinks > record.lastAcknowledgedCommitCount ||
                 !record.lastEvidenceAt || now - record.lastEvidenceAt >= 1200)) {
              const reply = await chrome.runtime.sendMessage({
                type: "assistantEvidence", responseId: record.id, ...metadata
              });
              if (reply?.ok && active()) {
                record.lastEvidenceSignature = signature;
                record.lastEvidenceAt = now;
                record.lastAcknowledgedCommitCount = metadata.observedCommitLinks;
              }
            }
          }
        }
        if (isBaseline || record.historical) record.sent = true;
        if (record.role === "user") lastRequest = record;
        previous = { node, record };
      }
      if (active()) frontier = entries.at(-1)?.record.id || frontier;
    } catch { /* A changing DOM or unavailable worker is retried without logging text. */ }
    finally {
      scanning = false;
      if (scanAgain) { scanAgain = false; void scanEvidence(); }
    }
  }

  const workflowCategories = Object.freeze([
    ["debugging", /\b(?:debug|bug|exception|stack\s*trace|traceback|broken|error|errors|fail(?:ed|ing|ure|s)?|not\s+working|doesn.t\s+work|fix\s+(?:the\s+)?(?:issue|problem|error|bug))\b/i],
    ["version_control", /\b(?:git|commit|pull\s+request|merge|rebase|cherry.pick|branch|push\s+to\s+(?:main|remote)|sync\s+(?:local|remote))\b/i],
    ["deployment", /\b(?:deploy|deployment|release|publish\s+to\s+(?:production|staging)|production\s+rollout|hosting|go\s+live)\b/i],
    ["testing", /\b(?:tests?|testing|unit\s+tests?|integration\s+tests?|regression|lint|build\s+check|verify|validate|quality\s+checks?|run\s+checks?)\b/i],
    ["implementation", /\b(?:implement|implementation|add|create|build|modify|edit|refactor|remove|integrate|wire|develop|write|update|configure|set\s*up|replace|change)\b/i],
    ["investigation", /\b(?:inspect|investigate|analy[sz]e|review|explain|understand|diagnos[ei]|look\s+into|find\s+out|what\s+causes|why\s+(?:does|is|are))\b/i]
  ]);

  // ChatGPT changed its DOM in 2026. Current conversations place messages
  // inside a visible timeline region, with user/assistant units as siblings.
  // The timeline scope also excludes a hidden, duplicated navigation timeline.
  function readCounts() {
    const region = document.querySelector(
      '[data-app-action-timeline-scroll][role="region"]'
    );
    if (region) {
      const bubbles = region.querySelectorAll('[data-user-message-bubble="true"]').length;
      const userUnits = region.querySelectorAll('[data-content-search-unit-key$=":user"]').length;
      const assistantUnits = region.querySelectorAll('[data-content-search-unit-key$=":assistant"]').length;
      // Structural detection only: do not inspect code text, filenames or languages.
      const codeBlocks = Math.max(
        region.querySelectorAll("pre").length,
        region.querySelectorAll('[data-testid="code-block"]').length
      );
      return {
        user: Math.min(bubbles || userUnits, 10000),
        assistant: Math.min(assistantUnits, 10000),
        codeBlocks: Math.min(codeBlocks, 10000),
        detector: (bubbles || userUnits || assistantUnits) ? "current" : "waiting"
      };
    }

    // Earlier ChatGPT UI: select exactly one matching family per role to avoid
    // double-counting nested article and message wrappers. Never read content.
    const firstCount = (selectors) => {
      for (const selector of selectors) {
        const count = document.querySelectorAll(selector).length;
        if (count > 0) return Math.min(count, 10000);
      }
      return 0;
    };
    const user = firstCount([
      '[data-message-author-role="user"]',
      'article[data-turn="user"]',
      '[data-role="user"]',
      '[data-message-author="user"]'
    ]);
    const assistant = firstCount([
      '[data-message-author-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]'
    ]);
    return {
      user, assistant,
      // Legacy layout: preformatted code containers; not inline `code` elements.
      codeBlocks: Math.min(document.querySelectorAll("pre").length, 10000),
      detector: user || assistant ? "legacy" : "unsupported"
    };
  }

  async function reportStatus(detector) {
    const now = Date.now();
    if (statusInFlight || (detector === lastDetector && now - lastStatusAt < statusEveryMs)) return;
    statusInFlight = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "observerStatus", detector });
      if (reply?.ok) {
        lastDetector = detector;
        lastStatusAt = Date.now();
      }
    } catch {
      // The sidebar exposes missing observer updates; never log page information.
    } finally {
      statusInFlight = false;
    }
  }

  async function reportCounts(counts) {
    if (stopped || countInFlight) return;
    const now = Date.now();
    const signature = counts.detector + ":" + counts.user + ":" +
      counts.assistant + ":" + counts.codeBlocks;
    if (signature === lastAcknowledged || now < nextCountAt) return;
    countInFlight = true;
    nextCountAt = now + countIntervalMs;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: "visibleCounts",
        user: counts.user,
        assistant: counts.assistant,
        codeBlocks: counts.codeBlocks
      });
      // Retry transient worker delivery errors on the next timer tick.
      if (reply?.ok && !stopped) lastAcknowledged = signature;
    } catch {
      // Never output or transmit page content when the collector is unavailable.
    } finally {
      countInFlight = false;
    }
  }

  function poll() {
    if (stopped) return;
    if (location.pathname !== pathname) {
      void chrome.runtime.sendMessage({ type: "conversationChanged" }).catch(() => {});
      stop();
      return;
    }

    const counts = readCounts();
    void reportStatus(counts.detector);
    if (counts.detector === "current" || counts.detector === "legacy")
      void reportCounts(counts);
    // Do not block consented workflow/commit evidence because a cosmetic
    // message-count detector failed to recognize ChatGPT's latest DOM.
    if (workflowEnabled) { void scanEvidence(); }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    workflowEnabled = false;
    observer.disconnect();
    clearInterval(ticker);
    clearTimeout(debounce);
    chrome.runtime.onMessage.removeListener(onCommand);
    if (globalThis.__gcrChatGPTObserver?.stop === stop) {
      delete globalThis.__gcrChatGPTObserver;
    }
  }
  function onCommand(message) {
    if (message?.type === "gcrStop") stop();
    if (message?.type === "gcrWorkflowMode" && typeof message.enabled === "boolean") {
      if (message.enabled === workflowEnabled) return;
      workflowEpoch++;
      if (message.enabled) {
        baselinePending = true; frontier = null;
        identities.clear(); nodes = new WeakMap();
      }
      workflowEnabled = message.enabled;
      if (workflowEnabled) { void scanEvidence(); }
    }
  }

  let debounce = null;
  const observer = new MutationObserver(() => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(poll, 250);
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true,
    attributeFilter: [
      "href", "data-message-id", "data-role", "data-message-author", "data-message-author-role", "data-turn",
      "data-user-message-bubble", "data-content-search-unit-key",
      "role", "data-app-action-timeline-scroll"
    ]
  });
  const ticker = setInterval(poll, 1500);
  chrome.runtime.onMessage.addListener(onCommand);
  globalThis.__gcrChatGPTObserver = { stop };
  poll();
})();
