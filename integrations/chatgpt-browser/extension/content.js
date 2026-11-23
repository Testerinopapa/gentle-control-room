"use strict";
// Injected only after the user starts recording this ChatGPT conversation.
// Local classification and complete rendered-response scanning run under this
// one opt-in. Raw chat text is exposed only through an additional explicit
// "Capture conversation" action; ordinary recording never exports the transcript.
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
  // Start also classifies already-rendered history locally. Raw message
  // text never leaves the content script.
  let workflowEnabled = false;
  let workflowSent = 0;
  const maxWorkflowStages = 120;
  const maxHistoryRequests = 60;
  let historicalRequests = 0;
  let historicalStages = 0;
  const maxHistoricalStages = 40;
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
  // Accumulate distinct turns seen during scrolling, even when ChatGPT later
  // unloads them from its virtualized message list.
  const rememberedTurns = [];
  let uncertainTurnOrder = false;
  let scanningOlderHistory = false;
  let turnCaptureLimited = false;
  const roleSelectors = role => [
    `[data-content-search-unit-key$=":${role}"]`,
    `[data-chatgpt-search-unit-key$=":${role}"]`,
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
    const wrapper = node.closest('[data-message-id], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-turn-id], article[id]');
    const raw = wrapper && ["data-message-id", "data-content-search-unit-key", "data-chatgpt-search-unit-key", "data-turn-id", "id"]
      .map(name => wrapper.getAttribute(name)).find(Boolean);
    // Raw page identifiers never leave this ephemeral map or enter storage.
    let fingerprint = 2166136261;
    const text = role === "user" ? String(node.innerText ?? node.textContent ?? "").slice(0, 2400) : "";
    for (const char of text) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
    const key = raw ? role + ":" + raw : text ? role + ":fallback:" + (fingerprint >>> 0) : null;
    let record = key && identities.get(key);
    if (!record) {
      record = { id: prefix + "-" + (++serial), stable: Boolean(raw), role,
        historical: baselinePending || scanningOlderHistory, sent: false, stages: new Set(), taskId: null,
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
    // Some ChatGPT link controls expose their target through accessible
    // attributes rather than an <a href>. Inspect only link-like elements,
    // and retain only validated public GitHub owner/repo/SHA references.
    for (const link of node.querySelectorAll(
      'a, [role="link"], [data-href], [data-url], [data-clipboard-text]'
    )) {
      for (const attribute of ["href", "data-href", "data-url",
        "data-clipboard-text", "aria-label", "title"]) {
        const value = link.getAttribute(attribute);
        if (!value) continue;
        add(value);
        // Labels often contain surrounding text rather than just a URL.
        for (const match of value.matchAll(COMMIT_URL)) {
          add(match[0]);
          if (references.size >= maxCommitLinks) break;
        }
        if (references.size >= maxCommitLinks) break;
      }
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
          if (!record.sent && workflowSent < maxWorkflowStages &&
              (!record.historical || historicalRequests < maxHistoryRequests)) {
            // A request appended after an already observed turn is a supported
            // boundary. Newly mounted history and identifier-free replacements
            // remain uncertain. No message text is persisted.
            const supported = record.stable && previous?.record.stable &&
              (previous.record.id === frontier || previous.record.newlySupported === true);
            record.newlySupported = supported;
            record.taskId = record.id;
            const reply = await chrome.runtime.sendMessage({ type: "requestBoundary",
              requestId: record.id, historical: record.historical,
              confidence: supported ? "supported" : "uncertain" });
            if (!active()) break;
            if (reply?.ok) {
              record.sent = true; workflowSent++;
              if (record.historical) historicalRequests++;
            }
          }
          if (record.sent) {
            const text = String(node.innerText ?? node.textContent ?? "").slice(0, 2400);
            const stages = workflowCategories.flatMap(([stage, pattern]) =>
              Array.from(text.matchAll(new RegExp(pattern.source, "gi")), match => ({ stage, index: match.index })))
              .sort((a, b) => a.index - b.index).filter((match, index, matches) => !index || match.stage !== matches[index - 1].stage)
              .slice(0, 20);
            for (const [ordinal, { stage }] of stages.entries()) {
              const key = ordinal + ":" + stage;
              if (!active() || record.stages.has(key) ||
                  (record.historical && historicalStages >= maxHistoricalStages)) continue;
              const reply = await chrome.runtime.sendMessage({ type: "workflowStage", stage, ordinal, requestId: record.id });
              if (reply?.ok) {
                record.stages.add(key);
                if (record.historical) historicalStages++;
              }
            }
          }
        } else {
          if (!record.sent) {
            const request = lastRequest;
            record.taskId = record.stable && request?.role === "user" &&
              request.historical === record.historical && request.sent ? request.taskId : null;
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
            const historical = record.historical || baselineCommitLinks.has(reference);
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
          if (record.sent) {
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
    if (workflowEnabled) { globalThis.GcrLiveArchiverReader?.observe(); rememberRenderedTurns(); void scanEvidence(); }
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
  function cleanRenderedText(role, value) {
    const text = String(value ?? "").trim();
    // The accessible speaker label is not reply content. Drop it even when
    // no newline follows, and skip empty placeholder turns altogether.
    return role === "assistant"
      ? text.replace(/^(?:ChatGPT said:\s*)+/i, "").trim()
      : role === "user" ? text.replace(/^(?:You said:\s*)+/i, "").trim() : text;
  }
  function capturedTurnKey(node, role, text) {
    const wrapper = node.closest('[data-message-id], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-turn-id], article[id]') || node;
    const raw = ["data-message-id", "data-content-search-unit-key", "data-chatgpt-search-unit-key", "data-turn-id", "id"]
      .map(name => wrapper.getAttribute(name)).find(Boolean);
    if (raw) return role + ":" + raw.slice(0, 180);
    let hash = 2166136261;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return role + ":fallback:" + (hash >>> 0).toString(36) + ":" + text.length;
  }
  function mergeObservedTurns(existing, incoming) {
    if (!incoming.length) return;
    const known = new Set(existing.map(item => item.key));
    if (!existing.length) { existing.push(...incoming); return; }
    if (!incoming.some(item => known.has(item.key))) {
      // A disconnected window has uncertain order. Newly rendered windows
      // while scrolling upward are usually earlier than the saved window.
      existing.unshift(...incoming.filter(item => !known.has(item.key)));
      uncertainTurnOrder = true;
      return;
    }
    let previousIndex = -1;
    for (let i = 0; i < incoming.length; i++) {
      const item = incoming[i];
      const at = existing.findIndex(saved => saved.key === item.key);
      if (at >= 0) {
        if (item.text.length >= existing[at].text.length)
          existing[at].text = item.text;
        previousIndex = at;
        continue;
      }
      const next = incoming.slice(i + 1)
        .map(nextItem => existing.findIndex(saved => saved.key === nextItem.key))
        .find(index => index >= 0);
      const insertion = next !== undefined ? next :
        previousIndex >= 0 ? previousIndex + 1 : 0;
      existing.splice(insertion, 0, item);
      previousIndex = insertion;
    }
  }
  function rememberRenderedTurns() {
    if (!validPage()) return;
    const incoming = [];
    for (const node of units().slice(-160)) {
      const role = node.matches(roleSelectors("user")) ? "user" : "assistant";
      const full = cleanRenderedText(role, node.innerText ?? node.textContent ?? "");
      if (!full) continue;
      const text = full.slice(0, 8000);
      if (full.length > text.length) turnCaptureLimited = true;
      incoming.push({ role, text, key: capturedTurnKey(node, role, text) });
    }
    mergeObservedTurns(rememberedTurns, incoming);
    let total = rememberedTurns.reduce((sum, item) => sum + item.text.length, 0);
    while (rememberedTurns.length > 160 || total > 350000) {
      const removed = rememberedTurns.splice(Math.floor(rememberedTurns.length / 2), 1)[0];
      total -= removed.text.length;
      turnCaptureLimited = true;
    }
  }
  // A separate, user-triggered read of actual rendered ChatGPT turns.
  // This is NOT an API/history fetch. Unmounted messages are inaccessible.
  function chatScrollHost() {
    const timeline = document.querySelector(
      '[data-app-action-timeline-scroll][role="region"]');
    let candidate = timeline;
    while (candidate && candidate !== document.documentElement) {
      if (candidate.scrollHeight > candidate.clientHeight + 60 &&
          candidate.clientHeight > 100) return candidate;
      candidate = candidate.parentElement;
    }
    const page = document.scrollingElement;
    return page && page.scrollHeight > page.clientHeight + 60 ? page : null;
  }

  async function scanOlderBrowserTurns() {
    const scrolling = chatScrollHost();
    if (!scrolling) return;
    const oldTop = scrolling.scrollTop;
    const wasNearBottom = scrolling.scrollHeight - scrolling.clientHeight - oldTop < 100;
    let lastSeen = rememberedTurns.length, stale = 0;
    scanningOlderHistory = true;
    try {
      // Browsers with a virtualized ChatGPT timeline may only render earlier
      // turns after scrolling up. Inspect each window, not an undocumented API.
      for (let step = 0; step < 36 && validPage(); step++) {
        const before = scrolling.scrollTop;
        scrolling.scrollTop = Math.max(0, before -
          Math.max(350, Math.floor(scrolling.clientHeight * 0.85)));
        await new Promise(resolve => setTimeout(resolve, 180));
        if (!validPage()) break;
        rememberRenderedTurns();
        if (rememberedTurns.length > lastSeen) {
          stale = 0;
          lastSeen = rememberedTurns.length;
        } else stale++;
        if (stale >= 4 && (scrolling.scrollTop <= 2 ||
            Math.abs(scrolling.scrollTop - before) < 3)) break;
      }
    } finally {
      if (validPage()) {
        scrolling.scrollTop = wasNearBottom ? scrolling.scrollHeight : oldTop;
        rememberRenderedTurns();
      }
      scanningOlderHistory = false;
    }
  }

  // A second, independent DOM view catches legacy assistant bodies whose
  // modern message-unit wrapper only renders the accessibility heading. Use
  // matching user prompts as anchors so recovered replies sit in their turn.
  function supplementAssistantReplies(primary) {
    const messages = primary.slice();
    let recovered = 0;
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    // Detached DOM textContent joins words across element boundaries, whereas
    // the primary reader restores line breaks. Treat only equal alphanumeric
    // content as the same assistant reply, without discarding distinct replies.
    const compact = value => normalize(value).replace(/[^\p{L}\p{N}]/gu, "");
    const indexOfUser = value => messages.findIndex(item =>
      item.role === "user" && normalize(item.text) === normalize(value));
    for (let i = 0; i < rememberedTurns.length; i++) {
      const item = rememberedTurns[i];
      if (item.role !== "assistant" || !item.text.trim()) continue;
      let preceding = null;
      for (let j = i - 1; j >= 0; j--) {
        if (rememberedTurns[j].role === "user") { preceding = rememberedTurns[j]; break; }
      }
      if (!preceding) continue;
      const userIndex = indexOfUser(preceding.text);
      if (userIndex < 0) continue;
      const nextUser = messages.findIndex((row, index) =>
        index > userIndex && row.role === "user");
      const after = nextUser < 0 ? messages.length : nextUser;
      const answer = normalize(item.text);
      // A message-unit parser can return the full response while the legacy
      // collector returns just an inner paragraph. Don't duplicate it.
      const existing = messages.slice(userIndex + 1, after).findIndex(row => {
        if (row.role !== "assistant") return false;
        const current = normalize(row.text);
        return current === answer || compact(current) === compact(answer) ||
          (answer.length >= 35 && (current.includes(answer) || answer.includes(current)));
      });
      if (existing >= 0) {
        const position = userIndex + 1 + existing;
        if (answer.length > normalize(messages[position].text).length) {
          messages[position] = { role: "assistant", text: item.text, key: item.key,
            ...(messages[position].github ? { github: messages[position].github } : {}) };
          recovered++;
        }
        continue;
      }
      messages.splice(after, 0, { role: "assistant", text: item.text, key: item.key,
        ...(item.github ? { github: item.github } : {}) });
      recovered++;
    }
    return { messages, recovered };
  }

  async function capturedConversation() {
    if (!validPage()) return { ok: false, error: "Start recording this conversation first." };
    // Use the Live Archiver-derived top/down DOM collector for the transcript.
    // Existing workflow classification and commit analysis stay independent.
    if (globalThis.GcrLiveArchiverReader) {
      const result = await globalThis.GcrLiveArchiverReader.collect(validPage, rememberRenderedTurns);
      if (!result.ok) return result;
      if (result.messages.length) {
        const merged = supplementAssistantReplies(result.messages);
        result.messages = merged.messages;
        result.coverage = { ...result.coverage,
          supplementalReplies: merged.recovered };
        // Do not submit an oversized transcript to extension storage.
        let chars = result.messages.reduce((sum, row) => sum + row.text.length, 0);
        while (result.messages.length > 160 || chars > 350000) {
          const removed = result.messages.splice(Math.floor(result.messages.length / 2), 1)[0];
          chars -= removed.text.length;
          result.truncated = true;
        }
        return result;
      }
    }
    // Fallback for an unpacked installation lacking the new reader.
    rememberRenderedTurns();
    await scanOlderBrowserTurns();
    if (!validPage()) return { ok: false, error: "Conversation changed during capture." };
    return {
      ok: true, messages: rememberedTurns.map(({ role, text, key }) =>
        ({ role, text, key })),
      renderedCount: units().length,
      truncated: turnCaptureLimited,
      orderUncertain: uncertainTurnOrder
    };
  }

  function onCommand(message, _sender, respond) {
    if (message?.type === "gcrCaptureConversation") {
      void capturedConversation().then(respond).catch(() =>
        respond({ ok: false, error: "Could not read loaded ChatGPT messages." }));
      return true;
    }
    if (message?.type === "gcrStop") stop();
    if (message?.type === "gcrWorkflowMode" && typeof message.enabled === "boolean") {
      if (message.enabled === workflowEnabled) return;
      workflowEpoch++;
      if (message.enabled) {
        baselinePending = true; frontier = null;
        identities.clear(); nodes = new WeakMap();
      }
      workflowEnabled = message.enabled;
      if (workflowEnabled) { globalThis.GcrLiveArchiverReader?.observe(); rememberRenderedTurns(); void scanEvidence(); }
    }
  }

  let debounce = null;
  // Watch link metadata as well as href: a commit URL may be attached to a
  // rendered control after the assistant response first appears.
  const observer = new MutationObserver(() => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(poll, 250);
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true,
    attributeFilter: [
      "href", "data-href", "data-url", "data-clipboard-text", "aria-label", "title",
      "data-message-id", "data-role", "data-message-author", "data-message-author-role", "data-turn",
      "data-user-message-bubble", "data-content-search-unit-key",
      "role", "data-app-action-timeline-scroll"
    ]
  });
  const ticker = setInterval(poll, 1500);
  chrome.runtime.onMessage.addListener(onCommand);
  globalThis.__gcrChatGPTObserver = { stop };
  poll();
})();
