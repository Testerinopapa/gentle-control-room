# Phase 1 — Codex-native activity collector (Codex implementation specification)

## Corrected product objective

Integrate directly with **OpenAI Codex** as the developer's local agentic coding environment. The project should learn high-level patterns in how an opted-in developer uses **Codex** to accomplish coding tasks: session frequency, task iteration, tool classes, test/build cycles, and repeated workflow sequences.

**Codex is the activity source, not merely the coding assistant implementing the feature.** There is no VS Code/Cursor extension in Phase 1, and no assumption that the user is editing manually in a traditional IDE. Do not add an editor extension.

Use this spec to implement the local Phase 1 collector in Gentle Control Room. Work on `main`, run tests, and push verified commits directly to `main`. Do not open a PR unless blocked from pushing. Do not implement DeepSeek analysis yet.

## Integration approach

**Primary route:** Codex's officially supported **command hooks**. Hook events can provide session/turn lifecycle and local tool use without reading private transcripts. Review current documentation at https://learn.chatgpt.com/docs/hooks before implementing. Use actual documented event names and payload schemas, never guess names. Start with `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd` where supported and verified; degrade gracefully when specific events are not emitted by a particular Codex client/mode. Hook callbacks can receive highly sensitive payloads; treat the entire input as untrusted/private and **allowlist a very small set of safe derived fields only**.

Codex CLI, desktop app, `codex exec` and IDE integrations may have differing hook coverage. **Do not claim coverage you haven't validated.** Verify locally in the active Codex client/version. Codex's `codex exec` mode may not emit every interactive hook; document observed coverage and test it separately. If a mode does not support the needed hooks, show `Unsupported / incomplete coverage` rather than silently reading transcripts or claiming the collection is complete.

**Optional future path, not Phase 1:** Codex SDK or app-server (https://developers.openai.com/blog/codex-as-a-platform) for sessions that Gentle Control Room itself launches and manages. Do not claim that app-server attaches to an arbitrary existing Codex desktop process.

## Existing repository context

- React/Vite/TypeScript UI: `src/`. The user-facing Windows web view is `src/pages/Desktop.tsx`.
- Windows host: `desktop/GentleControlRoom.Desktop/` (WPF / WebView2); native bridge in `MainWindow.xaml.cs`.
- Current Windows host may load hosted React UI; packaged `wwwroot` is a separate, older path.
- Web dashboard uses Supabase; an alternate Express/Prisma prototype also exists. **Do not add backend event ingestion** in Phase 1.
- Fix existing native bridge secret leakage first: `MainWindow.xaml.cs` currently logs raw `WebMessageAsJson`, potentially persisting `desktop.auth.session` credentials. Log only safe event type names and no payloads, before extending the bridge.
- Preserve emergency alert delivery, user sign-in, and existing notifications.

## Deliverable A — Local Codex hook collector

Create `integrations/codex/` (not `integrations/vscode/`) with a minimal typed collector executable/script, hook configuration templates, setup/uninstall commands, a schema document, and automated tests.

1. **Explicit local opt-in**. Clean install collects zero events. The developer chooses permitted local projects/workspaces, and an obvious global pause is enabled initially. A hook MUST check user consent and selected project scope **on every invocation**. Installing a hook does not itself grant consent. Unsupported or ambiguous project paths fail closed.
2. **Never overwrite an existing Codex config.** Provide idempotent setup that backs up and safely merges only the approved hook entries in user-level `~/.codex/hooks.json` or supported `config.toml` paths. Project-specific hooks are acceptable only where the user explicitly trusts that project's configuration. Respect `CODEX_HOME` and Codex hook trust requirements. Document how to disable and uninstall hooks cleanly without deleting unrelated user settings.
3. Prefer a **fast nonblocking/safe hook**: read hook JSON from stdin; never print original input. Keep hook outputs minimal/empty, without modifying Codex prompts or enforcing policy. Never block normal Codex work if the collector fails. Handle unsupported clients with honest diagnostics. Avoid expensive operations in the hook path; use locally queued writes when needed.
4. The primary allowlisted event schema should include: `schemaVersion`, ISO `timestamp`, normalized `eventType` (session_started, prompt_submitted [count only], tool_used, turn_finished, session_ended), random `sessionPseudonym`, random `projectPseudonym`, and **coarse** `toolCategory` when applicable (e.g. file-edit, test/build, git, search/inspect, other). Normalize on trusted, documented tool identifiers, not on raw commands, arguments, file names, tool outputs, or prompt text. A session is identified only locally by a randomized mapping; do not persist raw Codex session IDs in event JSONL.
5. Derive only high-level patterns: repeated test cycles, file-edit→test cycles, tool-category frequencies, started/completed sessions, and rough sequencing. **Do not claim to know human reasoning, actual quality, precise work time, or edits done outside Codex.**
6. **Never store** user prompts, assistant responses, private transcripts or transcript paths, code, diffs, tool input/output, raw command lines, shell output, file names/paths, Git commit messages, repository names, access tokens, API keys, clipboard, screenshots, keystrokes, email, or contents of unrelated apps. The hook may use `cwd` transiently to check consent but must not write it into event logs. Keep mapping/approved workspace paths separate in per-user consent settings only. Do not read raw Codex transcript JSONL.
7. **Local-only storage:** under the current Windows account's `%LOCALAPPDATA%/GentleControlRoom/CodexActivity/`, JSONL events plus local consent metadata. Rotation, bounded file size, default 30-day retention, deletion, explicit pause/revoke, atomic config updates, and multi-process-safe append strategy. No network telemetry or remote upload. For non-Windows or WSL/SSH/remote Codex execution, clearly report unsupported until a local-only architecture is explicitly designed/tested.
8. Provide a minimal Windows console setup/status command with `install`, `status`, `enable-project`, `pause`, `resume`, `show-events`, `delete-events`, and `uninstall` or equivalent user-facing mechanisms. Consent must remain controlled by the local user, never by an admin/superadmin account. If no interactive shell is available, provide a simple visible local consent dialog.
9. Events must not leak through diagnostics, stdout/stderr, Codex hook output, or PowerShell history. Test malformed/unexpected JSON inputs, path traversal, concurrent hooks, unsupported/unknown event types, hook timeouts, and absence of the local storage directory.

## Deliverable B — Existing Gentle Control Room Windows app

1. Add a compact **Codex Activity (Local)** section in `src/pages/Desktop.tsx` for **the local Windows user only** (not the management dashboard). Show whether the hooks are installed/trusted, On/Paused/Off/Unsupported, number of opted-in projects, sessions today, and tool-category counts. Never fabricate values if the collector is missing.
2. WPF/WebView2 may read only a carefully bounded, local derived summary; verify message type/source and strict origin allowlist. Do not expose raw events to arbitrary remote pages or allow arbitrary file access. The host must not grant first-time consent or turn collection on. If robust origin/source checks are impractical, keep the Windows integration read-only with fewer features, or provide just the local CLI/status UI first.
3. A desktop pause button is optional **only if** it can safely prevent further events immediately without granting new consent. Canonical opt-in must remain with the developer.
4. Preserve alert/auth/tray flows. Reuse existing minimal UI visual language; use main text >=16px.

## Local acceptance tests

- **First install:** no events before explicit opt-in (including when hooks are registered but there is no consent).
- **Workspace separation:** opted-in project A generates events; unapproved project B produces none even inside the same Codex account.
- **Pause/revoke/delete:** pause stops new events immediately; revoke removes consent; deletion clears JSONL files and in-memory buffers. Multiple simultaneous hooks cannot resurrect deleted data.
- **Sanitization:** feed fake prompts, API keys, sensitive paths, raw tool commands, transcripts and tool results to the hook; assert none are recorded or echoed.
- **Hook compatibility:** verify documented event schema and compatibility with the actual Codex client/mode on Windows, noting modes that do not emit hooks (particularly noninteractive execution).
- **Isolation:** different Windows users cannot read each other's local data.
- **Logging:** native host logs contain no access/refresh tokens or raw WebView messages.
- **No network traffic:** collection adds no network sender; DeepSeek and Supabase event ingestion are absent.
- **Regression:** the existing desktop emergency notifications/login continue to work.

## Documentation and delivery

Add README explaining supported Codex clients/modes, hook installation and trust, permissions, event schema, what is not captured, opt-in, pause, deletion, uninstall, privacy limitations, and manual Windows smoke tests. Include commands for running unit tests/build and a truthful report of what could not be exercised.

When implementing, inspect actual current hook docs and local Codex installation before choosing config shape; never replace user configuration wholesale. Ship Deliverable A before Deliverable B and keep Phase 1 entirely local. Work directly on `main`, commit and push verified changes. Do not alter the other application features.

## Clear scope boundary

This Phase 1 observes **Codex-assisted coding interactions only**. Monitoring code manually written in an IDE, reconstructing complete job performance, inferring private intentions, centralized staff monitoring, and using DeepSeek to analyze collected data are separate projects and are not part of this phase.
