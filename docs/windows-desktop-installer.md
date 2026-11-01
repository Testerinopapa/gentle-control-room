# Windows Desktop Packaging

## Recommended architecture

- Desktop framework: WPF on `.NET 8` with `Microsoft.Web.WebView2`.
- Runtime mode: `self-contained` by default for the desktop app.
- CPU target: `win-x64` only unless you have a real x86 or ARM64 requirement.
- Web UI delivery: package local HTML/CSS/JS inside `wwwroot/` and render it with WebView2.
- API integration: the WebView UI calls the backend API endpoints for desktop authentication and alert retrieval.
- Installer: Inno Setup 6 with bundled prerequisite installers.

Why this is the default:
- Self-contained removes the biggest non-browser prerequisite for non-technical users.
- WebView2 Evergreen keeps the rendering engine patched independently from your app.
- WPF + WebView2 keeps the host native while letting the UI stay web-based and easy to iterate.

## Self-contained vs framework-dependent

### Recommended default: self-contained

Use this for the packaged desktop app unless installer size is a critical problem.

Pros:
- No .NET runtime prerequisite for end users.
- Fewer helpdesk issues.
- Cleaner silent deployment.
- Predictable app startup environment.

Cons:
- Larger publish output.
- .NET security/runtime updates arrive only when you republish your app.

### Alternative: framework-dependent

Use this if you manage desktops centrally and want .NET serviced separately from the app.

Pros:
- Smaller installer.
- .NET runtime can roll forward with system servicing.

Cons:
- More installation failure modes.
- You must detect and install `.NET Desktop Runtime 8`.

The Inno Setup script in this repo supports both. The default packaging path assumes `self-contained`.

## Project structure

- `desktop/GentleControlRoom.Desktop/`
  Native WPF host and packaged WebView2 UI.
- `installer/GentleControlRoom.iss`
  Inno Setup script.
- `installer/prereqs/`
  Bundled prerequisite installers.
- `scripts/windows/publish-desktop.ps1`
  Desktop publish script.
- `scripts/windows/package-installer.ps1`
  Publish + package script.

## ChatGPT + Codex session reporting

The native activity dashboard shows **Codex session history** and **ChatGPT browser session history** as separate source-labeled sections. Near the top of the activity summary, it also shows a combined total for the selected **Today / Last 7 days / Available history** filter. The three Codex detailed statistics counters remain Codex-only; ChatGPT message counts do not become Codex tool operations.

The ChatGPT history lists up to 25 most recent opted-in sessions, ordered by their latest local event. Each entry can show safe timestamps, observed message counts, displayed code-example counts, voluntary coding tags, and the presence or absence of start/end markers. It never displays conversation text, titles, URLs, session pseudonyms, code, or token values. A missing boundary does not imply the session was still running.

To update the **Windows desktop app** after changes to this native dashboard:

```powershell
cd C:\\Users\\null\\Documents\\ChatGPT\\gentle-control-room
git pull --ff-only origin main
dotnet run --project .\\desktop\\GentleControlRoom.Desktop\\GentleControlRoom.Desktop.csproj -c Release
```

**Exit** any older Gentle Control Room instance from the Windows system tray before running the new build. An installed Start-menu copy does not update automatically when the repository changes. No Edge extension or native messaging host reinstall is needed for this dashboard-only change.

## Build pipeline

### 1. Restore

```powershell
dotnet restore .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj
```

### 2. Build

```powershell
dotnet build .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj -c Release
```

### 3. Publish

Recommended self-contained publish:

```powershell
dotnet publish .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=false `
  -p:PublishTrimmed=false `
  -p:PublishReadyToRun=true `
  -o .\artifacts\desktop\publish\win-x64
```

Framework-dependent alternative:

```powershell
dotnet publish .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj `
  -c Release `
  -r win-x64 `
  --self-contained false `
  -p:PublishSingleFile=false `
  -p:PublishTrimmed=false `
  -p:PublishReadyToRun=true `
  -o .\artifacts\desktop\publish\win-x64
```

### 4. Package

Recommended self-contained installer:

```powershell
.\scripts\windows\package-installer.ps1 -Configuration Release -RuntimeIdentifier win-x64 -Version 0.1.0
```

Framework-dependent installer:

```powershell
.\scripts\windows\package-installer.ps1 -Configuration Release -RuntimeIdentifier win-x64 -Version 0.1.0 -FrameworkDependent
```

## Dependency bundling guidance

Bundle in installer:
- Desktop app publish output.
- Evergreen WebView2 Runtime Standalone Installer (x64).
- .NET 8 Desktop Runtime installer only when using framework-dependent deployment.

Do not bundle by default:
- Fixed Version WebView2 runtime.

Why:
- Evergreen is Microsoft's recommended mode for most apps.
- Evergreen lowers browser-engine servicing burden.
- Fixed Version only makes sense when you must pin a specific engine version for compatibility certification.

## Backend CORS note

Because the desktop UI is served from the packaged WebView2 virtual host, the backend must allow:

```text
https://app.gentle-control-room.local
```

The sample `.env.example` in this repo already includes that origin in `CORS_ORIGIN`.

## Prerequisite detection order

1. Detect WebView2 Runtime.
2. If framework-dependent, detect `.NET Desktop Runtime 8`.
3. Install missing prerequisites silently.
4. Copy app files.
5. Create shortcuts and optional Run entry.

This order keeps failures obvious before the app files are laid down.

## Auto-start

The installer writes:

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\GentleControlRoom`

Value:

```text
"{app}\GentleControlRoom.Desktop.exe" --background
```

This starts the app in background/tray mode after the current user signs in, without requiring machine-wide Run key access.

## Common pitfalls

- Do not trim a WebView2 desktop app unless you have tested it thoroughly. Reflection-heavy UI stacks can break.
- Do not use single-file as the default packaging choice for this app. It complicates native dependency behavior and troubleshooting.
- Do not assume WebView2 is always present even on Windows 11 and managed Windows 10 estates.
- If you choose framework-dependent deployment, do not skip runtime detection.
- Package the Evergreen Standalone installer for offline or proxy-restricted environments.
- Keep installer architecture aligned with your publish RID. This repo is configured for `win-x64`.
