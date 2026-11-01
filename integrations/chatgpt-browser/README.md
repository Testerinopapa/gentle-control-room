# ChatGPT Browser Activity — Microsoft Edge sidebar extension (Phase 1)

Opt-in, **local-only** metadata collection for ChatGPT conversations in Edge. This integration is independent of Codex CLI hooks. The Windows Gentle Control Room application reads a summary of its events from the **current Windows account**, and neither hosted WebView pages nor Supabase see them.

## What this collects

For each conversation you explicitly turn ON in Edge, the extension records:
- start and stop of the approved browser session;
- approximate **visible** counts of user and assistant message elements (only when that page exposes standard role markers);
- event timestamp and a newly generated, random session identifier.

**It does not read or store prompt text, assistant responses, code, message titles, conversation URLs, conversation IDs, browser cookies, credentials, tokens, clipboard, or other tabs.** No network endpoints, fetch clients or background requests are used. This is not ChatGPT account integration and cannot observe all chats automatically. DOM markers may be missing or virtualized, so counts are estimates, not authoritative conversation totals.

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

The extension's permissions are intentionally narrow: `activeTab`, `scripting`, `storage`, `nativeMessaging`, and `sidePanel`. Native host approval is restricted to the specific extension ID. The hosted web dashboard is never granted the ability to read the native event files.
