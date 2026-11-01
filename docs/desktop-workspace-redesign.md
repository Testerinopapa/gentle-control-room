# Desktop workspace redesign

The native WPF window now places WebView2 and Codex Activity in one centered,
scrollable workspace. Both cards share a 672-DIP content width and 12-DIP side
insets. The WebView2 composition control supports clipping inside the WPF
scroller. Measured web content controls browser height; window height includes
the native dashboard and is capped to the Windows work area. Resizing width is
left to the user to avoid measurement feedback loops. Older hosted clients that
do not measure their login form retain a 600-DIP scrollable browser fallback.

The React desktop route measures both login and authenticated views, uses a
16px minimum text baseline, stacks at narrow widths, and scrolls all available
alerts. Deploy the updated React assets when using a hosted URL; a desktop-only
update cannot change an older hosted login page. Bundled builds should run
`npm run build` before building the desktop project.

## Local activity and privacy

The native dashboard shows collector state independently of event arrival,
approved-project count, today's session/tool/event totals, six category bars,
and the five newest events across retained local files. Today and displayed
timestamps use the Windows user's local time zone. Session counts deduplicate
session-start events within the day, preserving the existing definition.
Unknown tool categories become Other; unknown event types are ignored.

Only fixed labels, counts, and timestamps leave the reader. Session pseudonyms
are used internally for counting only. Paths, secrets, prompts, source, raw
records, and identifiers never enter the snapshot or WebView2. No new network
calls or activity messages were added. Existing consent and hook installation
remain unchanged. Reads run on a worker task, with overlapping refreshes
suppressed and automatic refresh every 20 seconds.

## Validation (2026-10-31)

- Windows desktop build succeeded with zero warnings/errors using a separate
  output folder because the user's running Debug executable was locked.
- Launched the isolated build: process was responsive, its window title was
  Gentle Control Room, and the host recorded successful WebView initialization.
- Ten reader fixture assertions passed: missing/malformed consent, empty
  recording state, local-date boundaries, duplicate sessions, all categories,
  malformed/future records, newest-five ordering, privacy allowlist, paused/off
  state, and appended-event refresh. Fixtures never modify the user's store.
- Read the real current-user store successfully and received genuine aggregate
  counts and recent category/timestamp pairs. No sample events were injected.
- All 17 existing Python collector tests passed.
- Existing Vitest test and the new login-to-alerts sizing test passed.
- Production web build passed; existing font-import ordering, Browserslist age,
  and bundle-size warnings remain.
- Static review confirmed activity is assigned only to native controls. The
  web sizing hook sends dimensions only.

Commands:

```powershell
npm run build
npm test
dotnet build desktop/GentleControlRoom.Desktop/GentleControlRoom.Desktop.csproj -o .artifacts/desktop-redesign
dotnet run --project desktop/GentleControlRoom.Desktop.Tests
python -m unittest discover -s integrations/codex/tests
```

The optional reader-test argument `--local` prints the allowlisted snapshot for
local diagnostics; do not publish its output as a test artifact.

## Remaining manual verification

The Windows computer-use helper repeatedly timed out, including after reset.
Startup was verified through process state and the host's initialization marker,
but visual inspection and interaction were not completed. Before distributing:

1. Check login, empty alerts, and long alert lists at normal and minimum widths.
2. Check empty activity and populated bars/recent rows, plus manual/20-second
   refresh after genuine collector activity.
3. Minimize/restore and close/restore through the tray; receive and acknowledge
   a real background alert with an authenticated test account.
4. Inspect layout on secondary monitors and non-default display scaling.

Authentication, notifications, acknowledgments, and tray handlers were retained;
these flows have not been exercised end to end in this validation session.
