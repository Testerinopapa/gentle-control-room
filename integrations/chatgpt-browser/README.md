# Gentle Control Room — standalone Edge coding evidence extension (v0.9.17)

**The Windows application is not required.** A native messaging host is optional and is used only for approved Codex analysis.
This extension works on its own in Microsoft Edge (and compatible Chromium-based
browsers with side-panel support). It keeps activity evidence in
`chrome.storage.local`, not on a remote server. Existing legacy Windows
`.jsonl` files do not automatically migrate into this storage.

## Native Codex bridge version check (v0.9.17)

A previously installed Windows native host may accept activity events but return
`{"ok":false}` for `codex_analyze`, which produced the ambiguous "rejected the
request without details" error. The Edge extension now first sends a read-only
`codex_capabilities` probe, **without coding evidence**. The updated native
host responds with `codexAnalyze: true` and `protocolVersion: 1`.
If the installed host does not support this protocol, the panel explains that
the **Windows native host must also be updated**. The approved evidence is not
transmitted to a host that fails this check.

From the repository root in PowerShell, install the rebuilt host:

```powershell
git pull --ff-only origin main
.\integrations\chatgpt-browser\install-host.ps1
codex --version
codex login status
```

For an existing installation, the script securely reuses the 32-character
Edge extension ID from the old native host's manifest. On a first install or
when that manifest is unavailable, run
`install-host.ps1 -ExtensionId YOUR_EDGE_EXTENSION_ID` using the ID shown at
`edge://extensions`. Reopen Edge after reinstalling the host. The
installer builds and self-tests the host, then registers it in the current
Windows user's Edge native-messaging registry. This still requires the .NET 8
SDK on Windows. No new UI buttons, background Codex calls, or additional
permissions are introduced.

## Conversation-to-GitHub evidence capture (v0.9.16)

**Start & read this conversation** now preserves structured GitHub repositories and
full commit links found during the two-pass browser scan, including hrefs hidden
behind link labels. These references are saved with the corresponding message in
`gcrBrowserConversationV1` and included in downloaded conversation text.

After saving the conversation, the extension processes only the extracted GitHub
addresses through the existing public commit-patch collector. Existing/historical
links may now be fetched after an explicit full conversation capture; passive
recording alone still treats historical references conservatively.

When the captured conversation names a repository but contains **no full commit
link for that repository**, the extension checks up to **two** identified public
repositories, retrieving up to **three recent default-branch commits each**.
Successful lookups are cached for 12 hours; failed requests can retry. The
extension never scans every commit or accesses private repos without credentials.

The repository-history commits are marked **unattributed**; they prove the public
repository changed, not that ChatGPT authored the code or that a particular
request was completed. Captured commit links are also unattributed unless
separate workflow evidence establishes a connection.

The existing **Analyze coding activity** action can now send retrieved patches to
Codex for review and explicit user approval even if no structured coding task was
recorded. No new buttons, ChatGPT internal endpoints or remote backend were added.
Browser conversation text is still excluded from the Codex payload.

## Codex bridge failure diagnostics (v0.9.15)

If a native messaging host replies with `ok: true` but no `output`,
the extension now explains that the installed Windows host may be outdated.
It also distinguishes a missing native result, an unrecognized response,
an empty Codex report, and host-reported errors. This replaces the generic
"Codex could not analyze the evidence" message. No new buttons.

**Updating the Edge extension does not update the installed Windows host.**
In the repository root on Windows, run:

```powershell
git pull --ff-only origin main
.\integrations\chatgpt-browser\install-host.ps1 -ExtensionId YOUR_32_CHARACTER_EDGE_EXTENSION_ID
codex --version
codex login status
```

Find the exact extension ID under `edge://extensions`. The installer needs
the .NET 8 SDK and updates the native host registered for that Edge extension;
restart Edge before retrying `Analyze coding activity`.

The native host still deliberately suppresses raw stderr and command output
from failed Codex calls because they could contain sensitive source material.
The updated error messages identify safe next steps, not a guaranteed cause.

## Simplified coding-analysis controls (v0.9.14)

The main panel retains three actions: Start/Stop, Download conversation,
and **Analyze coding activity**. Coding insights now use **one context-aware
button** throughout the flow, rather than displaying an initial Analyze
button and a second confirmation button together.

- First click: prepare a local, inspectable JSON evidence preview.
- Before approval: that same button reads **Cancel review**, and cancelling
  sends nothing.
- When the approval checkbox is explicitly checked: the same button reads
  **Run approved Codex analysis**, and sends only the reviewed package through
  the existing optional native Codex bridge.
- After running or cancelling: the primary button returns to Analyze coding
  activity. Failed analysis can be retried without silently granting consent.

Manual commit import, evidence JSON download and evidence deletion remain
available in a nested, collapsed **Advanced options → Coding evidence tools**
section. No coding pipeline was removed, and raw browser conversations are
still excluded from the Codex evidence package.

## Capture completeness diagnostics and first-pass preservation (v0.9.13)

ChatGPT can mount a user prompt before its assistant text, and a reply seen
on an upward scan can disappear from the DOM on the downward scan.
Gentle Control Room now:

- Rechecks windows containing unmatched user messages for longer before
  moving away.
- Retains first-pass user turns and assistant replies, attaching them to
  canonical downward-pass turns when stable user-message anchors agree.
  Unanchored first-pass replies are retained with uncertain placement;
  no chronology is claimed when anchors are missing.
- Keeps previous locally saved replies when a new scan doesn't render them.
  All capture data remains in `gcrBrowserConversationV1`; raw conversation
  text is not added to the Codex evidence payload.
- Stores scan diagnostics (observed windows, disconnected windows,
  first-pass recovery counts, uncertain placements, and whether the
  ChatGPT tab was backgrounded) and includes them in the side panel and
  downloaded text transcript.

**A scan reaching the top and bottom of the scrollbar is not proof that
every ChatGPT message was loaded.** The extension explicitly reports
this limitation and continues to label possible reply gaps. There are
no new buttons, site permissions, remote API requests, or AI calls.

## Extra-slow history capture (v0.9.12)

A real Edge transcript from November 23 showed **two possible reply gaps**,
down from eight in the earlier scan, but missing early assistant replies
still warranted more time for lazy-loaded content.

The DOM reader now waits **1,600 ms** on each downward move and **650 ms**
between content-stability checks (previously 650/300 ms), waits **900 ms**
at the top, and advances in **35% viewport** increments rather than 50%.
The limit is expanded to 340 downward steps to preserve coverage for
the smaller scroll hops.

No additional UI buttons or browser permissions are required. Captures
will take longer; slower scrolling cannot recover messages that ChatGPT
never renders. Retained local snapshots still help recover older replies.

## Slower browser history scanning (v0.9.11)

The Live Archiver-derived DOM collector now pauses longer after each scroll
(650 ms on the downward pass plus 300 ms between stability checks, compared
with 160 ms and 125 ms previously). It advances by half a viewport instead
of 70%, gives the top-of-history loading pass more time, and permits up to
220 downward steps so the smaller hops do not reduce coverage.

This deliberately makes capture take longer, giving ChatGPT more time to
render replies before leaving each section. It is still limited to
browser-rendered messages; slower scanning alone does not guarantee a
complete history.

## Browser history ordering and reply retention (v0.9.10)

A real Edge export on November 23 showed eight possible reply gaps and user
prompts out of chronological order. This release fixes two underlying causes:

- ChatGPT's `fallback-turn-N` numbers are relative to the currently rendered
  window. They must **not** be used to globally sort a virtualized transcript.
  The reader now rebuilds a fresh top-to-bottom DOM pass on each capture,
  follows scroll direction for passive observations, and restores the prior
  scroll position.
- Previously the background worker merged arbitrary individual message
  windows, sometimes prepending newer user turns ahead of older ones.
  Snapshots now merge **by user turn**, using stable message identifiers or
  unambiguous matching prompt text. When the new DOM scan reaches both ends,
  its observed user-turn order takes precedence, while old assistant replies
  are retained under their matching prompts.

The DOM reader also pauses until each scroll window's message units settle
before advancing, reducing the chance of capturing a prompt before its reply
has appeared.

A complete DOM pass does not guarantee that ChatGPT loaded every historical
reply. Missing texts that were **already erased from Edge storage** cannot be
reconstructed from the browser alone; previously downloaded transcript files
remain separate backups. The sidebar still reports potential gaps and capture
limits. No remote ChatGPT API or new permission was added.

## Browser transcript duplicate cleanup (v0.9.9)

Following a real Edge export on November 23, the browser reader now prefers
actual assistant Markdown content instead of a longer wrapper that can include
tool-progress/activity labels. When the same assistant reply appears twice
with different markup, saved snapshots are cleaned **on read**, as well as
during the next capture. The deduplicator uses substantial overlapping
five-word sequences and only collapses adjacent assistant messages; unrelated
answers remain separate. If one rendering is only progress notes plus the
final response, the cleaner final response is preferred.

This does **not** imply the five reported possible reply gaps are fixed.
Messages not loaded by ChatGPT's DOM remain unavailable to the extension.
The side panel continues to report possible gaps and incomplete coverage.

## Simple side panel (v0.9.8)

The main view has just **three actions**: **Start & read this conversation**
(or **Stop recording** while active), **Download conversation**, and **Analyze
with Codex**. Start also performs the first browser conversation capture
automatically. Analyze still opens an explicit evidence review and approval
step before contacting the optional local Codex bridge.

Manual re-scan, deletion, evidence JSON export, commit import, raw message
counts and the older metadata-based summary remain available in the collapsed
**Advanced options** section. No data or functionality is removed; only the
initial interface is simplified.

## Install / update

1. Update your checkout: `git pull --ff-only origin main`.
2. Open `edge://extensions`, switch on **Developer mode**, and use **Load unpacked**
   to select `integrations/chatgpt-browser/extension` (only if not already loaded).
3. For an existing unpacked extension, click **Reload**. Version must read
   **0.9.17**. Reload the ChatGPT tab itself as well.
4. Open a ChatGPT conversation, open the extension side panel, and select
   **Start for this conversation**. This one explicit action automatically
   tags the session as coding-related and enables local workflow classification,
   task-boundary detection, and public GitHub commit evidence collection.
   No extra coding-work or workflow toggles are needed. Start also classifies
   already-rendered requests and assistant replies as historical evidence
   (up to 60 historical request boundaries). The explicitly labeled Start
   button also saves currently rendered message text locally in Edge as a
   separate browser conversation snapshot.
5. The extension recognizes complete GitHub commit URLs in assistant HTML
   links **or visible plain text**. If ChatGPT renders only a link label
   with no accessible URL, paste the complete GitHub commit URL in the
   **Evidence → GitHub commit URL** field and click **Import commit evidence**.
   This is a manual fallback, not automatic access to hidden ChatGPT tool calls.
6. Use **Export evidence JSON** in the extension panel. No Windows steps required.

For recording, the extension is standalone. The optional Codex integration uses
`nativeMessaging` to contact a user-installed local host; it does not require
opening the Windows dashboard.

The extension's network host permissions are restricted to ChatGPT and
`https://api.github.com/*`; no blanket access to GitHub webpages or the
computer's filesystem is used.


## Optional Codex analysis — in the Edge side panel

The extension can analyze its already recorded tasks, recurring patterns, and
retrieved GitHub patches using **your signed-in local Codex CLI**. There is no
DeepSeek key, Windows dashboard, backend, or auto-analysis timer.

1. Install and sign in to Codex CLI. Confirm `codex --version` and
   `codex login status` both work in PowerShell.
2. Install the optional native bridge (requires .NET 8 SDK to publish it).
   In the repository root, run:

   ```powershell
   git pull --ff-only origin main
   .\\integrations\\chatgpt-browser\\install-host.ps1 -ExtensionId YOUR_32_CHARACTER_EDGE_EXTENSION_ID
   ```

   Copy the exact ID from `edge://extensions`. The installer publishes a
   standalone host under `%LOCALAPPDATA%\\GentleControlRoom\\BrowserNativeHost`
   and registers it for that Edge extension ID only. **Do not** launch the
   Windows desktop application. Restart Edge if you installed Codex CLI after
   opening the browser, so its PATH is refreshed.
3. Reload the unpacked extension from `edge://extensions` (v0.9.17).
4. Open Gentle Control Room, select **Analyze coding activity** and inspect the
   exact JSON. Tick the explicit approval checkbox and press the same button,
   now labeled **Run approved Codex analysis**.
5. Codex runs once with `codex exec --sandbox read-only --ephemeral`, with
   stdin-only evidence and a three-minute timeout. Its report appears in
   the panel, and only the last result is saved in `chrome.storage.local`.
   Deleting stored evidence also removes this result.

The reviewed package contains task/pattern analysis plus *retrieved public
GitHub file patches*. Raw browser event chronology and conversation text are
excluded; inspect the review anyway because public patches may contain sensitive
source. The approved evidence is sent by the local Codex CLI to OpenAI for model
analysis. Neither Start recording nor loading the side panel sends anything to
Codex automatically. The host never accepts user-supplied shell commands or
updates the repository. If Codex is missing, the bridge is not installed, or
analysis fails, recording and local patterns continue to work.

## What is captured

- Opted-in session start/stop timestamps with a fresh random local session ID.
- Visible message counts and code-block counts, where available.
- An automatic coding-work tag when you start recording, plus locally classified
  workflow stages. User text is inspected transiently only while recording is ON
  and is never saved in coding evidence. The separate browser conversation
  snapshot stores message text only after the explicitly labeled Start/capture action.
- The **complete currently rendered assistant response** is inspected
  transiently for GitHub links and code-block structure, including links outside
  nested text wrappers, late-streamed content, and URLs beyond 12,000 characters.
  Multiple distinct commit links in one response are sent as a bounded batch,
  with independent per-link acknowledgement and retries on future scans.
  Links observed during streaming remain counted even if a later render removes
  them. GitHub references are reduced to `owner/repo` plus the 40-character SHA.
- Per-response `assistant_evidence` contains **only structured metadata**:
  `observedCharacters`, `observedCodeBlocks`, `observedCommitLinks`,
  whitelisted `mentionedStages` and `commandFamilies`, and opaque
  response/task IDs. A single snapshot is updated during streaming; the raw
  assistant response, source code and exact shell commands are never saved
  by this scanner.
- While recording is ON, the extension can fetch a matching public
  commit's changed file patch hunks directly from GitHub's public API. It stores
  bounded, filtered patch data locally along with the link's session ID.
- A downloadable `gentle-control-room-evidence.json` including recorded
  chronology, commit references and available exact patches.

The live message observer detects commit URLs in rendered ChatGPT markup.
The separate two-pass transcript scan also retains hidden href destinations and
repository names. If only a repository is known, bounded public GitHub history
discovery supplies recent, explicitly unattributed commits; no private
repository or hidden ChatGPT tool call is accessed.

The v0.9.5 capture cleanup also removes ChatGPT's accessible
speaker-prefix label ("ChatGPT said:") even when the label is alone or not
followed by a newline. Empty label-only assistant placeholders are excluded
from new captures and older stored snapshots. This does not reconstruct
missing assistant messages that were never exposed in the browser DOM.

## Live Archiver reader integration (v0.9.6)

Gentle Control Room now uses a DOM-only, adapted reader based on
[Live Archiver](https://github.com/hexnod/live-archiver) by Mark West
(v1.2.10, Apache 2.0). The adapted source is
`extension/live-archiver-reader.js`, with the upstream license and copyright
notice under `extension/third_party/LiveArchiver-LICENSE` and
`extension/third_party/LiveArchiver-NOTICE`.

**What we reused:** Live Archiver's modern ChatGPT turn/message-unit selectors,
the paired user/assistant extraction model, the in-memory message cache, a
bounded two-pass history collection (go to the top, walk down), and scroll-position
restoration. We keep our pre-existing GitHub commit evidence collector,
workflow classifications, repeated-pattern detection, consent UI and local
per-conversation transcript persistence.

**What we deliberately did not import:** Live Archiver's authenticated requests
to ChatGPT's internal `/api/auth/session` or `/backend-api/conversation/...`
endpoints, token handling, attachment retrieval, external image downloads, or
its side-panel UI. Our reader reads only the currently displayed DOM and turns
loaded while scrolling. It makes **no network requests**. Long chats can still
be incomplete; the side panel reports whether both ends were reached, which
is **not proof that every message was loaded**. The older metadata-only
summary is unchanged; the actual chat text appears in **Conversation from
browser**, stored separately from Codex evidence.

Use the same existing unpacked Edge extension folder. No build, npm install,
additional API key, new permissions, or separate Live Archiver installation
is required.

### v0.9.9 response recovery

A regression in v0.9.6 could lose assistant replies even while user prompts
were present. The revised reader checks alternate assistant message units
rather than trusting an accessibility-label-only wrapper. At each history
window, the older observer also records compatible user/assistant nodes. When
the primary parser misses a reply, the two sources are merged by matching user
prompts; incomplete replies are replaced by longer, compatible ones without
duplicating them. The reader preserves paragraph breaks instead of flattening
the DOM's `textContent`.

The sidebar reports a **possible reply gap** when user messages appear
consecutively without a recorded assistant reply. This is a diagnostic, not
proof that an answer ever existed. The raw transcript and any recovered replies
remain solely in the local `gcrBrowserConversationV1` store, separately from
Codex evidence. Automated test fixtures cover sibling units and out-of-turn
assistant messages; a real Edge export is still necessary to verify coverage
against the live ChatGPT interface.

## Read the real conversation directly from the browser

The extension can now capture the **actual text of rendered ChatGPT messages**,
including user requests, assistant replies and visible code blocks.

1. Open the ChatGPT conversation and select **Start & read this conversation**.
   The extension uses a bounded Live Archiver-derived two-pass scan: first
   reach the earliest available browser-rendered turn, then walk forward
   collecting available replies, and restore your scroll position.
2. Read **Conversation from browser** or select **Download conversation (.txt)**.
3. To load more history, scroll upward in ChatGPT and select **Capture
   conversation from browser** again. The extension retains previously captured
   turns and merges newly seen messages rather than replacing the record.
4. To erase it, select **Delete captured conversation**. The global
   **Delete stored evidence** action also erases captured conversations.

The explicitly labeled **Start & read this conversation** button authorizes
reading rendered messages alongside coding metadata. Later **Capture
conversation from browser** clicks extend that snapshot with newly seen turns
and deduplicate repeated messages. Only these actions
transfer raw message text into the extension's **local Edge storage**,
under `gcrBrowserConversationV1`. Conversation snapshots are kept separate
from `gcrEvidenceV1` and **never included in the Codex evidence payload**.
No provider API, Codex, remote server or external storage is involved.

The extension cannot fetch hidden conversation history through an API. It
remembers turns seen while scrolling and merges later captures using stable
message identifiers or normalized text. Newly captured windows with no shared
messages have **uncertain chronological order** and are flagged accordingly.
There is still no guarantee of a full history (ChatGPT can virtualize or unload
older turns). Each retained conversation is limited to 160 messages /
350,000 characters (8,000 per message); the middle is trimmed if necessary,
and truncation is reported. Up to six session snapshots are retained for
up to 30 days, subject to a storage-size limit.
The exported text may include secrets and other sensitive content; handle
downloaded files accordingly.

## Conversation summary

The **Conversation summary** section in the Edge side panel automatically shows
a readable overview of the current recording (or the most recently recorded one).
After **Start for this conversation**, it includes already-rendered historical
requests and new coding activity, dominant workflow themes, referenced GitHub
repositories, patch availability, and recurring evidence patterns. It refreshes
as new events are recorded. Click **Download summary** to save a local text copy.

The summary is generated deterministically from the existing structured
`gcrEvidenceV1` evidence in Edge's `chrome.storage.local`; it is recomputed
when the panel opens. Exports include
`analysis.conversationSummaries` with one bounded summary per recorded session.
No separate transcript store, remote server, AI call, or permission is needed.
**Delete stored evidence** removes the source records, and therefore the summaries.

This is a **coding activity summary, not a semantic recap of everything said**.
The extension does not save the full conversation text, so it cannot reliably
report exact problems, decisions, fixes, or task outcomes without supporting
structured evidence. Messages ChatGPT has unloaded and unrelated conversations
are not included. Old links remain passive-only until an explicit conversation
capture, which can now collect their public GitHub patches.

## Coding tasks and repeated-workflow analysis (v0.8)

**Export evidence JSON** now includes a new top-level `analysis` object:
`analysis.tasks`, `analysis.patterns`, `analysis.coverage` and
`analysis.limitations`. The raw `events` and `commits` records remain
unchanged and available for auditing. No new interface, external API key,
DeepSeek request, or Windows software is required.

The analysis includes `tasks[].responseMetadata`, summarizing code-block
counts, observed commit-link counts, and the maximum rendered response length.
These are **observations of ChatGPT output, not evidence that tests ran, code
was edited, or deployment succeeded**. Assistant stage mentions and shell command
families (for example, `git` and `npm`) are reported only as whitelisted labels,
not as verified actions. Raw response text, commands, code blocks,
and non-GitHub links are not copied into the event log. GitHub patch capture
continues to use the existing filtered public-commit retrieval mechanism.

The local analysis now uses **observed user-request boundaries** first. A new
request appended after an observed turn gets a local task ID; subsequent assistant
responses and commit references carry that relationship. Multiple requests in one
conversation produce separate conservative tasks. These boundaries do not claim to
identify a semantic goal spanning several follow-up requests. Stage sequences can
include several categories observed in one request, in textual order. They are
request classifications, not verified actions.

Messages mounted when recording begins are scanned for historical request
boundaries, stages and assistant response metadata. Their existing commit
references are **historical** and do not trigger retrieval in the passive observer.
An explicit conversation capture can separately fetch their patches as
unattributed evidence. A new link streamed into an old response can be captured
as unattributed, since that response has no supported new-task boundary. Streaming text,
delayed link attributes and rerenders with stable message identities are observed
without requiring a working count detector. Raw DOM IDs stay in memory; only local
opaque IDs are saved. Missing identities, initially empty timelines and prepended
history produce **uncertain** boundaries rather than confident associations.

Each commit-reference event has one of four `attribution.state` values:
- `automatic`: a new assistant response is linked to a supported request boundary;
- `manual`: the user explicitly selected a task in the Evidence task selector;
- `unattributed`: no supported relationship exists (the default for manual imports);
- `historical`: the commit reference was already visible at workflow opt-in.

Unresolved references appear in `analysis.unattributedCommits` and in the Evidence
section. To associate one later, paste its full commit URL, select a task with an observed request boundary, and import
again. Legacy time-only episodes cannot be selected as explicit tasks. The original observation remains in chronology, with `resolved: true` in
analysis once supported association exists. Public patches are cached once per
repository/SHA, even across sessions. A commit reference is not proof of creation,
authorship, successful implementation, test execution or deployment.

The JSON analysis now includes `captureDiagnostics`: counts of GitHub reference
events by discovery (assistant/manual), attribution (automatic/manual/unattributed/
historical/unknown), and unique nonhistorical commits by retrieval status
(text patches/metadata only/unavailable/not cached). Historical references are
reported separately because they are intentionally not fetched. This is an
audit aid for determining whether capture and attribution actually succeeded;
it does not establish commit authorship or whether a task worked.

The exported `analysis.captureDiagnostics.workflow` also reports whether recorded
sessions actually produced coding evidence: `sessionsStarted`,
`sessionsWithRequestBoundaries`, `sessionsWithoutWorkflowEvidence`,
`requestBoundaries`, `assistantResponses`, `workflowStageEvents`,
`visibleCountUpdates`, and `automaticCodingTags`. A session with only
message counts and the automatic coding tag is reported as having **no workflow
evidence**. This identifies a missing request/commit capture signal, but does
not establish whether the user submitted a new coding request after opting in.

The export envelope remains version 1 with its existing `events` and `commits`.
`analysis.version` is now 2. Existing task fields remain, with additive `taskId`,
`requestId`, `responseIds`, `workflowStages`, `attribution`, `filesChanged`,
`lineChanges`, `completedAt` and `verification`. Completion and verification remain
unknown. Supporting event indices are computed against the current export, while
stored local request/response IDs preserve relationships through retention changes.
Patches remain solely in `commits`, never duplicated in task or pattern output.

Legacy stage/tag events still use the **45-minute inactivity fallback**, explicitly
marked uncertain. Legacy commits without an explicit relationship are exported as
unattributed, including old manual imports; time proximity alone does not attach them.

Patterns need **two distinct tasks** and list their supporting task IDs and commit
references where available. They include ordered request sequences, repository and
file-category recurrence, changes referenced after test-related requests, and files
changed in distinct commits. Code-change patterns require distinct commit SHAs;
repeated references to one commit never constitute repeated modifications. None of
these patterns verifies execution or success. No external AI service is contacted.

The first export may include historical tasks from already-rendered messages,
marked `historical: true`. Repeated historical stage classifications can support
metadata patterns, not proof of executed actions. Code-change patterns still
require attributed distinct commits with captured patches. Unrendered older
turns cannot be recovered; no undocumented ChatGPT API is used.

The extension does not inspect other tabs, cookies, session tokens,
conversation titles/URLs or any arbitrary local Git repositories. It does not
transmit private ChatGPT text or patches to DeepSeek or any AI service. Fetching
a public commit sends that public repository and SHA to GitHub. Export is a
local browser download.

## Data lifecycle / consent

Recording starts OFF. Clicking **Start for this conversation** enables both
local workflow analysis and an automatic coding-work tag, without extra switches.
**Stop recording** revokes collection for that conversation; changing conversations
also stops it. Each new conversation requires separate consent. **Delete stored evidence** in the
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
confirm that recording is ON and the ChatGPT page observer is connected.
If `github_commit_ref` is missing, confirm a complete 40-character
GitHub commit link appears **after recording begins** inside an assistant reply,
not just in a user message or in a historical assistant response. The scanner
does not recover links hidden behind inaccessible client-side actions or messages
that ChatGPT has unmounted from the DOM. In the exported JSON, `commits` entries describe available
GitHub patches or `status: unavailable` if the public API fetch failed.
Reload both the extension and ChatGPT after updating the source.

Install test dependencies with `npm ci --ignore-scripts`, then run the browser
regression tests without building the Windows app:

```powershell
node --check integrations/chatgpt-browser/extension/background.js
node --check integrations/chatgpt-browser/extension/analysis.js
node --check integrations/chatgpt-browser/extension/content.js
node --check integrations/chatgpt-browser/extension/sidepanel.js
node --test integrations/chatgpt-browser/tests/extension.test.mjs
```

## Verify v0.8 in Edge

1. Reload the unpacked extension and ChatGPT. Open a conversation with an existing
   assistant commit link. Click **Start for this conversation** once; both coding
   tagging and local workflow analysis begin automatically.
2. Export: that reference should be historical, with no new GitHub patch retrieval.
3. Submit a new coding request. When a subsequent assistant reply displays a full
   public commit URL, export again. Check its request/response IDs, task ID, automatic
   attribution, and retrieval status. Streaming or plain-text URLs also work.
4. Submit a separate coding request in the same chat. Check that it has another task
   ID. Multiple links in one assistant response should stay on the first task.
5. Import a public commit with the selector set to Unattributed. Verify it is absent
   from task commit lists. Select its intended task and import again to associate it.
6. Repeat a request sequence in another task; inspect supporting task IDs in patterns.
7. Stop recording or navigate away. No further evidence should arrive. For a slow
   retrieval, delete evidence while it is pending; the patch must not reappear.

Limitations: a newly mounted message is not necessarily newly authored. Unsupported
or virtualized markup may leave evidence uncertain, and unseen history cannot be
recovered. Identical requests without stable DOM IDs are conservatively deduplicated.
Each request is a candidate task, so semantic multi-request task merging is not claimed.

## Local code-pattern analysis

The existing Evidence section shows code patterns from `analysis.patterns`, with
supporting task counts and clickable commit references. JSON exports include the
same results plus `supportingEvidence` entries linking task IDs, commit keys and
file paths; no patch text is duplicated.

Three deterministic rules inspect retained GitHub patches:
- **Repeated file modifications:** changed source-file hunks for the same
  repository/path across tasks (existing `same_file_in_distinct_commits` type).
- **Repeated testing changes:** added or modified source files under test/spec
  directories or with common test/spec filenames (`test_file_changes`).
- **Repeated error-handling additions:** added catch/except, throw/raise, assert,
  Swift guard, or single-line conditional return/throw/raise syntax
  (`error_handling_additions`). Generic conditions alone are insufficient.

Every code pattern requires at least two distinct attributed tasks and two distinct
commits. Two commits on one task, repeated references to a single commit, missing
patches, metadata-only retrievals and unchanged context cannot establish recurrence.
Patch inspection stays local and bounded to captured evidence limits. These are
lexical observations, not a parser or proof of intent, quality, execution or success;
unrecognized languages, multiline guards and unusual test names may be missed.
Existing request-stage patterns remain separately labeled metadata observations.

To verify, reload the unpacked extension and open Evidence. A one-task/two-commit
recording should show no recurring code patterns. Once two attributed tasks have
matching patch evidence, the list shows the pattern, task count and commit links.
Export JSON to inspect `basis: "captured_patch_changes"`, supporting paths and
commit references. Run `node --test integrations/chatgpt-browser/tests/extension.test.mjs`
for the regression suite. No additional permissions, dependencies or APIs are needed.
