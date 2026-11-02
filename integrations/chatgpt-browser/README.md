# Gentle Control Room — standalone Edge coding evidence extension (v0.6)

**The Windows application and native messaging host are no longer required.**
This extension works on its own in Microsoft Edge (and compatible Chromium-based
browsers with side-panel support). It keeps activity evidence in
`chrome.storage.local`, not on a remote server. Existing legacy Windows
`.jsonl` files do not automatically migrate into this storage.

## Install / update

1. Update your checkout: `git pull --ff-only origin main`.
2. Open `edge://extensions`, switch on **Developer mode**, and use **Load unpacked**
   to select `integrations/chatgpt-browser/extension` (only if not already loaded).
3. For an existing unpacked extension, click **Reload**. Version must read
   **0.6.0**. Reload the ChatGPT tab itself as well.
4. Open a ChatGPT conversation, open the extension side panel, and select
   **Start for this conversation**.
5. Choose **Enable workflow analysis** separately for local classification of
   visible user requests and GitHub commit evidence capture.
6. The extension recognizes complete GitHub commit URLs in assistant HTML
   links **or visible plain text**. If ChatGPT renders only a link label
   with no accessible URL, paste the complete GitHub commit URL in the
   **Evidence → GitHub commit URL** field and click **Import commit evidence**.
   This is a manual fallback, not automatic access to hidden ChatGPT tool calls.
7. Use **Export evidence JSON** in the extension panel. No Windows steps required.

The extension's host permissions are restricted to ChatGPT and
`https://api.github.com/*`; no blanket access to GitHub webpages or the
computer's filesystem is used.

## What is captured

- Opted-in session start/stop timestamps with a fresh random local session ID.
- Visible message counts and code-block counts, where available.
- User-selected coding tag and locally classified workflow stages. User text is
  inspected transiently only when workflow analysis is ON and is never saved.
- Exact **public GitHub commit URL references** observed as links inside
  assistant messages, reduced to `owner/repo` plus the 40-character SHA.
- When workflow analysis is ON, the extension can fetch a matching public
  commit's changed file patch hunks directly from GitHub's public API. It stores
  bounded, filtered patch data locally along with the link's session ID.
- A downloadable `gentle-control-room-evidence.json` including recorded
  chronology, commit references and available exact patches.

The extension does not inspect other tabs, cookies, session tokens,
conversation titles/URLs or any arbitrary local Git repositories. It does not
transmit private ChatGPT text or patches to DeepSeek or any AI service. Fetching
a public commit sends that public repository and SHA to GitHub. Export is a
local browser download.

## Data lifecycle / consent

Recording and workflow analysis start OFF. Stop revokes ongoing collection for
that conversation; changing conversations also stops it. Each new
conversation requires separate consent. **Delete stored evidence** in the
side panel removes recorded events and cached code patches. Deletion does not
stop an already active recording; use **Stop recording** separately.

Browser storage retains at most 30 days, 1,500 metadata events and 30 commit
records, with an approximate 3.5-million-character overall limit. Individual
file patches are bounded; dangerous filenames and some obvious token formats
are filtered. **Filtering is not a guarantee of removing every secret**;
review exported JSON before sending it to any model or person. Browser profile
data might be backed up by the operating system; no encryption-at-rest claim
is made beyond browser/OS protections.

## Scope and limits

The extension cannot read hidden ChatGPT connector activity, remotely executed
tool calls without a displayed commit link, or uncommitted local source files.
It does **not** automatically infer authorship, working results, testing,
successful implementation, or deployment. It does not prove that a visible
commit was created by ChatGPT. Private GitHub repos requiring credentials are
not supported. Large or binary patches are omitted. ChatGPT virtualized
message history may omit older rendered links and requests.

This is an **evidence collection and export MVP**, not a complete agent that
already learns entire jobs or runs DeepSeek automatically. The JSON is intended
for subsequent deliberate pattern analysis. For example, provide it in this
conversation for analysis after reviewing its contents.

## Debugging

If an export has `session_started` events but no `workflow_stage` events,
confirm that **Enable workflow analysis** shows ON in the extension panel.
If `github_commit_ref` is missing, confirm a complete GitHub commit link is
visibly rendered **inside an assistant reply**, not just plain text in a
user message. In the exported JSON, `commits` entries describe available
GitHub patches or `status: unavailable` if the public API fetch failed.
Reload both the extension and ChatGPT after updating the source.

Run the browser regression tests without building the Windows app:

```powershell
node --check integrations/chatgpt-browser/extension/background.js
node --check integrations/chatgpt-browser/extension/content.js
node --check integrations/chatgpt-browser/extension/sidepanel.js
node --test integrations/chatgpt-browser/tests/extension.test.mjs
```
