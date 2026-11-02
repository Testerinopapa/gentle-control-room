"use strict";
const HOST = "org.gentlecontrolroom.chatgpt";
const KEY = (tabId) => "gcrChatGPTTab:" + tabId;
const CHATGPT = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DETECTORS = new Set(["current", "legacy", "waiting", "unsupported"]);
const REPOSITORY = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i;
const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const WORKFLOW_STAGES = new Set([
  "investigation", "implementation", "debugging", "testing",
  "version_control", "deployment"
]);

// Clicking the extension toolbar icon opens the persistent Edge side panel.
// This does not start tracking: collection still requires an explicit Start click.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function eligible(url) {
  try {
    const u = new URL(url);
    return CHATGPT.has(u.origin) && u.protocol === "https:";
  } catch {
    return false;
  }
}
async function getSession(tabId) {
  const data = await chrome.storage.session.get(KEY(tabId));
  return data[KEY(tabId)] || null;
}
function nativeFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("not found") || message.includes("not registered") ||
      message.includes("specified native messaging host")) {
    return "Windows collector not installed or not registered. Run install-host.ps1 for this Edge extension ID.";
  }
  if (message.includes("forbidden") || message.includes("not allowed") ||
      message.includes("access to the specified")) {
    return "Edge rejected the collector. Reinstall it with the current extension ID from edge://extensions.";
  }
  if (message.includes("exited") || message.includes("communication") ||
      message.includes("disconnected") || message.includes("broken pipe")) {
    return "Windows collector started but could not respond. Rebuild it with install-host.ps1 and try again.";
  }
  return "Cannot reach the Windows collector. Verify its installation and Edge extension ID.";
}
async function sendToNative(message) {
  try {
    return await chrome.runtime.sendNativeMessage(HOST, message);
  } catch (error) {
    throw new Error(nativeFailure(error));
  }
}
async function nativeEvent(event, sessionId, counts = undefined) {
  if (!UUID.test(sessionId)) throw new Error("Invalid session metadata.");
  const message = { version: 1, event, sessionId, ...(counts || {}) };
  const answer = await sendToNative(message);
  if (!answer?.ok) throw new Error("The Windows collector rejected the event. Reinstall the latest host and try again.");
}
async function stop(tabId) {
  const session = await getSession(tabId);
  if (!session) return;
  // Revoke the browser's active collection state before any asynchronous work.
  await chrome.storage.session.remove(KEY(tabId));
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "gcrStop" }).catch(() => {});
  await nativeEvent("session_ended", session.id).catch(() => {});
}
async function start(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!eligible(tab.url)) {
    throw new Error(tab.url
      ? "Open a ChatGPT conversation before starting recording."
      : "Edge cannot identify this tab. Reload the extension and approve ChatGPT site access.");
  }
  if (await getSession(tabId)) return;
  const id = crypto.randomUUID();
  // Fail closed if the native host is not installed.
  await nativeEvent("session_started", id);
  await chrome.storage.session.set({
    [KEY(tabId)]: {
      id, page: new URL(tab.url).pathname,
      visibleUser: null, visibleAssistant: null, visibleCodeBlocks: null,
      codingMarked: false, workflowEnabled: false, workflowStages: 0, commitRefs: [],
      detector: null, lastObservedAt: null, lastCountAt: null
    }
  });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#166534" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    await stop(tabId);
    throw new Error("Cannot observe this tab. Reload ChatGPT and enable again.");
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!message || typeof message.type !== "string") throw new Error("Invalid request.");
    if (message.type === "testConnection") {
      // Read-only probe. No conversation/session is created.
      const reply = await sendToNative({ version: 1, event: "health_check" });
      if (!reply?.ok) {
        return { ok: false, error: "Windows collector did not accept the health check. Reinstall the latest host." };
      }
      return { ok: true, connected: true };
    }
    if (message.type === "visibleCounts" ||
        message.type === "conversationChanged" ||
        message.type === "observerStatus" ||
        message.type === "workflowStage" ||
        message.type === "githubCommitReference") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false };
      const session = await getSession(tabId);
      if (!session) return { ok: false };
      if (message.type === "conversationChanged") {
        await stop(tabId);
        return { ok: true };
      }
      if (message.type === "workflowStage") {
        // Explicit per-conversation consent, distinct from metadata recording.
        if (!session.workflowEnabled || !WORKFLOW_STAGES.has(message.stage) ||
            (session.workflowStages ?? 0) >= 120) return { ok: false };
        const sourceTab = await chrome.tabs.get(tabId);
        if (!eligible(sourceTab.url) ||
            session.page !== new URL(sourceTab.url).pathname) {
          await stop(tabId);
          return { ok: false };
        }
        await nativeEvent("workflow_stage", session.id, { stage: message.stage });
        const current = await getSession(tabId);
        if (current?.id === session.id && current.workflowEnabled) {
          await chrome.storage.session.set({
            [KEY(tabId)]: { ...current, workflowStages: (current.workflowStages ?? 0) + 1 }
          });
        }
        return { ok: true };
      }
      if (message.type === "githubCommitReference") {
        // Requires the separate explicit workflow opt-in for the source conversation.
        if (!session.workflowEnabled || typeof message.repository !== "string" ||
            typeof message.sha !== "string" || !REPOSITORY.test(message.repository) ||
            !COMMIT_SHA.test(message.sha)) return { ok: false };
        const sourceTab = await chrome.tabs.get(tabId);
        if (!eligible(sourceTab.url) || session.page !== new URL(sourceTab.url).pathname) {
          await stop(tabId);
          return { ok: false };
        }
        const repository = message.repository.toLowerCase();
        const sha = message.sha.toLowerCase();
        const key = repository + "@" + sha;
        if ((session.commitRefs || []).includes(key)) return { ok: true, duplicate: true };
        if ((session.commitRefs || []).length >= 30) return { ok: false };
        await nativeEvent("github_commit_ref", session.id, { repository, commitSha: sha });
        const current = await getSession(tabId);
        if (current?.id === session.id && current.workflowEnabled) {
          await chrome.storage.session.set({
            [KEY(tabId)]: { ...current, commitRefs: [...(current.commitRefs || []), key] }
          });
        }
        return { ok: true };
      }
      if (message.type === "observerStatus") {
        if (!DETECTORS.has(message.detector)) return { ok: false };
        const tab = await chrome.tabs.get(tabId);
        if (!eligible(tab.url) || session.page !== new URL(tab.url).pathname) {
          await stop(tabId);
          return { ok: false };
        }
        const current = await getSession(tabId);
        if (!current || current.id !== session.id) return { ok: false };
        await chrome.storage.session.set({
          [KEY(tabId)]: {
            ...current, detector: message.detector, lastObservedAt: Date.now()
          }
        });
        return { ok: true };
      }
      if (!Number.isInteger(message.user) || message.user < 0 || message.user > 10000 ||
          !Number.isInteger(message.assistant) || message.assistant < 0 || message.assistant > 10000 ||
          (message.codeBlocks !== undefined &&
           (!Number.isInteger(message.codeBlocks) || message.codeBlocks < 0 || message.codeBlocks > 10000))) {
        return { ok: false };
      }
      // Only store visible marker counts for the previously approved tab.
      // Messages from switched conversations must never enter this session.
      const sourceTab = await chrome.tabs.get(tabId);
      if (!eligible(sourceTab.url) || session.page !== new URL(sourceTab.url).pathname) {
        await stop(tabId);
        return { ok: false };
      }
      await nativeEvent("visible_counts", session.id, {
        visibleUser: message.user, visibleAssistant: message.assistant,
        ...(message.codeBlocks === undefined ? {} : { visibleCodeBlocks: message.codeBlocks })
      });
      // The sidebar displays safe counts for the tab that opted in.
      // Never resurrect a session after Stop or navigation.
      const current = await getSession(tabId);
      if (current?.id === session.id) {
        await chrome.storage.session.set({
          [KEY(tabId)]: {
            ...current, visibleUser: message.user,
            visibleAssistant: message.assistant,
            visibleCodeBlocks: message.codeBlocks ?? null,
            lastCountAt: Date.now()
          }
        });
      }
      return { ok: true };
    }

    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw new Error("No selected tab.");
    const tab = await chrome.tabs.get(tabId);
    if (message.type === "setWorkflowAnalysis") {
      if (typeof message.enabled !== "boolean") throw new Error("Invalid analysis setting.");
      const session = await getSession(tabId);
      if (!session || !eligible(tab.url) ||
          session.page !== new URL(tab.url).pathname)
        throw new Error("Start recording this conversation before enabling workflow analysis.");
      if (message.enabled === Boolean(session.workflowEnabled)) return { ok: true };
      if (!message.enabled) {
        // Revoke permission before sending the stop command to the page.
        await chrome.storage.session.set({
          [KEY(tabId)]: { ...session, workflowEnabled: false }
        });
        await chrome.tabs.sendMessage(tabId, {
          type: "gcrWorkflowMode", enabled: false
        }).catch(() => {});
        return { ok: true };
      }
      // Never authorize text inspection if the page observer cannot be reached.
      const updated = { ...session, workflowEnabled: true };
      await chrome.storage.session.set({ [KEY(tabId)]: updated });
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "gcrWorkflowMode", enabled: true
        });
      } catch {
        const current = await getSession(tabId);
        if (current?.id === session.id) {
          await chrome.storage.session.set({
            [KEY(tabId)]: { ...current, workflowEnabled: false }
          });
        }
        throw new Error("The page observer is unavailable. Reload ChatGPT, start recording and try again.");
      }
      return { ok: true };
    }
    if (message.type === "setCodingTag") {
      if (typeof message.codingMarked !== "boolean") {
        throw new Error("Invalid coding activity selection.");
      }
      const session = await getSession(tabId);
      if (!session || !eligible(tab.url) ||
          session.page !== new URL(tab.url).pathname) {
        throw new Error("Start recording this ChatGPT conversation before marking coding activity.");
      }
      // Only the selected tab may be tagged; never collect text or infer edits.
      await nativeEvent("coding_tag", session.id, {
        codingMarked: message.codingMarked
      });
      const current = await getSession(tabId);
      if (current?.id === session.id) {
        await chrome.storage.session.set({
          [KEY(tabId)]: { ...current, codingMarked: message.codingMarked }
        });
      }
      return { ok: true };
    }
    if (message.type === "getState") {
      const session = await getSession(tabId);
      const allowed = eligible(tab.url);
      // A persistent side panel does not itself grant activeTab access. The
      // manifest provides host permissions ONLY for the two ChatGPT origins.
      // If URL access is unavailable, explain why the controls are disabled.
      const reason = allowed ? null :
        !tab.url ? "Edge cannot identify this tab. Reload the extension and approve its ChatGPT site access." :
        "Open a conversation at chatgpt.com in the active Edge tab.";
      // If a navigation escaped onUpdated, revoke consent before displaying it.
      const samePage = allowed && session?.page === new URL(tab.url).pathname;
      if (session && !samePage) await stop(tabId);
      return {
        ok: true, allowed, reason, active: Boolean(session && samePage),
        visibleUser: samePage ? session?.visibleUser ?? null : null,
        visibleAssistant: samePage ? session?.visibleAssistant ?? null : null,
        visibleCodeBlocks: samePage ? session?.visibleCodeBlocks ?? null : null,
        codingMarked: Boolean(samePage && session?.codingMarked),
        workflowEnabled: Boolean(samePage && session?.workflowEnabled),
        workflowStages: samePage ? session?.workflowStages ?? 0 : 0,
        detector: samePage ? session?.detector ?? null : null,
        lastObservedAt: samePage ? session?.lastObservedAt ?? null : null,
        lastCountAt: samePage ? session?.lastCountAt ?? null : null
      };
    }
    if (message.type === "start") {
      await start(tabId);
      return { ok: true };
    }
    if (message.type === "stop") {
      await stop(tabId);
      return { ok: true };
    }
    throw new Error("Unsupported operation.");
  })().then(respond, (error) => respond({ ok: false, error: error?.message || "Unavailable" }));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { void stop(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) void stop(tabId);
});
