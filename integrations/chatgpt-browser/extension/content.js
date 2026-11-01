"use strict";
// Injected ONLY after a direct opt-in action in the toolbar popup.
// Counts role markers; never reads innerText, textContent, values, or user inputs.
(() => {
  if (globalThis.__gcrChatGPTObserver) {
    globalThis.__gcrChatGPTObserver.stop();
  }
  const pathname = location.pathname;
  let lastReported = "";
  let stopped = false;
  let nextSendAt = 0;
  let pending = null;

  function readCounts() {
    let user = 0;
    let assistant = 0;
    for (const element of document.querySelectorAll('[data-message-author-role]')) {
      const role = element.getAttribute("data-message-author-role");
      if (role === "user") user++;
      if (role === "assistant") assistant++;
    }
    return { user: Math.min(user, 10000), assistant: Math.min(assistant, 10000) };
  }
  function sendIfChanged() {
    if (stopped) return;
    if (location.pathname !== pathname) {
      chrome.runtime.sendMessage({ type: "conversationChanged" }).catch(() => {});
      stop();
      return;
    }
    const counts = readCounts();
    const signature = counts.user + ":" + counts.assistant;
    if (signature === lastReported) return;
    const now = Date.now();
    if (now < nextSendAt) {
      clearTimeout(pending);
      pending = setTimeout(sendIfChanged, nextSendAt - now);
      return;
    }
    lastReported = signature;
    nextSendAt = now + 3000;
    chrome.runtime.sendMessage({ type: "visibleCounts", ...counts }).catch(() => {});
  }
  function stop() {
    stopped = true;
    observer.disconnect();
    clearTimeout(pending);
    clearInterval(checkNavigation);
    chrome.runtime.onMessage.removeListener(handleCommand);
    delete globalThis.__gcrChatGPTObserver;
  }
  function handleCommand(message) {
    if (message?.type === "gcrStop") stop();
  }
  const observer = new MutationObserver(sendIfChanged);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const checkNavigation = setInterval(sendIfChanged, 1500);
  chrome.runtime.onMessage.addListener(handleCommand);
  globalThis.__gcrChatGPTObserver = { stop };
  sendIfChanged();
})();
