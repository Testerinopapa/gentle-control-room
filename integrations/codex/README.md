# Gentle Control Room — Codex local coding collector

**Phase 1 (local only).** This is a small Python 3.10+ command-hook integration for **OpenAI Codex**, not a VS Code extension. It observes *only* a few types of Codex activity for projects the local developer chooses. It does not monitor anyone else's screen, manual IDE edits, chat content, or applications. **Collection starts OFF.** No DeepSeek API, Supabase ingestion, central admin monitoring, or network transport is included.

## Prerequisites

- Windows 10/11, **native Windows Codex** (not Codex running under SSH, WSL or a remote container).
- Python 3.10+ (`python --version`) and Codex version supporting hooks.
- Existing Codex session with trusted hooks: [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks). Codex may have different support by client/mode; CLI, desktop app, `codex exec` and app-server sessions are **not assumed equivalent**.

## Windows setup (PowerShell)

From your cloned `gentle-control-room` repository root:

```powershell
python .\integrations\codex\collector.py install
python .\integrations\codex\collector.py status
python .\integrations\codex\collector.py enable-project "C:\Users\null\Documents\ChatGPT\gentle-control-room"
# Read the disclosure and type ENABLE to give project-level consent.
python .\integrations\codex\collector.py resume
```

Replace the sample repository path with your actual local project. **Enabling a project does not automatically resume collection.** All approved projects are explicitly recorded in local consent settings, and a paused collector records nothing.

Run **Codex** within that project. In Codex CLI, use `/hooks` to **review and trust** the registered hook commands; hooks are skipped until trusted. Installing this collector does not bypass Codex trust review or force-enable hooks. If your environment uses `CODEX_HOME`, the installer respects that path. Restart Codex as appropriate after changing hooks.

```powershell
python .\integrations\codex\collector.py status
python .\integrations\codex\collector.py patterns
python .\integrations\codex\collector.py show-events
python .\integrations\codex\collector.py pause
python .\integrations\codex\collector.py delete-events
```

To revoke project consent and uninstall hook entries:

```powershell
python .\integrations\codex\collector.py pause
python .\integrations\codex\collector.py revoke-project "C:\Users\null\Documents\ChatGPT\gentle-control-room"
python .\integrations\codex\collector.py delete-events
python .\integrations\codex\collector.py uninstall
```

Uninstall **does not silently delete local consent records**; use `revoke-project` or delete `consent.json` under the local store if you want to erase approved paths. Deleting `consent.json` resets collection to OFF and invalidates old pseudonym mappings. The installer edits **only** its own entries in `~/.codex/hooks.json`, preserves other hooks, and creates timestamped backups. It does not modify `config.toml`, disable existing hooks, or silently trust itself. You can also inspect/disable hooks in Codex `/hooks`.

## Event schema

One JSONL object per emitted, allowed hook:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-10-31T20:00:00Z",
  "eventType": "tool_used",
  "sessionPseudonym": "randomized-hmac-prefix",
  "projectPseudonym": "random-uuid-hex",
  "toolCategory": "file_edit"
}
```

`eventType` can be `session_started`, `prompt_submitted` (**count only**), `tool_used`, `turn_finished`, or `session_ended`. For tool events, `toolCategory` is limited to `file_edit`, `shell`, `test_build`, `inspect`, `git`, `other`. **Shell command contents are never inspected**, so a test or build executed via Bash is reported as `shell`, not as a confirmed test. `patterns` provides a local frequency and adjacent tool-category sequence summary; these do not measure actual work quality, job performance or coding skills.

No prompts, assistant responses, filenames, absolute paths, repo names, source code, diffs, shell commands/outputs, file contents, tool inputs/outputs, transcripts, Git messages, model names, usernames, credentials or keystrokes are persisted. `cwd` is only checked against approved local projects; `session_id` is HMAC-pseudonymized using a random secret stored **only in local consent configuration**. This means the local consent file itself contains the chosen project paths; event JSONL does not.

## Storage and limits

- Events: `%LOCALAPPDATA%\GentleControlRoom\CodexActivity\events-YYYYMMDD-NNN.jsonl`.
- Consent: `%LOCALAPPDATA%\GentleControlRoom\CodexActivity\consent.json`.
- UTC timestamps; rotate around 5 MiB per file, cap around 50 MiB across event files; remove data older than 30 days on new event writes.
- Synchronized writes using OS file locking, and atomic consent changes. No network calls; no dependency beyond Python standard library.
- These files inherit your Windows user profile permissions. They are **not encrypted**; don't use a shared Windows account for private work. Keep the clone and app configuration out of public shared drives.
- Deletion is local and synchronized with new events, but cannot remove independent backups already created by your computer.

## Compatibility and limitations

Official Codex documentation lists `~/.codex/hooks.json` and lifecycle command hooks: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`. The installed hooks read one JSON object from stdin and **exit 0 with no output**. Session termination is not guaranteed on a crash or when a client doesn't dispatch that event. Some Codex versions/modes omit individual hooks; in particular, do not assume that `codex exec` or app-server programmatic threads emit all interactive hooks. Verify on your Windows Codex installation. If `status` shows `hooksConfigured: true` but events remain zero, check that the Codex client actually loads hooks, that `/hooks` reports them trusted, and that the working directory is within an approved workspace.

The installed command uses the absolute Python and collector paths at installation time: **re-run `install` after moving the repository or changing Python environments**. You can remove old entries using the original installation before moving the folder. There is no background service; events are only written when Codex invokes a hook.

This phase intentionally does **not** add any UI to the Windows desktop application. A subsequent phase can show a read-only aggregate after securing the native bridge and its existing raw-message diagnostics. Never expose the per-user local event store to the remote admin dashboard without a separate security and informed-consent design.

## Run automated tests

From repository root:

```powershell
python -m unittest discover -s integrations/codex/tests -v
```

Automated tests also run on Unix for pure functions and filesystem checks, but the actual collector command **requires native Windows**. A real Windows/Codex smoke test must confirm hook trust and event dispatch before claiming end-to-end support.

## Windows desktop application — local Codex Activity panel

The Windows WPF host now displays a **Codex Activity · Local** read-only panel directly beneath the existing WebView. This panel is rendered by native WPF, not by the hosted React/HTML application, and **never sends local Codex metrics to the web page, Supabase or administrators**.

- It shows `Not installed`, `Off`, `Paused`, `Recording`, `Hooks missing`, or `Unavailable`. `Recording` describes the consent/hook configuration; it does not guarantee that a given Codex client emits events.
- Counters show approved projects, unique session-start identifiers, tool-use events and total events recorded **today in UTC**, plus a label and UTC time for the most recent allowlisted event.
- It refreshes roughly every 20 seconds and includes a **Refresh** button. No pause, resume or consent changes are available from the hosted application; use the local Python CLI commands above.
- If `CODEX_HOME` is customized, make sure the Windows host uses the same environment variable as the collector, or its hook status may say `Hooks missing` even though local events exist.
- On Windows, rebuild and restart the host with `dotnet run --project .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj` from the repository root. If running the embedded web UI through `localhost:8080`, keep `npm run dev` running separately. The native activity panel itself does not require Vite.
- Older `%LOCALAPPDATA%\GentleControlRoom\logs\desktop-host.log` entries may contain credential-bearing raw WebView messages, although new versions no longer log raw messages. Delete old diagnostics after confirming they are not needed, and invalidate any still-active logged credentials.

### Windows manual verification

1. Check `python .\integrations\codex\collector.py status` and `show-events` first, confirming that your Codex Desktop session has produced events.
2. Start the WPF app. The native panel must appear beneath the existing alerts/login web interface; project count and today's event totals should agree with the collector output.
3. Run a Codex Desktop task in an approved local project, then click Refresh (or wait 20 seconds). Expect the counters to increase. A session started by an earlier manual diagnostic will still be counted.
4. Run `python .\integrations\codex\collector.py pause`, then refresh and confirm the status reads `Paused`. Use `resume` to continue. Pausing must not add new events.
5. Confirm the regular desktop sign-in, incoming alert display, notification popups, acknowledgement and tray functionality still work.
6. Run `dotnet build .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj` to validate Windows compilation.

Local file reading is scoped to the signed-in Windows account. The panel intentionally does not expose raw events, pseudonyms, consent secrets, project paths, prompts, source contents or diagnostics via the WebView bridge. It does not monitor manual coding outside Codex.
