# Approved local code-change tracking

## Enable and inspect

1. Build and run the updated Windows desktop application. Under **Coding Work
   Analysis > Analysis settings**, enable local analysis. External analysis can
   remain disabled; it is not needed for tracking.
2. Open **Code Changes > Repository approval**. Set any additional filename
   exclusions. Untracked files are excluded unless you explicitly check their
   separate approval box. Choose **Choose and approve repository** and select
   the root of a standard local Git repository.
3. Approval records the current HEAD and dirty staged/unstaged/untracked patches
   as a baseline. Existing changes are not labelled newly observed. It does not
   change collector consent, Git files, configuration, index, or history.
4. Edit an ordinary tracked text file. Choose **Check now**, or wait for the
   30-second check while the desktop app is running, including in its tray.
   Select the new file snapshot and expand **Exact local differences**. Check
   its layer, timestamp, additions/deletions, current patch and previous patch.
   Stage another edit and make an ordinary commit to see separate observations.
5. Use **Pause / resume**, **Revoke approval**, and **Delete history** as needed.
   Resume compares with the last baseline, so the interval can include work done
   while paused. Revoke stops reads and clears the baseline/recorder key, while
   retaining historical evidence. Delete history revokes and removes repository
   approval, its changes/results, their associations, and saved analyses citing
   them. Source repositories are never modified. Reapprove to create a fresh
   baseline or change untracked/exclusion settings.

## Tasks, sessions, attempts, and DeepSeek

Changes start unassigned. Select an existing task and choose **Assign change to
selected task**, or use the existing evidence-association controls. Shared
repository/session metadata can suggest tasks, but nothing is assigned
implicitly. A task may combine changes and activity from several sessions.
Neither timestamps, shared tasks, Git commits nor model explanations establish
that Codex, ChatGPT, a particular person, or a tool authored a change.

**Review this change for analysis** prepares a package locally. For multiple
implementation attempts, assign relevant snapshots to one task, select their
rows under evidence associations, then **Analyze task**. Explicitly selected
change observations include minimized current and previous patches. Default
whole-task and batch packages contain change metadata only, without source.

Review the exact JSON payload, enable external analysis intentionally, check its
approval box and choose **Approve and analyze**. Only this existing consent path
can send it to DeepSeek. Repository revocation, evidence changes and deletion
invalidate pending source approvals. Existing caching, timeout/retry limits,
request/token budgets, citation validation and uncertainty labels still apply.
Payloads over 60 KB fail rather than silently dropping/truncating source; use a
smaller selection or manually add focused context. Local history remains exact.

DeepSeek is instructed to explain edits, their possible purpose, relationship to
the task and potential problems, and compare selected dated attempts. These
explanations remain INFERRED. An OBSERVED statement must quote a cited summary.
A diff or commit cannot establish successful testing, deployment or completion.
No code is sent to Supabase, the hosted React page, the browser extension, or any
other service. No live paid request was made during development tests.

## Record actual process results

The observer never runs project code. The optional **user-invoked** Python
recorder runs exactly the command supplied by the user, without shell expansion:

```powershell
python integrations/code-changes/record-result.py --repository C:\work\project --kind test -- dotnet test
python integrations/code-changes/record-result.py --repository C:\work\project --kind build -- dotnet build
```

Run it from the Gentle Control Room checkout, or use the recorder's absolute
path. Windows, Python, and active local/repository consent are required. Shell
builtins or command chaining require a shell explicitly supplied by the user;
the application never constructs such commands.

The recorder inherits the user's terminal output but stores no command text,
output, environment or source. It records start/end timestamps, the user-declared
test/build category and the actual exit status. A per-approval local key signs
the receipt. The observer imports valid receipts on its next check, deduplicates
them, and rejects receipts after pause/revoke key rotation. Turning local
analysis off in the app also rotates recorder keys. Receipts are not proof
against malicious programs running under the same Windows account.

Exit 0 is labelled passed and a nonzero exit failed **for that user-designated
process only**. Category, coverage, tested revision and successful task outcome
are not proven. Associate the result manually with its task. The Code Changes
view displays associated task results while explicitly stating that they do not
prove the selected snapshot was tested. Legacy tool metadata remains unknown;
manual reports remain unverified. Arbitrary test outputs/JSON are not promoted
to observed verification.

## Exactness, safety, and limits

- Local Git snapshots read only approved repository roots and do not fetch from
  the network. Separately, an opted-in ChatGPT assistant commit link can cause a
  read-only HTTPS request to GitHub's public commit API, but only when that repo
  matches an approved local Git origin. See [browser-linked GitHub evidence](browser-github-implementation-pipeline.md).
  No disk scan, automatic task discovery, project commands, hooks or Git mutations
  are performed. Git external diff/text-conversion helpers and fsmonitor are
  disabled; literal pathspecs avoid treating filenames as patterns.
- Standard local repositories are supported, including an initially unborn HEAD.
  Linked worktrees/submodules, network roots, reparse-point paths/symlinks,
  alternate object stores, partial clones and repositories with locally configured
  executable clean/smudge/process content filters are rejected conservatively.
- Staged patches are relative to HEAD; unstaged patches are relative to the
  index. Commits are compared to their first parent (root commits to the empty
  tree). Rename detection is disabled, so renames appear as deletion/addition.
  New commit references mean newly observed reachable commits, not proof they
  were authored locally or pushed. Their timestamps are observation times.
- Each working-file observation retains the previous and current patch for its
  layer. They are snapshots against Git bases, not independent edits to sum.
  Staging, reverting or committing can remove a layer's diff; an empty current
  patch records that state without claiming the underlying file was deleted.
- HEAD rewrites, repository replacement, or catch-up exceeding 20 commits do not
  silently import historical changes as new work. Rewrites/large catch-up reset
  the baseline with an explicit status; changed repository identity requires
  revoke/reapproval. A HEAD change during a scan discards the scan.
- A 30-second poll is not a keystroke audit. Edits made and reverted between
  checks cannot be recovered. Per-file Git reads are not an atomic repository
  transaction; displayed snapshots describe what was read, not an exact moment
  when all files changed. Authors and exact edit times are unknown.
- Maximum file size is 256 KiB; each retained patch is at most 64 KiB; a scan is
  bounded to 1 MiB of patches and 200 changed paths per layer/commit. Untracked
  capture allows at most 100 candidates and 32 KiB UTF-8 contents per file.
  Complete output and Git execution time are bounded. Oversized scans leave the
  baseline intact. Excluded/unsupported files are counted in the status.
- Git internals, nested repositories, binaries/NUL-containing text, oversized
  files, common credential/key/environment files and configured filename
  patterns are excluded. Patterns match filename/directory segments and are
  case insensitive. Repository ignore rules are used; add any desired global
  ignore patterns to the approval exclusions. Invalid UTF-8 output may make a scan unavailable; exclude
  that file before retrying. Existing patches for newly unsupported oversized or
  binary files are retained as the previous baseline, not falsely cleared.
- Private changes are retained for 30 days, at most 200 observations and 8 MiB of
  patch text (current plus previous). Expired evidence and analyses citing it
  are removed together. Baselines expire after 30 days without observation and
  are paused. There are at most 20 retained repository entries (including revoked entries) and a 64 MiB total store ceiling.
  Process receipts are bounded to 100 on disk and 200 normalized results, with
  30-day normalized retention.
- Version-1 work state migrates additively on save, preserving existing tasks,
  evidence, settings, budgets and consent. Schema 2 retains the `work-v1.json`
  filename for location continuity, but encrypts the **entire** state with
  current-user Windows DPAPI. The directory ACL grants the current user and
  SYSTEM access. Exact diffs, filenames, baselines, analysis copies and receipt
  keys are protected, not merely the API key. Older binaries cannot open the
  new encrypted state; use the updated application after migration.
- Local exact patches can contain sensitive source. The viewer warns when known
  secret patterns are detected; only minimized selected copies enter external
  previews. Automatic checks do not detect every secret. Inspect the full
  payload before approval. Filesystem deletion is not guaranteed secure erasure.

## Validation

Commands:

```powershell
dotnet run --project desktop/GentleControlRoom.Desktop.Tests
python -m unittest discover -s integrations/code-changes/tests -v
python -m unittest discover -s integrations/codex/tests -v
node --test integrations/chatgpt-browser/tests/extension.test.mjs
dotnet run --project integrations/chatgpt-browser/native-host/GentleControlRoom.ChatGPTHost.csproj -- --self-test
npm test
npm run build
dotnet build desktop/GentleControlRoom.Desktop/GentleControlRoom.Desktop.csproj -o .artifacts/code-tracking
```

Tests use disposable Git repositories and isolated stores, not user approvals or
activity. Coverage includes baselines, staged/unstaged/commit/untracked changes,
deduplication, isolation, rewrite/first-commit behavior, bounded/excluded data,
authorship uncertainty, encrypted migration, retention, consent revocation,
selected/minimized packages and actual process exit recording. The Python
recorder is also exercised from C# against a real encrypted Windows fixture.

The environment denied privilege to create a fresh symbolic-link fixture. An
existing Windows profile junction was rejected without traversal instead. Native
interactive UI, tray/background alert delivery, and a live DeepSeek request must
still be checked manually; successful Windows builds and data tests do not prove
those interactive flows. Existing alert/authentication/tray handlers and browser
and Codex collectors were not changed.

### Results on November 2, 2026

- Desktop regression and code-tracking suite: 165 checks passed.
- User-invoked recorder: 3 tests passed, plus the C# end-to-end Windows receipt test.
- Codex collector: 17 tests passed.
- Browser extension: 23 tests and JavaScript syntax checks passed.
- Native messaging host self-test: exit 0.
- Web suite: 2 tests passed; production build passed with its existing CSS import,
  Browserslist-age and bundle-size warnings.
- Windows Release build: zero warnings and errors.

No real repository was approved during development; only isolated fixture
repositories were tracked. Existing user activity and collector consent were
not changed. Native interactive and live external API checks remain as noted above.
