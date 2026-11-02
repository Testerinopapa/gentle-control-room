# Gentle Control Room — standalone Edge coding evidence extension (v0.8)

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
   **0.8.0**. Reload the ChatGPT tab itself as well.
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

## Coding tasks and repeated-workflow analysis (v0.8)

**Export evidence JSON** now includes a new top-level `analysis` object:
`analysis.tasks`, `analysis.patterns`, `analysis.coverage` and
`analysis.limitations`. The raw `events` and `commits` records remain
unchanged and available for auditing. No new interface, external API key,
DeepSeek request, or Windows software is required.

The local analysis now uses **observed user-request boundaries** first. A new
request appended after an observed turn gets a local task ID; subsequent assistant
responses and commit references carry that relationship. Multiple requests in one
conversation produce separate conservative tasks. These boundaries do not claim to
identify a semantic goal spanning several follow-up requests. Stage sequences can
include several categories observed in one request, in textual order. They are
request classifications, not verified actions.

Messages mounted when workflow analysis is enabled are baselined. Their existing commit
references are **historical** and do not trigger GitHub retrieval, even when repeated
in a later response. A new link streamed into an old response can be captured as
unattributed, since that response has no supported new-task boundary. Streaming text,
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

Your first export may show one inferred task and **zero patterns**. This is
correct until two separately observed coding episodes support recurrence.

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
   assistant commit link. Start recording, then enable workflow analysis.
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
