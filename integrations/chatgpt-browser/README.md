# ChatGPT Browser Activity — Microsoft Edge sidebar extension (Phase 1)

Opt-in, **local-only** metadata collection for ChatGPT conversations in Edge. This integration is independent of Codex CLI hooks. The Windows Gentle Control Room application reads a summary of its events from the **current Windows account**, and neither hosted WebView pages nor Supabase see them.

## What this collects

For each conversation you explicitly turn ON in Edge, the extension records:
- start and stop of the approved browser session;
- approximate **rendered** counts of user and assistant message elements, detected from modern ChatGPT timeline markers or legacy role markers;
- rendered code-block count and an explicitly selected coding-work tag, when available;
- event timestamp and a newly generated, random session identifier.

**Normal recording is metadata-only and does not inspect message text.** With the separate **Enable workflow analysis** switch, the extension temporarily reads **visible user-message text inside the active approved page**, classifies each request locally into a small fixed set of coding stages, and sends **only the stage label** to the local native host. No prompt text, assistant response text, code, message titles, conversation URLs, conversation IDs, cookies, credentials, tokens, clipboard, or other tabs are sent or saved. With workflow analysis opted in, the extension also records only the repository name and full SHA from visible **GitHub commit links in assistant messages**, for the existing Windows app to resolve against explicitly approved local Git repositories. See [browser-linked GitHub implementation evidence](../../docs/browser-github-implementation-pipeline.md). No network endpoints, fetch clients or background requests are used. This is not ChatGPT account integration and cannot observe all chats automatically. DOM markers may be missing or virtualized, so counts are estimates, not authoritative conversation totals.

Recording is **OFF by default**. Click the extension's toolbar icon to open the persistent **Edge side panel** on the right, alongside ChatGPT. Opening the panel does **not** start collection. Click **Start for this conversation** to enable the current tab. The side panel shows approximate visible message counts when recording, and the toolbar displays an ON badge. Stop manually or navigate to another conversation to end recording. No site-wide auto-consent or automatic enrollment is implemented.

## Windows installation (Edge)

Prerequisites: Microsoft Edge, Python not required, and **.NET 8 SDK** for building the native messaging host.

1. Update your repository: `git pull --ff-only origin main`.
2. In Edge, visit `edge://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the directory:
   `C:\Users\null\Documents\ChatGPT\gentle-control-room\integrations\chatgpt-browser\extension`
3. Copy the **32-character extension ID** from the card in `edge://extensions`. It consists of letters `a` to `p`.
4. From the repository root, run in PowerShell (replace the placeholder ID):

   ```powershell
   .\integrations\chatgpt-browser\install-host.ps1 -ExtensionId "YOUR_32_CHARACTER_EDGE_EXTENSION_ID"
   ```

   If PowerShell blocks local scripts, invoke with:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\integrations\chatgpt-browser\install-host.ps1 -ExtensionId "YOUR_32_CHARACTER_EDGE_EXTENSION_ID"
   ```

5. The installer builds a self-contained .NET native host, copies it to `%LOCALAPPDATA%\GentleControlRoom\BrowserNativeHost`, and registers the host **under HKCU for your current Windows account only**, restricted to your exact extension ID. It does not require admin access.
6. Open an **existing ChatGPT conversation** in Edge and click the extension toolbar icon. The ChatGPT Activity **side panel opens on the right**. Click **Start for this conversation**. The toolbar badge will say ON, and the panel will show approximate visible message counts. Each conversation requires separate opt-in. If the host is unavailable, the side panel reports an error and remains Off.
7. After interacting in the conversation, open Gentle Control Room's Windows app and press Refresh. The native **ChatGPT Browser Activity** card shows opted-in session count, approximate visible message counts, and saved event count for the current UTC day.

**If you installed the extension already:** pull the changes and use **Reload** on its card at `edge://extensions`. Click the extension's toolbar icon again; the old popup is replaced by the side panel. You do **not** need to reinstall the native host if the extension ID stays the same.

If the sidebar is not shown, review **Settings → Sidebar** in Edge and make sure the sidebar is enabled. The extension can also be opened via the Extensions hub's **Open in sidebar** action. Sidebar visibility and placement are controlled by Edge.

The browser extension and native host do not need the Gentle Control Room Windows app to be running while recording. The window reads the local store when opened.

## Diagnose a sidebar stuck at Off

If **Start for this conversation** is **greyed out / cannot be clicked**, Edge may be withholding the active tab URL from the sidebar. Version 0.2.1 adds permissions for **ChatGPT domains only** to resolve this (no access to unrelated websites). Pull the latest changes, reload the extension at `edge://extensions`, and **approve the updated site-access permission** if Edge prompts for it. In `edge://extensions` → Gentle Control Room → Details → Site access, ensure the ChatGPT sites are allowed. Keep an actual conversation at `https://chatgpt.com` active in that Edge window. The sidebar now displays a specific explanation if it cannot identify the tab. You do **not** need to rerun `install-host.ps1` if the extension ID has not changed.

If **Start for this conversation** leaves the status at Off, the extension has not confirmed a working recording session. The most common reason is an unregistered or outdated Windows native messaging host. The sidebar now has a **Test Windows connection** button; it sends a read-only probe and does **not** create a session or record a chat.

1. From the repository's `integrations\\chatgpt-browser` folder, rebuild and register the native host using the actual Edge extension ID:
   ```powershell
   .\\install-host.ps1 -ExtensionId "YOUR_32_CHARACTER_EDGE_EXTENSION_ID"
   ```
   From the repository root, use `.\\integrations\\chatgpt-browser\\install-host.ps1` instead.
2. Open `edge://extensions`, click **Reload** on Gentle Control Room, then return to an existing ChatGPT conversation.
3. Open the sidebar and click **Test Windows connection** before clicking Start. Expect **Connected. You can start recording a conversation.**
4. If the sidebar says **Not connected**, inspect the current-user host registration:
   ```powershell
   Get-ItemProperty "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.gentlecontrolroom.chatgpt"
   Get-Content "$env:LOCALAPPDATA\\GentleControlRoom\\BrowserNativeHost\\native-host.json"
   ```
   The manifest's `allowed_origins` must include `chrome-extension://YOUR_EXTENSION_ID/`, and its `path` executable must exist.
5. Try Start again. Expect **Recording**, an ON badge, and counts updating when ChatGPT renders new messages. Counts are approximate and may remain at zero when ChatGPT does not expose the expected role markers.

If Edge reports that the native host cannot be found, repeat installation. If it reports that access is forbidden, check the extension ID. If it reports that the host exited, rebuild the host and rerun the installer. Never share private chat content or credentials while troubleshooting.

## Recording is ON but message counts do not update

ChatGPT changed its conversation markup in October 2026. The original collector only recognized `data-message-author-role` attributes, which may now match zero elements. The updated observer first checks the **visible** `[data-app-action-timeline-scroll][role="region"]` and its role-specific structural markers. Legacy selectors remain as fallbacks. It never reads message text or the values of message identifiers.

**To apply the update:** run `git pull --ff-only origin main`, open `edge://extensions`, and press **Reload**. You do **not** need to rebuild/reinstall the native host or rerun the Codex hook setup for this JavaScript-only update. Reloading the extension ends in-progress observations, so return to the ChatGPT tab and click **Start for this conversation** again.

Under **Visible messages**, the sidebar now reports an observer status:

- **Page observer working:** the page exposes recognized markers and the Windows host acknowledged the latest count update.
- **Waiting for the ChatGPT page observer:** the content script has not checked in; stop, reload the ChatGPT tab, and restart.
- **Message layout is not recognized:** selectors are no longer supported; the collector will **not** send misleading zero counts.
- **Waiting for message containers:** ChatGPT has not mounted the conversation's visible timeline yet.
- **Last count update is older than 20 seconds:** check the local Windows connection if the visible messages have changed.

The counters are **not lifetime conversation totals**: ChatGPT may only mount some messages in a long or virtualized thread, and scrolling can change the displayed counts. A successful recording means local event metadata is being stored, not that every reply or conversation turn was captured.

## Coding activity in recurring patterns (v0.3.0)

The native **Recurring Patterns · Codex + ChatGPT** section now combines source-labeled signals from both local collectors. Each existing Codex sequence continues to use actual Codex hook events.

For an explicitly enabled ChatGPT conversation, this extension can now:

- Count rendered **code example containers** in the active ChatGPT conversation. This is structural metadata only: code contents, file paths, commands, prompts, and replies are not read or saved.
- Let you click **Mark as coding work** in the Edge side panel. Use this when you ask ChatGPT to edit files via connected tools or discuss implementation without displaying code examples. You can remove the tag before ending recording.
- Store only the number of rendered code examples and a yes/no coding tag alongside existing local session counts, via the same allowlisted Windows native messaging host.

A pattern appears after **at least three separate opted-in browser sessions** show the same coding signal. Repeated events within one session do not artificially create recurrence. Select **Last 7 days** or **Available history** in Gentle Control Room to include earlier sessions. The ChatGPT panel displays how many coding-related sessions and visible code examples have been captured for the selected period.

**Important attribution:** A code block appearing in ChatGPT or a user-marked coding session is evidence of coding-related discussion, **not proof that repository files changed or that ChatGPT performed an edit**. Verified coding tool patterns remain sourced from Codex hooks. Correlating GitHub commits would need a separate explicit integration and cannot be inferred from these browser counts.

### Upgrade and test

This upgrade changes the native event schema, so update **both** the browser extension and the native messaging host:

1. From repository root: `git pull --ff-only origin main`.
2. In Edge `edge://extensions`, click **Reload** for Gentle Control Room; verify version `0.3.0`.
3. Rebuild and re-register the Windows host:
   ```powershell
   .\\integrations\\chatgpt-browser\\install-host.ps1 -ExtensionId "YOUR_32_CHARACTER_EDGE_EXTENSION_ID"
   ```
   If you are already inside `integrations\\chatgpt-browser`, use `.\\install-host.ps1 -ExtensionId "YOUR_32_CHARACTER_EDGE_EXTENSION_ID"` instead.
4. Fully **Exit** the Gentle Control Room tray app and rebuild its native executable from the repository:
   ```powershell
   dotnet run --project .\\desktop\\GentleControlRoom.Desktop\\GentleControlRoom.Desktop.csproj -c Release
   ```
   Running the repo's executable does not automatically update a separately installed Start-menu copy.
5. Reopen the ChatGPT conversation in Edge. Start recording, use **Mark as coding work** (or view a code block), and check that the sidebar shows the new metadata. In the Windows app, select **Available history** and press **Refresh**.
6. To establish an actual recurring pattern, record **three distinct ChatGPT sessions** with that signal. The pattern should then appear in the combined list.

Existing browser activity files remain readable, but historical message counts from older extension versions **cannot** be retrospectively classified as coding.

## Local coding workflow analysis (v0.4.0)

Earlier versions counted code blocks and yes/no coding tags; **they could not identify what coding work was being requested**. Version 0.4.0 adds real but deliberately limited workflow inference.

From the Edge sidebar, **Start for this conversation** first. Then click **Enable workflow analysis** separately. While enabled, the content script briefly inspects currently rendered **user messages only** inside that conversation and classifies them using local keyword patterns into:

- Investigation
- Implementation
- Debugging
- Testing
- Version control
- Deployment

The text is never sent, retained, logged or saved. Only the allowlisted category and event timestamp are sent to the Windows native host. The mode is **OFF by default** for every new session. Disabling it stops further text inspection immediately; navigating to a different conversation also ends recording and analysis. At most 120 categorized requests are recorded per session. The first scan can include messages already visible in the current conversation; older unloaded history and chats that were never opted in cannot be analyzed retroactively.

The Windows **Recurring Patterns · Codex + ChatGPT** section now shows a **local coding workflow summary** even with one or two analyzed sessions. It reports which categories appear most often. Once the **same request category or ordered category transition** occurs in at least three separate analyzed ChatGPT sessions, it becomes an established recurring observation. For example, **Debugging → Implementation** may appear across three sessions, but this describes user requests, **not verified code edits or successful tests**. A short ambiguous prompt like "proceed" may not be classifiable. These are heuristic, descriptive observations, not a semantic AI interpretation of every message.

**Upgrade required:** this release adds the new allowlisted `workflow_stage` event to the native-host schema, so the browser extension, native host and desktop reader must all be updated.

```powershell
cd C:\\Users\\null\\Documents\\ChatGPT\\gentle-control-room
git pull --ff-only origin main
.\\integrations\\chatgpt-browser\\install-host.ps1 -ExtensionId "gdolleibohgppodmagaaojodmabnmnkh"
dotnet run --project .\\desktop\\GentleControlRoom.Desktop\\GentleControlRoom.Desktop.csproj -c Release
```

Fully exit the old Windows app from its system tray before starting the desktop command. Reload the Edge extension at `edge://extensions` and confirm version `0.4.0`. In a ChatGPT conversation, click Start, then **Enable workflow analysis**. The sidebar shows a categorized-request count. Select **Available history** in Gentle Control Room and Refresh. Once enabled, the first scan can classify currently rendered user messages, but existing local files cannot reconstruct old prompt content.

## Windows app session count stays unchanged

The browser's green badge confirms a currently approved session, but the **Windows app must be a current local desktop build** to display the newer reader. The installed Start-menu executable is not automatically updated by a `git pull`, and closing its window may leave the old application running in the system tray.

The sidebar's **Start for this conversation** applies to **one conversation**. If you navigate to another ChatGPT conversation, the observer stops. **New chats are not automatically enrolled.** To record several new chats, click Start separately in each one. Previously unrecorded chats cannot be backfilled from message text.

Run this safe, metadata-only diagnosis from the repository root:

```powershell
.\\scripts\\windows\\check-chatgpt-activity.ps1 -Period Today
.\\scripts\\windows\\check-chatgpt-activity.ps1 -Period All
```

It reports how many valid session IDs and confirmed starts are present in local JSONL files, how many message-count updates and coding tags were saved, and the most recent activity time. It **never prints session identifiers, chat text, or file contents**.

Interpretation:
- **Recorded sessions / confirmed starts increase:** the Edge native host is saving sessions. Fully exit the existing Windows app from the system tray and launch the newly compiled native desktop host, then press **Refresh** in ChatGPT Browser Activity.
- **The script remains at zero despite the green badge:** the native event files are not being written to the expected Windows account, or the event stream is failing. Reinstall the native messaging host and check the sidebar's Windows connection status.
- **Recorded sessions increase but coding-related sessions remain at zero:** the sessions did not include detected code example containers or an explicit **Mark as coding work** tag. This is expected and distinct from the total count.
- **Coding-related sessions increase but recurring patterns do not:** patterns require the same signal in at least three **distinct** approved sessions within the selected period. Use **Available history** in the app if the sessions occurred on earlier days.

For a local desktop build, use:

```powershell
dotnet run --project .\\desktop\\GentleControlRoom.Desktop\\GentleControlRoom.Desktop.csproj -c Release
```

The updated Windows panel shows **recorded sessions**, **confirmed starts**, **local files read**, and **latest recorded event**, so it can distinguish missing files from an old desktop build or a three-session pattern threshold. Refresh manually or allow the regular 20-second update cycle.

## Verify

Run the host's built-in validation before testing it in Edge:

```powershell
dotnet run --project .\integrations\chatgpt-browser\native-host\GentleControlRoom.ChatGPTHost.csproj -- --self-test
```

Expect exit code 0; no output is expected for this self-test.

Find saved events at:
`%LOCALAPPDATA%\GentleControlRoom\BrowserActivity\events-YYYYMMDD-NNN.jsonl`

Example record:

```json
{"schemaVersion":1,"source":"chatgpt_browser","timestamp":"2026-11-01T03:00:00Z","eventType":"visible_counts","sessionPseudonym":"random-uuid","visibleUser":3,"visibleAssistant":3}
```

Only allowlisted fields are written. Storage is local, unencrypted, inherits Windows account permissions, and uses daily JSONL files with 30-day cleanup when new events arrive. A conversation page reload or crash may leave an incomplete session; never assume an absent session-end event means an active session.

## Stop, uninstall, delete

- Click **Stop recording** in the right-side Edge panel to stop the current approved tab.
- Close the ChatGPT tab to end tracking. Navigating to another conversation also stops it; you must opt in again.
- Disable/remove the extension at `edge://extensions`.
- Unregister the native host: `.\integrations\chatgpt-browser\uninstall-host.ps1`
- To **delete all collected browser activity** using PowerShell:

  ```powershell
  Remove-Item "$env:LOCALAPPDATA\GentleControlRoom\BrowserActivity" -Recurse -Force
  ```

  Stop active browser collection before deleting, otherwise further events may be saved.

## Limitations and privacy boundaries

- Visible message counts reflect currently rendered ChatGPT DOM nodes, not guaranteed full history; never interpret these as definitive message totals.
- This browser collector does not capture Codex coding operations, prompt content, tasks completed, developer quality, or productivity.
- There is no continuous tracking outside explicitly enabled ChatGPT tabs, and no remote admin access.
- Reloading the unpacked extension usually keeps the same ID when the folder path is unchanged; if the ID changes, re-run the native host installer with the new ID. The Edge native host and its allowed origins follow Microsoft's native messaging protocol.
- If a host command fails, check the extension's service worker console in `edge://extensions` and confirm your extension ID matches the installed native manifest. **Do not** paste browser session tokens or private conversations into logs/issues.

## Tests

Run the browser extension unit tests using Node.js:

```powershell
node --test .\integrations\chatgpt-browser\tests\extension.test.mjs
```

Run the native host self-test:

```powershell
dotnet run --project .\integrations\chatgpt-browser\native-host\GentleControlRoom.ChatGPTHost.csproj -- --self-test
```

Run existing native desktop tests and build:

```powershell
dotnet run --project .\desktop\GentleControlRoom.Desktop.Tests\GentleControlRoom.Desktop.Tests.csproj
dotnet build .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj
```

The extension's permissions are intentionally scoped: `activeTab`, `scripting`, `storage`, `nativeMessaging`, and `sidePanel`, with host permissions for `https://chatgpt.com/*` and `https://chat.openai.com/*` **only**. These site permissions let the sidebar inspect a ChatGPT tab's URL and inject its metadata-only observer after an explicit Start click; no other sites are accessible through this permission. Native host approval is restricted to the specific extension ID. The hosted web dashboard is never granted the ability to read the native event files.
