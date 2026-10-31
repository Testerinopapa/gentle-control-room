# Phase 1 — Opt-in coding activity collector (Codex task)

## Objective

Add a **local-only, opt-in Coding Intelligence foundation** to Gentle Control Room. Build an IDE extension for VS Code / Cursor, plus a small, transparent status integration with the existing Windows tray app. The purpose of this phase is to record **non-sensitive metadata** about coding workflows in explicitly selected workspaces. It is NOT a staff surveillance tool.

**Do not add DeepSeek, Harness, remote analytics, Supabase event ingestion, manager-facing activity feeds, or job replication in Phase 1.** Never capture screenshots, keystrokes, clipboard data, terminal output, source-code content, diffs, file names/paths, Git messages, repository names, credentials, or private communication.

## Repository context

- React dashboard: `src/`, Vite + TypeScript + Tailwind.
- Current Windows UI: `src/pages/Desktop.tsx` when injected `window.__desktopConfig` is present.
- Windows host: `desktop/GentleControlRoom.Desktop/` (.NET WPF + WebView2), with host message handling in `MainWindow.xaml.cs`.
- Default Windows host points to hosted React UI (`desktop/GentleControlRoom.Desktop/appsettings.json`), though packaged `wwwroot` also exists.
- Supabase Edge Functions power the web dashboard, while a separate Express/Prisma prototype exists. Do not modify either backend or existing alert/auth flows.
- **Security prerequisite:** `MainWindow.xaml.cs` currently logs raw WebView messages to `%LOCALAPPDATA%/GentleControlRoom/logs/desktop-host.log`, including possible token-bearing `desktop.auth.session` payloads. Replace raw logging with allowlisted, token-free event names before extending any bridge. Avoid logging local coding events or contents.

## Deliverable A: IDE extension

Create `integrations/vscode/` containing a proper TypeScript VS Code extension, its own manifest/build scripts, automated tests and installable VSIX packaging instructions.

1. **Off by default:** On clean install, collect nothing. Ask the developer to consent for each selected workspace explicitly. Do not auto-enroll other folders, restore consent after it was revoked, or silently enable collection through Windows/app config.
2. Display a persistent status bar indicator: `Off`, `Paused`, or `Recording`, with accessible commands: `Enable for this workspace`, `Pause`, `Resume`, `View local events`, `Delete local events`, `Show settings`. A separate pause control must stop collection immediately.
3. Use documented VS Code extension APIs such as `workspace.onDidSaveTextDocument` and workspace lifecycle events. For approved local workspaces only, record **ISO timestamp, event type, VS Code language ID, random locally generated workspace pseudonym**, and a schema version. Record a coarse `session_started` / `session_ended` where meaningful. If the event is outside an enrolled local workspace, ignore it.
4. Do not collect file names/paths, directory paths, code/diffs, content lengths from sensitive files, Git branch names, commit messages, process names, clipboard, keystrokes, or shell history. Skip untitled/virtual documents, generated files, and excluded directories; skip unknown ambiguous workspace relationships rather than over-collecting.
5. Save JSONL only on the local Windows user account (e.g. `%LOCALAPPDATA%/GentleControlRoom/CodingActivity/`), with bounded storage, daily rotation, and 30-day default retention. Use atomic writes for consent/config and a strategy safe for multiple IDE windows. If the extension host runs on another machine (SSH/WSL/container) or on unsupported OS, display an explicit unsupported warning and capture nothing rather than writing to the wrong machine.
6. Every record should be inspectable and deletable with the extension commands; deleting also clears outstanding write buffers. No telemetry or event network requests.
7. Put explicit, minimal explanations in the UI: what is collected, what is never collected, where data lives, when collection is active, and how to stop/delete it.

## Deliverable B: minimal Windows app integration

1. In the current desktop user view (`src/pages/Desktop.tsx`), add a compact **Local Coding Activity** section displaying extension availability, Off/Paused/Recording status, approved workspace count, and events recorded today. If extension is absent, show `Not installed` / `Off`, never a fabricated value.
2. Extend the native WPF <-> WebView2 bridge **minimally and defensively** for local, read-only status retrieval. Validate message types and message origin/source. Do not allow arbitrary filesystem paths, shell execution, network requests, or broad browser/native privileges. Do not expose coding observations to the admin dashboard.
3. Include a pause command in the Windows desktop panel **only if** the bridge can safely update an already-consented local collector. It must not grant first-time consent or remotely activate collection. Otherwise keep the Windows panel read-only and make the IDE status bar the canonical pause control.
4. Avoid changing existing emergency alert behavior and authentication/tray logic. Keep new UI simple and legible (>=16px for its main text).
5. The locally bundled `desktop/GentleControlRoom.Desktop/wwwroot` is a separate UI; document its supported/fallback status and do not imply it automatically shares the React component.

## Security/quality acceptance tests

- Fresh install captures **zero** events until first explicit opt-in.
- Enrolling workspace A never captures events from workspace B.
- Pause or revoke immediately prevents new events; deleting clears all collected events and pending buffers.
- No captured event contains code, file paths/names, credentials, keystrokes, screenshots, clipboard, repo names, Git messages, or private communication.
- Events stay on-device; verify that no collection-related network requests occur.
- A Windows user cannot access a different Windows account's activity store.
- Log files cannot contain authentication credentials, tokens or event contents.
- Previously existing alert creation, notification, acknowledgment, and desktop login flows continue to operate.
- Test absence of extension, malformed JSONL, app restarts, multi-window use, storage errors, and retention cleanup.
- Add meaningful automated unit tests covering consent, workspace scope, pause/resume, sanitization, retention and deletion.
- Run and report relevant typecheck/lint/test/build commands, noting environment-dependent tasks that could not be run.

## Implementation process

Work directly on branch `main`. Implement Deliverable A first, then Deliverable B. Prefer minimal independently testable modules; avoid adding heavy runtime dependencies or coupling the VS Code extension to the entire Vite build. Document end-to-end Windows smoke tests and installation instructions (`npm install`, build, create VSIX, install in VS Code and Cursor where supported). Do not put access tokens or other secrets in docs.

**When finished:** commit and push tested changes directly to `main` (no feature branch or PR needed). Describe what was implemented, the exact local event schema, testing results, and limitations. If a safe native integration cannot be finished, provide the extension with working controls and document the Windows integration as follow-up rather than weakening consent/security.
