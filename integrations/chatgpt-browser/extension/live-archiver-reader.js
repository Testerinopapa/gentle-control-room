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
  // Deliberately slower history scan: give lazy-loaded assistant replies time
  // to mount and stabilize before the next scroll.
  const TOP_WAIT_MS = 900, DOWN_WAIT_MS = 1600, RECHECK_WAIT_MS = 650;
  const SCROLL_FRACTION = 0.35, MAX_DOWN_STEPS = 340;
  const entries = [];
  let limited = false, uncertain = false, collecting = false;
  let lastCoverage = null;
  let lastObservedScrollTop = null;
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
  // Metadata only: retain GitHub addresses from text AND actual link targets.
  // Do not infer commit SHAs from a generic "pushed to main" statement.
  const REPO = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i;
  const SHA = /^[a-f0-9]{40}$/i;
  function githubOf(node, text) {
    const repositories = new Set(), commits = new Map();
    const add = value => {
      if (typeof value !== "string") return;
      const urlPattern = /https:\/\/github\.com\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})(?:\/commit\/([a-f0-9]{40}))?(?=[\/?#\s"'<>)]|$)/gi;
      for (const match of value.matchAll(urlPattern)) {
        const repository = (match[1] + "/" + match[2]).toLowerCase();
        if (!REPO.test(repository)) continue;
        if (repositories.size < 8) repositories.add(repository);
        if (match[3] && SHA.test(match[3]) && commits.size < 12) {
          const sha = match[3].toLowerCase();
          commits.set(repository + "@" + sha, { repository, sha,
            url: "https://github.com/" + repository + "/commit/" + sha });
        }
      }
      // Repository labels can be shown without a clickable URL in ChatGPT.
      for (const match of value.matchAll(/\b(?:Repository|Repo)\s*:\s*([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})\b/gi)) {
        const repository = match[1].toLowerCase();
        if (REPO.test(repository) && repositories.size < 8) repositories.add(repository);
      }
    };
    add(text);
    if (node?.querySelectorAll) for (const link of node.querySelectorAll(
      'a, [role="link"], [data-href], [data-url], [data-clipboard-text]')) {
      for (const attr of ["href", "data-href", "data-url", "data-clipboard-text", "title", "aria-label"])
        add(link.getAttribute?.(attr));
    }
    return { repositories: [...repositories], commits: [...commits.values()] };
  }
  function mergeGithub(a, b) {
    const repositories = [...new Set([...(a?.repositories || []), ...(b?.repositories || [])])].slice(0, 8);
    const commits = [...new Map([...(a?.commits || []), ...(b?.commits || [])]
      .map(ref => [ref.repository + "@" + ref.sha, ref])).values()].slice(0, 12);
    return { repositories, commits };
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
    // Prefer the actual assistant markdown over broad enclosing message
    // containers, which can contain progress/status UI and duplicate renderings.
    // This is especially important for long coding conversations.
    const markdown = outermost([...turn.querySelectorAll(
      '[data-markdown-text-style="assistant-message"]')]);
    const prose = markdown.map(node => textOf(node, "assistant"))
      .filter(Boolean).join("\n\n").trim();
    if (prose.length >= 24) return prose;
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
            github: githubOf(user, text),
            key: stableKey(user, "user", turnKey ? turnKey + ":user" : "") || hashKey("user", text),
            order: order === null ? null : order * 2 });
        }
        const fullReply = responseText(turn, user);
        if (fullReply) {
          const text = fullReply.slice(0, MAX_MESSAGE_CHARS);
          if (fullReply.length > MAX_MESSAGE_CHARS) limited = true;
          rows.push({ role: "assistant", text,
            github: githubOf(turn, text),
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
      if (text) rows.push({ role, text, github: githubOf(node, text),
        key: stableKey(node, role) ||
          stableKey(node.closest('[data-turn-id],article[data-turn]') || node, role) ||
          hashKey(role, text), order: null });
    }
    return rows;
  }
  function enforceCaptureLimits() {
    let size = entries.reduce((sum, row) => sum + row.text.length, 0);
    while (entries.length > MAX_MESSAGES || size > MAX_CHARS) {
      const removed = entries.splice(Math.floor(entries.length / 2), 1)[0];
      size -= removed.text.length;
      limited = true;
    }
  }
  function mergeRows(incoming, direction = "up", trustedDirection = false) {
    const overlap = incoming.some(row => entries.some(prev => prev.key === row.key));
    if (!overlap && entries.length && incoming.length) {
      if (direction === "down") entries.push(...incoming);
      else entries.unshift(...incoming);
      if (!trustedDirection) uncertain = true;
    } else {
      let previousIndex = -1;
      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i];
        const match = entries.findIndex(item => item.key === row.key);
        if (match >= 0) {
          const github = mergeGithub(entries[match].github, row.github);
          if (row.text.length >= entries[match].text.length)
            entries[match] = { ...row, github };
          else entries[match].github = github;
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
    // Do NOT globally sort by fallback-turn-N values. ChatGPT numbers those
    // turns relative to what is loaded in the DOM, and virtualization can
    // reassign the same number to a completely different earlier/later turn.
    // The browser's rendered order and the direction of harvesting are safer.
    enforceCaptureLimits();
  }
  function observe(direction = null, trustedDirection = false) {
    // Passive observation follows the user's scroll direction; the old
    // default "down" appended newly loaded *older* windows to the end.
    const scrolling = scroller();
    const top = Number.isFinite(scrolling?.scrollTop) ? scrolling.scrollTop : null;
    if (!direction) direction = top !== null && lastObservedScrollTop !== null &&
      top < lastObservedScrollTop - 5 ? "up" : "down";
    if (top !== null) lastObservedScrollTop = top;
    const rows = readRows();
    mergeRows(rows, direction, trustedDirection);
    return rows;
  }
  // First-pass windows may hold replies (or entire turns) unmounted before
  // the canonical downward pass. Keep every discovered user turn while
  // preserving proven order where adjacent stable anchors exist.
  function recoverUpwardTurns(upwardRows) {
    let recoveredReplies = 0, recoveredUserTurns = 0, uncertainPlacements = 0;
    let unanchoredReplies = 0;
    const prelude = [];
    const canonical = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const sameUser = (a, b) => a?.role === "user" && b?.role === "user" &&
      (a.key === b.key || (canonical(a.text).length >= 14 &&
        canonical(a.text) === canonical(b.text)));
    const blocks = [];
    for (const row of upwardRows) {
      if (row.role === "user") blocks.push({ user: row, replies: [] });
      else if (row.role === "assistant" && blocks.length)
        blocks[blocks.length - 1].replies.push(row);
      else if (row.role === "assistant") prelude.push(row);
    }
    const find = user => {
      const locations = entries.map((row, index) => sameUser(user, row) ? index : -1)
        .filter(index => index >= 0);
      return locations.length === 1 ? locations[0] : -1;
    };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let index = find(block.user);
      if (index < 0) {
        // Prefer an immediately following matching turn. With both anchors
        // we know the section's place; with only one it is provisional.
        let left = -1, right = -1;
        for (let j = i - 1; j >= 0; j--) {
          left = find(blocks[j].user);
          if (left >= 0) break;
        }
        for (let j = i + 1; j < blocks.length; j++) {
          right = find(blocks[j].user);
          if (right >= 0) break;
        }
        if (right >= 0 && (left < 0 || left < right)) index = right;
        else if (left >= 0) {
          index = left + 1;
          while (index < entries.length && entries[index].role !== "user") index++;
        } else index = entries.length;
        if (left < 0 || right < 0 || right <= left) {
          uncertainPlacements++;
          uncertain = true;
        }
        entries.splice(index, 0, block.user);
        recoveredUserTurns++;
      }
      let end = index + 1;
      while (end < entries.length && entries[end].role !== "user") end++;
      for (const reply of block.replies) {
        const match = entries.slice(index + 1, end).findIndex(row =>
          row.role === "assistant" && (row.key === reply.key ||
            canonical(row.text) === canonical(reply.text) ||
            (Math.min(row.text.length, reply.text.length) > 75 &&
              (row.text.includes(reply.text) || reply.text.includes(row.text)))));
        if (match >= 0) {
          const at = index + 1 + match;
          const github = mergeGithub(entries[at].github, reply.github);
          if (reply.text.length > entries[at].text.length)
            entries[at] = { ...reply, github };
          else entries[at].github = github;
        } else {
          entries.splice(end, 0, reply);
          end++;
          recoveredReplies++;
        }
      }
    }
    // A window can begin with an assistant body whose parent user message
    // has already been virtualized away. Preserve the text without asserting
    // that its position relative to later user turns is known.
    const orphans = prelude.filter(reply => !entries.some(row =>
      row.role === "assistant" && (row.key === reply.key ||
        canonical(row.text) === canonical(reply.text))));
    if (orphans.length) {
      entries.unshift(...orphans);
      unanchoredReplies = orphans.length;
      uncertain = true;
      uncertainPlacements += orphans.length;
    }
    enforceCaptureLimits();
    return { recoveredUserTurns, recoveredReplies, uncertainPlacements, unanchoredReplies };
  }

  async function collect(allowed = () => true, onWindow = () => {}) {
    if (collecting) return { ok: false, error: "Conversation capture is already running." };
    collecting = true;
    const scrolling = scroller();
    const startedAt = Date.now();
    // Previous explicit captures are persisted by the background worker.
    // Begin a fresh ordered scan rather than reuse a passively observed cache
    // whose order may already have been affected by virtualization.
    entries.length = 0; uncertain = false; limited = false;
    let observedWindows = 0, disconnectedWindows = 0, previousDownKeys = null;
    let tabWasHidden = document.hidden === true;
    const captureWindow = direction => {
      if (document.hidden === true) tabWasHidden = true;
      const rows = observe(direction, true);
      observedWindows++;
      if (direction === "down" && rows.length) {
        const keys = new Set(rows.map(row => row.key));
        if (previousDownKeys && !rows.some(row => previousDownKeys.has(row.key)))
          disconnectedWindows++;
        previousDownKeys = keys;
      }
      try { onWindow(); } catch { /* Supplemental reader must not interrupt capture. */ }
      return rows;
    };
    // ChatGPT mounts assistant bodies asynchronously after scrolling. The
    // previous 90ms hop could leave a user prompt visible but move away before
    // its assistant reply rendered, creating artificial gaps in the export.
    const settleWindow = async (direction, firstWait) => {
      let previous = null, rows = [];
      for (let attempt = 0; attempt < 4 && allowed(); attempt++) {
        await delay(attempt ? RECHECK_WAIT_MS : firstWait);
        rows = captureWindow(direction);
        const signature = rows.map(row => row.key + ":" + row.text.length).join("|");
        // A stable user-only window may still be awaiting its assistant body.
        // Recheck it a few times instead of moving on immediately.
        const possibleMissingReply = rows.some((row, i) =>
          row.role === "user" &&
          (i === rows.length - 1 || rows[i + 1]?.role === "user"));
        if (previous !== null && signature === previous && !possibleMissingReply) break;
        previous = signature;
      }
      return rows;
    };
    const initialCount = captureWindow("down").length;
    const initialHeight = scrolling?.scrollHeight || 0;
    const oldTop = scrolling?.scrollTop || 0;
    const bottomDistance = scrolling ? scrolling.scrollHeight - scrolling.scrollTop : 0;
    const wasAtBottom = scrolling && scrolling.scrollHeight - scrolling.clientHeight - oldTop < 60;
    let atTop = false, atBottom = false, stoppedEarly = false;
    let recoveredFromUpwardPass = 0, recoveredUserTurns = 0;
    let uncertainPlacements = 0, unanchoredReplies = 0, upwardRows = [];
    try {
      if (scrolling && allowed()) {
        // Live Archiver's two-pass harvesting idea: force the real top, let
        // lazy-loaded history settle, then walk DOWN through each DOM window.
        let stable = 0, oldHeight = -1, oldFirst = "";
        for (let i = 0; i < 55 && allowed(); i++) {
          scrolling.scrollTop = 0;
          const rows = await settleWindow("up", TOP_WAIT_MS);
          const head = rows[0]?.key || "";
          const isStable = scrolling.scrollTop <= 1 &&
            scrolling.scrollHeight === oldHeight && head === oldFirst;
          stable = isStable ? stable + 1 : 0;
          oldHeight = scrolling.scrollHeight;
          oldFirst = head;
          if (stable >= 3) { atTop = true; break; }
          if (stable === 2) {
            scrolling.scrollTop = Math.min(220, scrolling.scrollHeight);
            await delay(RECHECK_WAIT_MS);
          }
        }
        if (atTop && allowed()) {
          // Keep the first pass for rescuing answers that ChatGPT unmounts
          // before the canonical downward scan can revisit them.
          upwardRows = entries.map(item => ({ ...item }));
          // Upward windows are NOT allowed to control final chronology.
          entries.length = 0; uncertain = false;
          previousDownKeys = null; disconnectedWindows = 0;
          captureWindow("down");
        }
        let lastTop = -1, idle = 0;
        for (let i = 0; i < MAX_DOWN_STEPS && allowed(); i++) {
          captureWindow("down");
          const end = scrolling.scrollTop + scrolling.clientHeight >= scrolling.scrollHeight - 3;
          if (end) {
            atBottom = true;
            break;
          }
          const before = scrolling.scrollTop;
          scrolling.scrollTop = before + Math.max(120, scrolling.clientHeight * SCROLL_FRACTION);
          await settleWindow("down", DOWN_WAIT_MS);
          idle = scrolling.scrollTop === lastTop ? idle + 1 : 0;
          lastTop = scrolling.scrollTop;
          if (idle >= 4) { stoppedEarly = true; break; }
        }
        captureWindow("down");
        if (atTop && upwardRows.length) {
          const restored = recoverUpwardTurns(upwardRows);
          recoveredFromUpwardPass = restored.recoveredReplies;
          recoveredUserTurns = restored.recoveredUserTurns;
          uncertainPlacements = restored.uncertainPlacements;
          unanchoredReplies = restored.unanchoredReplies;
        }
      }
      if (!allowed()) return { ok: false, error: "Conversation changed during capture." };
      if (!scrolling) { atTop = false; atBottom = false; }
      const possibleReplyGaps = entries.reduce((count, row, i) =>
        count + (row.role === "user" && entries[i + 1]?.role === "user" ? 1 : 0), 0);
      if (disconnectedWindows > 0) uncertain = true;
      lastCoverage = { observedMessageCount: entries.length, initiallyRendered: initialCount,
        atTop, atBottom, scrolling: !!scrolling, stoppedEarly, capped: limited,
        durationMs: Date.now() - startedAt, initialScrollHeight: initialHeight,
        observedWindows, disconnectedWindows, possibleReplyGaps, tabWasHidden,
        recoveredFromUpwardPass, recoveredUserTurns, uncertainPlacements,
        unanchoredReplies, verifiedComplete: false };
      return { ok: true, messages: entries.map(({ role, text, key, github }) =>
        ({ role, text, key, github })),
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
  function reset() {
    entries.length = 0; limited = false; uncertain = false;
    lastCoverage = null; lastObservedScrollTop = null;
  }
  // Isolated, explicitly invoked diagnostic. Never reads the observer cache or
  // writes its transcript to storage. Scan mounted turns and nearby history.
  async function testRead() {
    const path = location.pathname, scrolling = scroller(), oldTop = scrolling?.scrollTop;
    let rows = [];
    const merge = (incoming, earlier = false) => {
      const previous = new Map(rows.map(row => [row.key, row]));
      for (const row of incoming) {
        const old = previous.get(row.key);
        if (old) { old.github = mergeGithub(old.github, row.github); if (row.text.length > old.text.length) old.text = row.text; }
      }
      const fresh = incoming.filter(row => !previous.has(row.key));
      rows = earlier ? [...fresh, ...rows] : [...rows, ...fresh];
      rows = rows.slice(-MAX_MESSAGES);
    };
    const references = () => new Set(rows.flatMap(row => (row.github?.commits || []).map(ref => ref.repository + "@" + ref.sha)));
    let windows = 0;
    try {
      merge(readRows()); windows++;
      // Recent mounted messages are enough when several commit links are
      // present. Otherwise make a short, bounded backward scan for them.
      for (let i = 0; scrolling && i < 16 && references().size < 3 && location.pathname === path; i++) {
        if (scrolling.scrollTop <= 1) break;
        const before = scrolling.scrollTop;
        scrolling.scrollTop = Math.max(0, before - Math.max(160, scrolling.clientHeight * 0.8));
        await delay(500);
        merge(readRows(), true); windows++;
        if (scrolling.scrollTop === before) break;
      }
      if (location.pathname !== path) return { ok: false, error: "Conversation changed during test." };
      let chars = 0;
      const messages = [];
      for (const row of rows.slice().reverse()) {
        if (chars + row.text.length > MAX_CHARS) break;
        chars += row.text.length;
        messages.unshift({ role: row.role, text: row.text, key: row.key, github: row.github });
      }
      return { ok: true, messages, capturedAt: new Date().toISOString(), truncated: true,
        coverage: { verifiedComplete: false, observedWindows: windows, scanMethod: "isolated_test_dom" } };
    } finally {
      if (scrolling && location.pathname === path && oldTop !== undefined) scrolling.scrollTop = oldTop;
    }
  }
  globalThis.GcrLiveArchiverReader = Object.freeze({ observe, collect, reset, testRead });
})();
