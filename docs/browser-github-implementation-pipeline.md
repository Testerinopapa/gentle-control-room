# Browser-linked GitHub code evidence (no new UI)

The extension already forwards opted-in activity through Edge Native Messaging to the
Windows app. This update adds one strict event type, `github_commit_ref`.

**Flow:** The extension sees a link to a specific GitHub commit in an assistant
message within the active opted-in ChatGPT conversation. With the separate
**Enable workflow analysis** switch ON, it sends only the GitHub `owner/repo`,
full 40-character commit hash and the existing random browser session ID to
the installed native host. It never transmits assistant prose, code blocks,
conversation URLs, or arbitrary link destinations.

The native host validates and writes the allowlisted JSONL event into the same
`BrowserActivity` store the Windows app already reads. The existing Coding
Work Analysis 30-second timer now imports this event automatically. If a local
Git repository is **already approved** in Code Changes, its `origin` must match
the referenced GitHub repository. The app then queries GitHub's **public commit
API** directly for the exact code patch, stores it encrypted locally and links
it to the browser's session pseudonym.

**No `git pull` is needed to fetch those future remote commit patches.**
A local standard Git clone with an approved GitHub `origin` is still needed
for the existing consent mechanism; this does not infer permission from a
link. The Windows app does not execute code or push/pull/modify the repo.
Private commits requiring GitHub credentials are currently unsupported.

## Upgrade your installed components once

From the checkout, get the updated implementation:

```powershell
git pull --ff-only origin main
# In Edge edge://extensions, reload the unpacked Gentle Control Room extension
# Use its current 32-character ID to reinstall/rebuild the host:
.\integrations\chatgpt-browser\install-host.ps1 -ExtensionId YOUR_EDGE_EXTENSION_ID
# Exit the old app from the tray and launch the newly built native host:
dotnet run --project .\desktop\GentleControlRoom.Desktop\GentleControlRoom.Desktop.csproj -c Release
```

Then enable local coding analysis, approve a repository whose `origin` points
to GitHub, and start browser recording plus **Enable workflow analysis** for
the ChatGPT conversation. When an assistant reply contains a visible exact
`https://github.com/owner/repo/commit/40-hex-sha` link, the extension delivers
one reference event, not the content. The Windows app imports the patch on
its next check and shows it under existing **Code Changes > Recent file snapshots**.
The layer is **GitHub commit**; inspect **Exact local differences**.

Test with the sample commit:
`https://github.com/Testerinopapa/gentle-control-room/commit/28de267f6353f99977c5185080f5573a45ab12de`
and the sample JSON fixture at
`integrations/chatgpt-browser/fixtures/github-commit-evidence.json`.
The example JSON is a fixture, **not** proof that a real Windows installation
received the event.

## What this does not claim

- A link is evidence it appeared in the assistant message. It **does not**
  prove ChatGPT authored the commit or even requested the changes.
- Code changes are fetched only from **public GitHub repositories** whose
  `origin` matches an approved local repository. An unlinked hidden connector
  edit cannot be seen by the extension; a visible commit URL is required.
- The extension does not send code. The Windows app fetches patch hunks from
  GitHub only after its own local repo consent check.
- Old native host binaries reject the new event; reload/reinstall the host.
- Links not rendered in currently mounted messages may be missed.
- Diff metadata is not proof of testing, deployment or success.
- The app does not automatically assign changes to tasks, call DeepSeek, or
  send patches to external AI. To analyze, associate a change with a task,
  select the evidence, and review/approve the precise DeepSeek request.
- Changes remain protected by the current-user Windows DPAPI store and the
  original expiry/size limits; private code may still be sensitive even
  after known secret patterns are minimized.

Tests cover extension consent/deduplication, native-host schema validation,
Windows evidence normalization, matching approved remote, fake-HTTP patch
fetch, session linkage, revocation, and outbound source-selection boundaries.
No real Windows interactive or live DeepSeek test is asserted.
