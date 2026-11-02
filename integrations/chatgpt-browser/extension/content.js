"use strict";
// Injected only after the user explicitly enables this ChatGPT conversation.
// Ordinary recording reads structural counts only. A separate explicit toggle
// allows ephemeral local classification of visible user requests. Neither mode
// exports raw message text, code, IDs, URLs or input field values.
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
  const seenMessages = new WeakSet();
  let workflowSent = 0;
  const maxWorkflowStages = 120;
  const seenCommitLinks = new Set();
  const pendingCommitLinks = new Set();
  const maxCommitLinks = 30;

  // Only href attributes of GitHub commit links in assistant turns are examined.
  // Never export assistant text, code, private conversation URLs, or arbitrary links.
  async function scanCommitLinks() {
    if (!workflowEnabled || stopped || seenCommitLinks.size >= maxCommitLinks) return;
    const region = document.querySelector('[data-app-action-timeline-scroll][role="region"]');
    const root = region || document;
    // ChatGPT can render its modern timeline without content-search-unit keys.
    // Try known assistant wrappers in order, always scoped to the active timeline
    // when present. Never inspect user-authored links.
    const assistantSelectors = [
      '[data-content-search-unit-key$=":assistant"]',
      '[data-message-author-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]'
    ];
    // Multiple wrapper families may coexist. Do not stop after the first
    // non-empty selector if that wrapper omits link elements.
    const units = new Set();
    for (const selector of assistantSelectors)
      for (const unit of Array.from(root.querySelectorAll(selector)).slice(-120))
        units.add(unit);
    for (const unit of Array.from(units).slice(-120)) {
      if (!workflowEnabled || stopped) break;
      if (typeof unit.querySelectorAll !== "function") continue;
      for (const anchor of Array.from(unit.querySelectorAll('a[href]')).slice(0, 30)) {
        if (!workflowEnabled || stopped || seenCommitLinks.size >= maxCommitLinks) break;
        const href = anchor.getAttribute?.("href");
        if (typeof href !== "string" || href.length > 300) continue;
        if (!/^https:\/\/github\.com\//i.test(href)) continue;
        let url;
        try { url = new URL(href, "https://chatgpt.com"); } catch { continue; }
        if (url.origin !== "https://github.com" || url.search || url.hash) continue;
        const match = /^\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})\/commit\/([a-f0-9]{40})\/?$/i.exec(url.pathname);
        if (!match) continue;
        const repository = (match[1] + "/" + match[2]).toLowerCase();
        const sha = match[3].toLowerCase();
        const key = repository + "@" + sha;
        if (seenCommitLinks.has(key) || pendingCommitLinks.has(key)) continue;
        pendingCommitLinks.add(key);
        try {
          const result = await chrome.runtime.sendMessage({ type: "githubCommitReference", repository, sha });
          if (result?.ok && workflowEnabled && !stopped) seenCommitLinks.add(key);
        } catch {
          // Failed deliveries remain retryable; never send original href or page content.
        } finally { pendingCommitLinks.delete(key); }
      }
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

  function categorize(text) {
    const excerpt = text.slice(0, 2400);
    for (const [category, pattern] of workflowCategories) {
      if (pattern.test(excerpt)) return category;
    }
    return null;
  }

  function userMessages() {
    const region = document.querySelector('[data-app-action-timeline-scroll][role="region"]');
    const root = region || document;
    // The modern timeline sometimes uses role markers without bubble markers.
    for (const selector of [
      '[data-user-message-bubble="true"]',
      '[data-content-search-unit-key$=":user"]',
      '[data-message-author-role="user"]',
      'article[data-turn="user"]',
      '[data-role="user"]',
      '[data-message-author="user"]'
    ]) {
      const units = root.querySelectorAll(selector);
      if (units.length) return units;
    }
    return [];
  }

  async function scanWorkflow() {
    if (!workflowEnabled || stopped || workflowSent >= maxWorkflowStages) return;
    // Bound the scan; only the 120 most recent mounted user messages are read.
    const units = Array.from(userMessages()).slice(-120);
    for (const unit of units) {
      if (!workflowEnabled || stopped || workflowSent >= maxWorkflowStages) break;
      if (seenMessages.has(unit)) continue;
      seenMessages.add(unit);
      // Read only visible user-message text, transiently, and only while the
      // user enabled workflow analysis for this specific conversation.
      const stage = categorize(String(unit.innerText ?? unit.textContent ?? ""));
      if (!stage) continue;
      try {
        const result = await chrome.runtime.sendMessage({ type: "workflowStage", stage });
        if (result?.ok) workflowSent++;
        // Failed delivery is not retried for a message to avoid duplicate writes.
      } catch {
        // No message text, exceptions or DOM identifiers leave this content script.
      }
    }
  }

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
      // Do not mark an update as delivered until the native host confirms it.
      // Transient native errors are retried on the next timer tick.
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
    if (workflowEnabled) { void scanWorkflow(); void scanCommitLinks(); }
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
      workflowEnabled = message.enabled;
      if (workflowEnabled) { void scanWorkflow(); void scanCommitLinks(); }
    }
  }

  let debounce = null;
  const observer = new MutationObserver(() => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(poll, 250);
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true,
    attributeFilter: [
      "data-message-author-role", "data-turn",
      "data-user-message-bubble", "data-content-search-unit-key",
      "role", "data-app-action-timeline-scroll"
    ]
  });
  const ticker = setInterval(poll, 1500);
  chrome.runtime.onMessage.addListener(onCommand);
  globalThis.__gcrChatGPTObserver = { stop };
  poll();
})();
