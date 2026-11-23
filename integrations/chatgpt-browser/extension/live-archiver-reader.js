"use strict";
// SPDX-License-Identifier: Apache-2.0
// Adapted from Live Archiver by Mark West (2026), v1.2.10:
// https://github.com/hexnod/live-archiver
// Sources: content/content.js (two-pass top/down harvest and scroll restore)
//          content/adapters/chatgpt.js (turn/message-unit DOM parsing)
// Changes: DOM-only; no auth/session requests, backend API, file fetching,
// injection into MAIN world, archive downloads, or external network access.
// License/attribution: third_party/LiveArchiver-LICENSE and -NOTICE.
(() => {
  if (globalThis.GcrLiveArchiverReader) return;
  const MAX_MESSAGES = 160, MAX_CHARS = 350000, MAX_MESSAGE_CHARS = 8000;
  const entries = [];
  let limited = false, uncertain = false, collecting = false;
  let lastCoverage = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function outermost(items) {
    const set = new Set(items);
    return items.filter(el => {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (set.has(p)) return false;
      return true;
    });
  }
  function isVisible(node) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.checkVisibility === "function") return node.checkVisibility();
    return typeof node.getClientRects !== "function" ||
      node.getClientRects().length > 0;
  }
  function transcript() {
    // Live Archiver checks visibility because ChatGPT can retain hidden
    // transcripts for previously opened conversations in the same DOM.
    for (const selector of [
      '[role="region"][aria-label="Conversation"]',
      '[data-app-action-timeline-scroll]',
      '[data-thread-find-target="conversation"]'
    ]) {
      const found = typeof document.querySelectorAll === "function"
        ? [...document.querySelectorAll(selector)] : [document.querySelector(selector)];
      const visible = found.find(isVisible);
      if (visible) return visible;
    }
    return document;
  }
  function scroller() {
    let el = transcript();
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 60 && el.clientHeight > 100) {
        const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
        if (!style || /(auto|scroll)/.test(style.overflowY)) return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || null;
  }
  function cleanText(role, input) {
    const val = String(input ?? "").trim();
    return (role === "assistant"
      ? val.replace(/^(?:ChatGPT said:\s*)+/i, "")
      : val.replace(/^(?:You said:\s*)+/i, "")).trim();
  }
  function textOf(root, role) {
    if (!root) return "";
    // Prefer the answer/prompt body instead of a container with toolbar labels.
    const clone = root.cloneNode(true);
    for (const selector of [
      '[data-conversation-role]', 'button', '[role="toolbar"]',
      '[role="status"]', '[data-markdown-copy="exclude"]',
      '[data-thread-find-skip]', '[data-block-actions]',
      'script', 'style', 'svg', 'canvas', 'form', 'textarea'
    ]) for (const item of clone.querySelectorAll(selector)) item.remove();
    for (const h of clone.querySelectorAll("h4,h5,h6"))
      if (/^\s*(you|chatgpt) said:?\s*$/i.test(h.textContent)) h.remove();
    // Detached clones often have empty innerText; textContent alone also
    // concatenates paragraphs, list items and headings without separators.
    function readable(node) {
      if (!node) return "";
      if (node.nodeType === 3) return node.nodeValue || "";
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return "";
      const tag = String(node.localName || "").toLowerCase();
      if (tag === "br") return "\n";
      const children = [...(node.childNodes || [])];
      let text = children.map(readable).join("");
      if (/^(?:p|div|section|article|header|footer|blockquote|pre|h[1-6]|li|ul|ol|table|tr)$/.test(tag))
        text = "\n" + text + "\n";
      return text;
    }
    const visual = typeof clone.innerText === "string" ? clone.innerText.trim() : "";
    const structured = readable(clone).replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const source = structured || visual || String(clone.textContent ?? "");
    let result = cleanText(role, source);
    if (result.length > MAX_MESSAGE_CHARS) { limited = true; result = result.slice(0, MAX_MESSAGE_CHARS); }
    return result;
  }
  function hashKey(role, value) {
    let hash = 2166136261;
    for (const char of value.slice(0, 2500)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return role + ":text:" + (hash >>> 0).toString(36) + ":" + value.length;
  }
  function stableKey(node, role, prefix = "") {
    const direct = prefix ||
      node.getAttribute?.("data-message-id") ||
      node.getAttribute?.("data-content-search-unit-key") ||
      node.getAttribute?.("data-chatgpt-search-unit-key") ||
      node.getAttribute?.("data-turn-id") ||
      node.getAttribute?.("data-turn-key") ||
      node.getAttribute?.("id") || "";
    return direct ? role + ":" + String(direct).slice(0, 175) : null;
  }
  function responseParts(turn, user) {
    // Live Archiver's assistant units are frequently adjacent to the
    // accessible "ChatGPT said:" heading. An explicit :assistant wrapper
    // may contain *only* that heading while the rendered answer lives in a
    // sibling unit. Examine the candidate groups instead of returning the
    // first selector match, or genuine replies can disappear.
    const unitSelector = '[data-chatgpt-search-message-ids]';
    const units = outermost([...turn.querySelectorAll(unitSelector)])
      .filter(node => !(user && (node === user || user.contains(node) || node.contains(user))));
    const tagged = units.filter(node =>
      node.querySelector('[data-conversation-role="assistant"]') ||
      node.previousElementSibling?.matches?.('[data-conversation-role="assistant"]'));
    const explicit = outermost([...turn.querySelectorAll(
      '[data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]')]);
    const markdown = outermost([...turn.querySelectorAll(
      '[data-markdown-text-style="assistant-message"]')]);
    const legacy = outermost([...turn.querySelectorAll('[data-message-author-role="assistant"]')]);
    return [tagged, explicit, markdown, legacy, units].filter(group => group.length);
  }

  function responseText(turn, user) {
    const groups = responseParts(turn, user);
    let best = "";
    for (const group of groups) {
      const parts = group.map(part => {
        const markdownRoots = [...part.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
        return (markdownRoots.length ? markdownRoots.map(body => textOf(body, "assistant"))
          : [textOf(part, "assistant")]).filter(Boolean).join("\n\n");
      }).filter(Boolean);
      const candidate = parts.join("\n\n").trim();
      // A richer, meaningful answer is preferable to a label-only wrapper.
      // Rich answer bodies can contain several message units.
      if (candidate.length > best.length) best = candidate;
    }
    return best;
  }
  function readRows() {
    const root = transcript();
    const turns = outermost([...root.querySelectorAll(
      '[data-turn-key], article[data-testid^="conversation-turn-"]')]);
    const rows = [];
    if (turns.length) {
      for (const turn of turns) {
        const turnKey = turn.getAttribute('data-turn-key') || "";
        const indexEl = turn.querySelector('[data-content-search-turn-key]') ||
          (turn.hasAttribute('data-content-search-turn-key') ? turn : null);
        const indexText = indexEl?.getAttribute('data-content-search-turn-key') || "";
        const match = indexText.match(/(?:^|[-:_])(\d+)$/);
        const order = match ? Number(match[1]) : null;
        let user = turn.querySelector(
          '[data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]');
        if (!user && turnKey) user = [...turn.querySelectorAll('[data-chatgpt-search-message-ids]')]
          .find(node => (node.getAttribute('data-chatgpt-search-message-ids') || "")
            .split(/\s+/).includes(turnKey)) || null;
        if (!user) {
          const bubble = turn.querySelector('[data-user-message-bubble]');
          user = bubble?.parentElement || turn.querySelector('[data-message-author-role="user"]');
        }
        if (user) {
          const body = user.querySelector('[data-markdown-text-tone="user-message"]') ||
            user.querySelector('[data-user-message-bubble]') || user;
          const text = textOf(body, "user");
          if (text) rows.push({ role: "user", text,
            key: stableKey(user, "user", turnKey ? turnKey + ":user" : "") || hashKey("user", text),
            order: order === null ? null : order * 2 });
        }
        const fullReply = responseText(turn, user);
        if (fullReply) {
          const text = fullReply.slice(0, MAX_MESSAGE_CHARS);
          if (fullReply.length > MAX_MESSAGE_CHARS) limited = true;
          rows.push({ role: "assistant", text,
            key: stableKey(turn, "assistant", turnKey ? turnKey + ":assistant" : "") ||
              hashKey("assistant", text), order: order === null ? null : order * 2 + 1 });
        }
      }
      return rows;
    }
    // Legacy fallback: separate DOM nodes per user or assistant message.
    const selectors = [
      '[data-message-author-role="user"]', '[data-message-author-role="assistant"]',
      'article[data-turn="user"]', 'article[data-turn="assistant"]',
      '[data-content-search-unit-key$=":user"]', '[data-content-search-unit-key$=":assistant"]'
    ];
    const nodes = outermost([...root.querySelectorAll(selectors.join(","))]);
    for (const node of nodes) {
      const role = node.matches('[data-message-author-role="user"],article[data-turn="user"],[data-content-search-unit-key$=":user"]')
        ? "user" : "assistant";
      const body = role === "assistant"
        ? node.querySelector('[data-markdown-text-style="assistant-message"]') || node
        : node.querySelector('[data-markdown-text-tone="user-message"]') || node;
      const text = textOf(body, role);
      if (text) rows.push({ role, text,
        key: stableKey(node, role) ||
          stableKey(node.closest('[data-turn-id],article[data-turn]') || node, role) ||
          hashKey(role, text), order: null });
    }
    return rows;
  }
  function mergeRows(incoming, direction = "up") {
    const overlap = incoming.some(row => entries.some(prev => prev.key === row.key));
    if (!overlap && entries.length && incoming.length) {
      if (direction === "down") entries.push(...incoming);
      else entries.unshift(...incoming);
      uncertain = true;
    } else {
      let previousIndex = -1;
      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i];
        const match = entries.findIndex(item => item.key === row.key);
        if (match >= 0) {
          if (row.text.length >= entries[match].text.length)
            entries[match] = row;
          previousIndex = match;
        } else {
          const next = incoming.slice(i + 1)
            .map(candidate => entries.findIndex(item => item.key === candidate.key))
            .find(index => index >= 0);
          const target = next !== undefined ? next :
            previousIndex >= 0 ? previousIndex + 1 :
              direction === "down" ? entries.length : 0;
          entries.splice(target, 0, row);
          previousIndex = target;
        }
      }
    }
    if (entries.length > 1 && entries.every(row => Number.isInteger(row.order))) {
      entries.sort((a, b) => a.order - b.order);
      uncertain = false;
    }
    let size = entries.reduce((sum, row) => sum + row.text.length, 0);
    while (entries.length > MAX_MESSAGES || size > MAX_CHARS) {
      const dropped = entries.splice(Math.floor(entries.length / 2), 1)[0];
      size -= dropped.text.length;
      limited = true;
    }
  }
  function observe(direction = "down") {
    const rows = readRows();
    mergeRows(rows, direction);
    return rows;
  }
  async function collect(allowed = () => true, onWindow = () => {}) {
    if (collecting) return { ok: false, error: "Conversation capture is already running." };
    collecting = true;
    const scrolling = scroller();
    const startedAt = Date.now();
    const captureWindow = direction => {
      const rows = observe(direction);
      try { onWindow(); } catch { /* Supplemental reader must not interrupt capture. */ }
      return rows;
    };
    const initialCount = captureWindow("down").length;
    const initialHeight = scrolling?.scrollHeight || 0;
    const oldTop = scrolling?.scrollTop || 0;
    const bottomDistance = scrolling ? scrolling.scrollHeight - scrolling.scrollTop : 0;
    const wasAtBottom = scrolling && scrolling.scrollHeight - scrolling.clientHeight - oldTop < 60;
    let atTop = false, atBottom = false, stoppedEarly = false;
    try {
      if (scrolling && allowed()) {
        // Live Archiver's two-pass harvesting idea: force the real top, let
        // lazy-loaded history settle, then walk DOWN through each DOM window.
        let stable = 0, oldHeight = -1, oldFirst = "";
        for (let i = 0; i < 55 && allowed(); i++) {
          scrolling.scrollTop = 0;
          await delay(160);
          const rows = captureWindow("up");
          const head = rows[0]?.key || "";
          const isStable = scrolling.scrollTop <= 1 &&
            scrolling.scrollHeight === oldHeight && head === oldFirst;
          stable = isStable ? stable + 1 : 0;
          oldHeight = scrolling.scrollHeight;
          oldFirst = head;
          if (stable >= 3) { atTop = true; break; }
          if (stable === 2) { scrolling.scrollTop = Math.min(220, scrolling.scrollHeight); await delay(90); }
        }
        let lastTop = -1, idle = 0;
        for (let i = 0; i < 140 && allowed(); i++) {
          captureWindow("down");
          const end = scrolling.scrollTop + scrolling.clientHeight >= scrolling.scrollHeight - 3;
          if (end) {
            atBottom = true;
            break;
          }
          const before = scrolling.scrollTop;
          scrolling.scrollTop = before + Math.max(200, scrolling.clientHeight * 0.7);
          await delay(90);
          idle = scrolling.scrollTop === lastTop ? idle + 1 : 0;
          lastTop = scrolling.scrollTop;
          if (idle >= 4) { stoppedEarly = true; break; }
        }
        captureWindow("down");
      }
      if (!allowed()) return { ok: false, error: "Conversation changed during capture." };
      if (!scrolling) { atTop = false; atBottom = false; }
      lastCoverage = { observedMessageCount: entries.length, initiallyRendered: initialCount,
        atTop, atBottom, scrolling: !!scrolling, stoppedEarly, capped: limited,
        durationMs: Date.now() - startedAt, initialScrollHeight: initialHeight };
      return { ok: true, messages: entries.map(({ role, text, key }) => ({ role, text, key })),
        renderedCount: readRows().length, truncated: limited,
        orderUncertain: uncertain, coverage: lastCoverage };
    } finally {
      if (scrolling && allowed()) {
        scrolling.scrollTop = wasAtBottom ? scrolling.scrollHeight :
          Math.max(0, scrolling.scrollHeight - bottomDistance);
      }
      collecting = false;
    }
  }
  function reset() { entries.length = 0; limited = false; uncertain = false; lastCoverage = null; }
  globalThis.GcrLiveArchiverReader = Object.freeze({ observe, collect, reset });
})();
