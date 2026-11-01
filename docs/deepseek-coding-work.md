# Phase 2: coding-work analysis

## What was inspected

The desktop is .NET 8 WPF with a WebView2 alert/dashboard surface. Native Codex and
ChatGPT activity cards read local JSONL every 20 seconds. `CodexInsights` and
`BrowserActivityReader` produce session statistics and heuristic activity patterns.
The React/Vite web surface is not the appropriate place for a local secret or private evidence.

The Python Codex hooks write schema-1 timestamp, event type, session pseudonym,
project pseudonym, and optional canonical tool category. They do not retain
commands, prompt text, outputs, changed files, test exit codes, commits or objectives.
The Edge v0.4.0 collector and C# native messaging host write schema-1 browser
session events, message/code-block counts, coding tags and optional request-stage
classifications. They do not persist conversation contents or repository identity.
Consequently older metadata cannot be upgraded into objectives, root causes,
successful implementations or test results. No historical conversation scraping
has been added.

Existing CI runs extension checks, native-host self-tests, desktop reader tests and
a Windows build. Existing native history and statistics remain separate evidence
overviews. Their old heuristic section is now labelled “Activity signals · metadata only”.

## Native workflow

1. Open **Coding Work Analysis → Analysis settings** in the Windows app. Enable
   **local coding-task analysis** and save. This is independent of collector consent.
   Nothing changes in the browser extension or hook approvals.
2. **Refresh evidence** imports allowlisted existing metadata. Repeating refresh
   reads appended data, without creating tasks or making network requests.
3. Create a task with its objective and a human-readable project/repository name,
   for example “Repair browser activity integration” and “gentle-control-room”.
   This is an explicit local association, not an inferred repository identity.
4. Under evidence associations, select observations and **Assign selected to task**.
   You can select evidence from multiple sessions, days and sources. Shared project
   or session identifiers suggest candidate tasks; suggestions are never accepted
   automatically. One session can contribute different observations to different tasks.
   Choose another task and assign again to correct a relationship, or detach it.
   The local store retains association history. Selection applies to the current
   30-observation page; repeat on other pages as needed.
5. Add a short summary, decision, attempted fix, blocker, or deliberately selected
   excerpt using **Add context locally**. This is the consent-based context path
   when browser metadata lacks intent. Text is minimized before storage, and remains
   **UNVERIFIED** testimony. This does not enable additional browser capture.
6. Optionally choose a local Git repository. The importer reads the latest 50 commits
   reachable from HEAD, their commit dates and changed-file counts. No network call,
   author information, commit message, diff contents or file names are persisted.
   Commit observations enter the unassigned list: select relevant commits manually.
   A commit proves recorded changes, not test success, push, deployment, or task completion.
7. Review the task's expandable chronological timeline. Revise objective/repository
   or mark it Active, Completed, Unresolved or Abandoned. These are **user declarations**;
   revisions are retained as context. To resume abandoned work, select the existing task
   and return it to Active rather than creating a new task for the new session.
8. Select **Analyze task**. The complete task package is prepared locally. If selected
   observations belonging to that task are checked, only that subset is included;
   the package explicitly reports included and total observation counts. Packages
   are bounded to 400 observations and 60 KB. Narrow selection or add a focused
   summary if a task exceeds the limit; do not silently drop context.
9. Inspect the exact JSON request, enable the approval checkbox, then **Approve and
   analyze**. Each preview expires after 15 minutes, is single-use and is invalidated
   by changes to the task or settings. **Analyze available tasks** queues this same
   review process for each task with no current analysis. It never silently approves
   a batch. Cancel clears the queue. Requests already sent may still be billed.
10. Expand task history to read the analysis, uncertainty labels, confidence and
    evidence references. `E1`, `E2`, etc. resolve against the frozen evidence snapshot
    stored with that analysis, even after later evidence changes. New or reassigned
    evidence marks the result outdated. Unchanged approved packages reuse the cache.

## DeepSeek configuration and privacy

Official documentation verified November 1, 2026:

- [Models](https://api-docs.deepseek.com/quick_start/pricing/): `deepseek-flash`
  (default) and `deepseek-v4-pro` are supported by this harness.
- [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/):
  `POST https://api.deepseek.com/chat/completions`, bearer authorization.
- [JSON Output](https://api-docs.deepseek.com/guides/json_mode/):
  `response_format: {"type":"json_object"}` with a JSON example in the system prompt.
  Blank or truncated responses are possible and must be rejected.

Enter the key in the native PasswordBox and save settings. The key is encrypted
using Windows DPAPI in the **current-user scope**, in `deepseek-key.dpapi` under
`%LOCALAPPDATA%\GentleControlRoom\CodingWork`. It never enters the WebView, React
assets, JSONL, analysis JSON, source control or application logs. **Remove API key**
deletes it. Another Windows account cannot decrypt it; malware running as your
Windows user remains outside this boundary. A key is not required for local work
or any automated test.

External analysis is a separate default-off setting. Saving a key or enabling this
setting does not transmit anything. Only explicit per-payload approval starts a request.
The native provider fixes the official HTTPS endpoint and disables redirects.
It sends the reviewed task package and system/schema instructions, not raw JSONL,
browser transcripts, local paths or source identifiers. Session labels and evidence
references are package-local aliases. A deliberately chosen repository display name
and abbreviated commit reference can appear in the reviewed payload.

Minimization removes known credential lines, common token formats, opaque long
values, private-key blocks, URLs, email addresses and local paths. No pattern-based
filter can recognize every possible secret. Never paste credentials; inspect the
resulting payload, remove unrelated context, and cancel if unsure. The model's
response is also rejected if it contains recognizable sensitive material. No raw
requests, responses, exceptions or secret values are logged by this subsystem.

Defaults: 2,500 output tokens, 10 request attempts/day, 100,000 reserved tokens/day,
45-second timeout, one retry. Settings permit bounded adjustments. Only HTTP 429
and 5xx responses are retried; timeout, offline, schema errors and authentication
failures require a new user action. Every attempt is durably charged against the
local request and token budgets **before** sending. Reservations use UTF-8 request
bytes plus maximum output tokens and framing headroom, a conservative bound rather
than billed-token measurement. Failed/ambiguous requests are not refunded. Budgets
reset at UTC midnight; the app does not promise a dollar billing cap. Check current
provider pricing and account limits separately. Cached results consume no request budget.

## Evidence and interpretation

The model receives a coherent task package including objective, declared repository,
declared status, ordered observations, source/provenance, session aliases and known
coverage gaps. It returns objective/status plus bounded cited claims across identity,
workflow, decisions, problems, actions, changes, tests, verification, outcomes,
inefficiencies, recommendations and unknowns. The JSON schema rejects unknown
properties, invalid labels, absent evidence references and excessive content.

- **OBSERVED:** a direct quotation of an observed evidence summary. Metadata proves
  invocation only. Claims of observed file changes require commit evidence. Observed
  tests/verification/outcomes require explicit result evidence of the corresponding kind.
- **INFERRED:** a model interpretation, synthesis or tentative recurring theme.
- **UNVERIFIED:** reported activities, missing outcomes or unconfirmed conclusions.

The model cannot declare completed/failed without an explicit observed task outcome.
Legacy inputs do not contain such records. User-declared completion remains visible
separately. The normalized schema supports explicit test-result/verification/outcome
records, but this MVP **does not automatically capture test runner exit codes or
verify deployed applications**. Test results pasted as context remain unverified.
There is no GitHub API crawler; choose the local checkout to import commit evidence.
PR state, remote branch synchronization and CI outcomes are unknown unless supplied
as context, and that context is not automatically treated as verified.

Task timelines allow any order of investigation, planning, implementation, debugging,
testing, revision, verification and completion. Metadata categories are not a required
linear state machine. The model analyzes decisions, errors, changed approaches and
attempts only where relevant context exists. It does not turn an ended session into
a completed task, or several debugging requests into proven implementation failures.

Local recurring-pattern analysis detects edit/test invocation loops across distinct
tasks, repeated debugging signals within one task (explicitly inferred), and declared
completion with missing captured verification. Whole-task AI analyses may also return
evidence-backed semantic tags for configuration problems, authentication blockers,
revisions, verification difficulties and successful routines. Tags cannot be supported
by metadata alone; successful routines require observed verification. The local pattern
service compares tags across at least two distinct **current** task analyses. It shows
affected tasks, support frequency, citations, confidence and inferred status. Outdated
analyses do not establish current recurrence. No extra automatic paid analysis runs.
Recommendations may propose a reusable checklist or Codex skill; nothing is created
or executed automatically.

## Persistence and migration

No database server or remote storage is required. First local use creates a version-1
`work-v1.json` beside the encrypted key. It stores normalized evidence, task identities,
confirmed associations and their revision history, source-file cursors, analysis/cache
snapshots, patterns, settings, and budget reservations. Atomic temp-file replacement
with a flushed write and an OS file lock protects updates and multi-instance budgets.
Corrupt or unknown-version stores fail closed without overwriting existing data.

Existing schema-1 collector files are read-only and unchanged. This is an additive
local schema, not a migration of original records. Appends resume after the last complete
JSONL line; incomplete lines wait for the next refresh. When a file changes, a prefix checksum distinguishes appends from rewrites; unchanged
records are not reparsed. Truncated/replaced files are
re-normalized and obsolete associations removed. Limits: 16 MiB new input/refresh (plus checksum reads of changed files),
100,000 normalized records, 64 MiB snapshot, 5,000 relationship-history entries.
Run Refresh again when a backlog exceeds one pass. Normalization does not query
DeepSeek. Task fingerprints invalidate analysis when objective, project, declared
status, evidence or associations change. The UI does not reconstruct tasks on the
20-second statistics timer.

The minimized local store is not encrypted (only the API key is). It follows the
Windows profile's filesystem permissions. Back up the CodingWork directory while
the app is closed; restore the versioned JSON to the same app version. To erase
analysis history, exit the app and delete that dedicated directory. Turning off
analysis or deleting source JSONL does not erase retained analysis snapshots. Old
source files and collector consent are independently managed by the existing tools.

## Windows verification walkthrough

1. Build using `dotnet build desktop/GentleControlRoom.Desktop/GentleControlRoom.Desktop.csproj -c Release`.
   Exit any older tray instance and launch the newly built executable. Verify the
   native Coding Work Analysis area, the existing activity panels, and 16px minimum text.
2. Leave both new consent switches off. Refresh should request local opt-in. No API
   key is needed and no external network request occurs.
3. Enable local analysis. Refresh twice: counts must not double. Existing ChatGPT
   metadata should show no conversation text and Codex tools no command/output contents.
4. Create “Fix ChatGPT browser activity integration”. Assign a subset from two Codex
   sessions and one approved ChatGPT session. Create a second objective; assign other
   observations from that same ChatGPT session to it. Verify separate timelines.
5. Reassign an observation between tasks and detach it. Confirm history updates.
   Add a decision and blocker summary. Change the objective and then resume the same
   task on another day; no new task should be automatically created.
6. Select a disposable/local test repository and import commit evidence. Confirm only
   dates, hashes and counts are retained and no commits are automatically assigned.
7. Configure a real DeepSeek key **only if you want to incur API charges**. Enable
   external analysis, prepare a payload, inspect its JSON, then cancel. There must
   be no request. Prepare again and explicitly approve. Verify cited results or a
   safe API error. No real paid API call was used during implementation tests.
8. Reanalyze an unchanged task: the cache should prevent a new paid request. Add
   context or reassign evidence: the analysis should become outdated and approval
   must be renewed. Lower the request/token budget to verify a pre-send block.
9. Turn external consent off while a payload is open. Saving settings cancels the
   pending approval. Re-enable only intentionally. Test offline handling and key removal.
10. Analyze available tasks: each task must stop at a separate payload review, not
    auto-send a batch. Confirm the 20-second activity refresh never sends analysis.
11. Compare patterns across two tasks with real supporting evidence. Metadata-only
    histories must not claim root causes, failures or verified successful routines.

## Validation commands

```powershell
node --check integrations/chatgpt-browser/extension/background.js
node --check integrations/chatgpt-browser/extension/content.js
node --check integrations/chatgpt-browser/extension/sidepanel.js
node --test integrations/chatgpt-browser/tests/extension.test.mjs
python -m unittest discover -s integrations/codex/tests -v
dotnet run --project integrations/chatgpt-browser/native-host/GentleControlRoom.ChatGPTHost.csproj -- --self-test
dotnet run --project desktop/GentleControlRoom.Desktop.Tests/GentleControlRoom.Desktop.Tests.csproj
dotnet build desktop/GentleControlRoom.Desktop/GentleControlRoom.Desktop.csproj -c Release
npm test
npm run build
```

Harness tests use fake providers and HTTP handlers, isolated temporary stores and
synthetic content. They do not require or read a real API key. Windows-only DPAPI
tests use a dummy value, verify encryption/decryption, and delete the test secret.

### Implementation validation (2026-11-01)

- Desktop suite: 123 checks passed, including the task harness and existing checks.
- Browser extension: 23 tests passed; JavaScript syntax checks passed.
- Codex collector: 17 tests passed.
- Native messaging host self-test passed.
- Windows Release build passed with zero warnings and errors.
- Web suite: 2 tests passed; production build passed. Existing CSS import-order,
  Browserslist age and bundle-size warnings remain.

DeepSeek requests were mocked. The interactive Windows walkthrough above and a
live paid DeepSeek request have not been executed.
