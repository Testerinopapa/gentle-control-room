using GentleControlRoom.Desktop.CodingWork;
using System.Security.Cryptography;
using System.Text;

internal static class CodeTrackingTests
{
    private static void Check(bool ok, string name) { if (!ok) throw new Exception(name); Console.WriteLine("PASS code changes: " + name); }
    private static async Task Git(string root, params string[] args)
    { var result = await RepositoryReader.Git(root, args); if (result.Code != 0) throw new Exception("Fixture Git failed: " + string.Join(" ", args)); }
    private static Task Commit(string root) => Git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture", "--no-verify");
    private static async Task Reject(Func<Task> action, string name)
    { bool rejected = false; try { await action(); } catch { rejected = true; } Check(rejected, name); }
    private sealed class NeverSend : IAnalysisProvider
    {
        public int Calls;
        public Task<TaskAnalysis> AnalyzeAsync(string json, EvidencePackage package, int timeout, CancellationToken token)
        { Calls++; throw new Exception("No network expected"); }
    }
    internal static async Task Run()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP Windows code tracking fixtures require DPAPI."); return; }
        var root = Path.Combine(Path.GetTempPath(), "gcr-code-fixtures-" + Guid.NewGuid().ToString("N"));
        var repo = Path.Combine(root, "repo"); var other = Path.Combine(root, "other"); var data = Path.Combine(root, "AppData", "GentleControlRoom", "CodingWork");
        Directory.CreateDirectory(repo); Directory.CreateDirectory(other); Directory.CreateDirectory(data);
        var store = new WorkStore(data);
        try
        {
            var legacy = new WorkState { SchemaVersion = 1, LocalEnabled = true };
            var originalTask = TaskService.Create(legacy, "Preserved task", "Fixture");
            var legacyObservation = legacy.Evidence.Single();
            var oldFingerprint = WorkJson.Hash(WorkJson.Serialize(new { originalTask.Objective, originalTask.Repository, originalTask.Status,
                Evidence = new[] { new { legacyObservation.Id, legacyObservation.Source, legacyObservation.SessionKey, legacyObservation.ProjectKey, legacyObservation.At, legacyObservation.Kind, legacyObservation.Category, legacyObservation.Summary, legacyObservation.Basis, legacyObservation.Outcome, legacyObservation.Reference, legacyObservation.FilesChanged, legacyObservation.FileKey, legacyObservation.Display } } }));
            Check(TaskService.Fingerprint(legacy, originalTask.Id) == oldFingerprint, "metadata-only analysis fingerprints survive the additive schema migration");
            File.WriteAllText(Path.Combine(data, "work-v1.json"), WorkJson.Serialize(legacy));
            Check(store.Read().SchemaVersion == 2 && store.Read().Tasks.Single().Id == originalTask.Id && store.Read().Repositories.Count == 0,
                "additive migration preserves existing task and consent; tracking starts off");
            store.Update(s => true);
            Check(!File.ReadAllText(Path.Combine(data, "work-v1.json")).Contains("Preserved task"), "entire private store is protected with Windows DPAPI");
            await Git(repo, "init"); await Git(other, "init");
            File.WriteAllText(Path.Combine(repo, "code.txt"), "original\n"); await Git(repo, "add", "code.txt"); await Commit(repo);
            File.WriteAllText(Path.Combine(repo, "code.txt"), "existing before consent\n");
            var id = await CodeTracking.ApproveAsync(store, repo, false, new[] { "*.private" });
            Check(store.Read().CodeChanges.Count == 0 && store.Read().Repositories.Single().Baseline.Count == 1,
                "initial dirty working tree is a baseline, not newly observed work");
            await Reject(() => CodeTracking.ApproveAsync(store, repo, false, Array.Empty<string>()), "duplicate approval rejected");
            Check(await CodeTracking.PollAsync(store) == 0, "unchanged baseline is deduplicated");
            await Git(repo, "config", "diff.external", "must-not-be-executed");
            File.WriteAllText(Path.Combine(repo, "code.txt"), "changed after consent\n");
            Check(await CodeTracking.PollAsync(store) == 1, "unstaged edit captured without invoking configured external diff helper");
            var first = store.Read().CodeChanges.Single();
            Check(first.Current.Patch.Contains("+changed after consent") && first.PreviousPatch.Contains("+existing before consent") && first.Current.Additions == 1 && first.Current.Deletions == 1,
                "exact current and previous patches with line counts");
            await Git(repo, "add", "code.txt"); File.WriteAllText(Path.Combine(repo, "code.txt"), "second unstaged edit\n");
            await CodeTracking.PollAsync(store);
            Check(store.Read().CodeChanges.Any(c => c.Current.Layer == "Staged") && store.Read().CodeChanges.Last().Current.Layer == "Unstaged",
                "staged and unstaged layers tracked independently");
            Check(await CodeTracking.PollAsync(store) == 0, "repeated snapshots do not duplicate observations");
            File.WriteAllText(Path.Combine(other, "private.txt"), "unapproved content");
            File.WriteAllText(Path.Combine(repo, "new.txt"), "untracked disabled");
            await CodeTracking.PollAsync(store);
            Check(!store.Read().CodeChanges.Any(c => c.Current.Path == "new.txt") && store.Read().Repositories.Count == 1,
                "untracked files and unrelated repositories are not captured without approval");
            await Commit(repo); await CodeTracking.PollAsync(store);
            Check(store.Read().CodeChanges.Any(c => c.Current.Layer == "Commit" && c.Current.Reference.Length == 40 && c.Current.Patch.Contains("changed after consent")),
                "new commits retain exact patches and commit references");
            var count = store.Read().CodeChanges.Count;
            store.Update(s => { CodeTracking.Pause(s, id, true); return true; });
            File.WriteAllText(Path.Combine(repo, "code.txt"), "paused edit\n");
            Check(await CodeTracking.PollAsync(store) == 0 && store.Read().CodeChanges.Count == count, "pause stops observation");
            store.Update(s => { CodeTracking.Pause(s, id, false); return true; });
            Check(await CodeTracking.PollAsync(store) > 0, "resume compares to last baseline with explicit interval semantics");
            var r = store.Read().Repositories.Single();
            Check(!RepositoryReader.SafePath(r, "../other/private.txt") && !RepositoryReader.SafePath(r, ".git/config") &&
                !RepositoryReader.SafePath(r, ".env.local") && !RepositoryReader.SafePath(r, "a.private"), "boundaries, Git internals, sensitive and configured paths excluded");
            var link = Path.Combine(repo, "linked.txt");
            try
            {
                File.CreateSymbolicLink(link, Path.Combine(other, "private.txt"));
                Check(!RepositoryReader.SafePath(r, "linked.txt"), "symlink to unapproved content rejected"); File.Delete(link);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException && (ex.HResult & 0xffff) == 1314)
            {
                Console.WriteLine("SKIP OS did not permit creating symlink fixture.");
                var junction = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Application Data");
                if (Directory.Exists(junction) && (File.GetAttributes(junction) & FileAttributes.ReparsePoint) != 0)
                    await Reject(() => Task.Run(() => RepositoryReader.NoLinks(junction)), "existing Windows profile junction is rejected without traversal");
            }
            store.Update(s => { CodeTracking.Revoke(s, id); return true; });
            File.WriteAllText(Path.Combine(repo, "code.txt"), "after revoke\n");
            Check(await CodeTracking.PollAsync(store) == 0, "revocation prevents reads and new observations");
            var second = await CodeTracking.ApproveAsync(store, repo, true, Array.Empty<string>());
            File.WriteAllText(Path.Combine(repo, "new.txt"), "approved untracked edit");
            File.WriteAllBytes(Path.Combine(repo, "binary.bin"), new byte[] { 0, 1, 2, 0 });
            File.WriteAllText(Path.Combine(repo, "huge.txt"), new string('a', RepositoryReader.MaxFile + 1));
            File.WriteAllText(Path.Combine(repo, ".env.test"), "secret=DO-NOT-CAPTURE");
            await CodeTracking.PollAsync(store);
            Check(store.Read().CodeChanges.Any(c => c.RepositoryId == second && c.Current.Path == "new.txt" && c.Current.Patch.Contains("@@ -0,0 +1,1 @@") && c.Current.Patch.Contains("No newline at end of file")),
                "explicit untracked approval captures bounded textual additions and newline markers");
            Check(!store.Read().CodeChanges.Any(c => c.Current.Path is "binary.bin" or "huge.txt" or ".env.test"), "binary, oversized and credential files excluded");
            File.WriteAllText(Path.Combine(repo, "new.txt"), "api_key=fixture-private-secret\nuseful edit\n"); await CodeTracking.PollAsync(store);
            var change = store.Read().CodeChanges.Last(c => c.Current.Path == "new.txt");
            Check(change.Current.Patch.Contains("fixture-private-secret") && !File.ReadAllText(Path.Combine(data, "work-v1.json")).Contains("fixture-private-secret"), "exact local source protected at rest");
            store.Update(s => { TaskService.Associate(s, new[] { change.Id }, originalTask.Id); s.Settings.ExternalEnabled = true; return true; });
            var state = store.Read();
            Check(TaskService.Package(state, originalTask.Id).Timeline.All(e => e.Change is null), "default task package never implicitly includes source diffs");
            var package = TaskService.Package(state, originalTask.Id, new[] { change.Id });
            Check(package.Timeline.Single().Change is not null && !WorkJson.Serialize(package).Contains("fixture-private-secret") && !WorkJson.Serialize(package).Contains(repo),
                "selected diff is minimized and no local root or detected secret enters payload");
            Check(package.Timeline.Single().Change!.Attribution.Contains("unknown") && package.Timeline.Single().Outcome == "unknown", "no inferred authorship or implementation success");
            var claim = new TaskAnalysis("Fixture", "unresolved", new[] { new Claim("changes", package.Timeline[0].Summary, "OBSERVED", 1, new[] { "E1" }) });
            Check(DeepSeekProvider.Validate(WorkJson.Serialize(claim), package).Claims[0].Basis == "OBSERVED", "exact change evidence accepted by provenance validator");
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate(WorkJson.Serialize(claim with { Status = "completed" }), package)), "source diffs cannot prove task completion");
            var attempts = state.CodeChanges.Where(c => c.RepositoryId == second).TakeLast(2).Select(c => c.Id).ToArray();
            store.Update(s => { TaskService.Associate(s, attempts, originalTask.Id); return true; });
            Check(TaskService.Package(store.Read(), originalTask.Id, attempts).Timeline.Count(e => e.Change is not null) == 2,
                "multiple implementation snapshots can be explicitly selected for comparison");
            var fingerprint = TaskService.Fingerprint(store.Read(), originalTask.Id);
            var altered = store.Read(); var original = altered.CodeChanges.Single(c => c.Id == change.Id);
            altered.CodeChanges[altered.CodeChanges.IndexOf(original)] = original with { Current = original.Current with { Patch = "different source" } };
            Check(TaskService.Fingerprint(altered, originalTask.Id) != fingerprint, "cache and approval fingerprint includes actual source snapshots");
            var provider = new NeverSend(); var coordinator = new AnalysisCoordinator(store, provider);
            var preview = coordinator.Prepare(originalTask.Id, new[] { change.Id });
            var receiptRepo = state.Repositories.Single(x => x.Id == second); var now = DateTimeOffset.UtcNow;
            string Receipt(int code)
            {
                var payload = WorkJson.Serialize(new ProcessReceipt(second, now.AddSeconds(-1), now, "test", code, "", ""));
                return WorkJson.Serialize(new SignedReceipt(payload, Convert.ToHexString(HMACSHA256.HashData(Convert.FromBase64String(receiptRepo.ReceiptKey), Encoding.UTF8.GetBytes(payload)))));
            }
            var pass = Receipt(0); var fail = Receipt(7);
            Check(store.Update(s => VerificationReceipts.Accept(s, pass, now))?.ExitCode == 0 && store.Update(s => VerificationReceipts.Accept(s, fail, now))?.Outcome == "failed",
                "authenticated recorder receipts preserve actual exit status and passed/failed results");
            Check(store.Update(s => VerificationReceipts.Accept(s, pass, now)) is null && store.Update(s => VerificationReceipts.Accept(s, fail.Replace("7", "9"), now)) is null,
                "duplicate and tampered verification receipts rejected");
            var recorder = Path.Combine(Directory.GetCurrentDirectory(), "integrations", "code-changes", "record-result.py");
            var start = new System.Diagnostics.ProcessStartInfo("python") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.Environment["LOCALAPPDATA"] = Path.Combine(root, "AppData");
            foreach (var arg in new[] { recorder, "--repository", repo, "--kind", "test", "--", "python", "-c", "import sys; sys.exit(4)" }) start.ArgumentList.Add(arg);
            using (var process = System.Diagnostics.Process.Start(start)!)
            { await process.WaitForExitAsync(); Check(process.ExitCode == 4, "real Python recorder decrypts Windows consent and preserves child exit status"); }
            Check(store.Update(s => VerificationReceipts.Import(s, Path.Combine(data, "CodeResults"))) == 1 && store.Read().Evidence.Any(e => e.ExitCode == 4),
                "real user-invoked process receipt is imported without command/output capture");
            var snapshot = await RepositoryReader.Capture(receiptRepo);
            store.Update(s => { CodeTracking.Revoke(s, second); return true; });
            Check(store.Update(s => CodeTracking.Apply(s, s.Repositories.Single(r => r.Id == second), snapshot, now)) == 0 &&
                store.Update(s => VerificationReceipts.Accept(s, Receipt(3), now)) is null, "revocation wins over in-flight snapshots and queued receipts");
            await Reject(async () => { await coordinator.ApproveAndAnalyzeAsync(preview, true); }, "revocation invalidates an already reviewed code payload");
            Check(provider.Calls == 0, "no external provider call after repository revocation");
            await Reject(() => Task.Run(() => TaskService.Package(store.Read(), originalTask.Id, new[] { change.Id })), "revoked code cannot be prepared for external transmission");
            store.Update(s => { s.Analyses["code-cache"] = new SavedAnalysis(originalTask.Id, "fixture", s.Settings.Model, now, claim, package, new[] { change.Id }); return true; });
            store.Update(s => { CodeTracking.DeleteHistory(s, second); return true; });
            Check(!store.Read().Analyses.ContainsKey("code-cache"), "deleting source history also removes analysis copies citing it");
            Check(!store.Read().CodeChanges.Any(c => c.RepositoryId == second) && !store.Read().Evidence.Any(e => e.Id == change.Id) && !store.Read().Associations.ContainsKey(change.Id),
                "delete history removes source snapshots and associations");
            // A non-descendant HEAD establishes a fresh baseline without inventing new edits.
            var third = await CodeTracking.ApproveAsync(store, repo, false, Array.Empty<string>());
            var beforeReset = store.Read().CodeChanges.Count;
            await Git(repo, "reset", "--soft", "HEAD^1"); await CodeTracking.PollAsync(store);
            Check(store.Read().CodeChanges.Count == beforeReset && store.Read().Repositories.Single(r => r.Id == third).Status.Contains("baseline reset"),
                "rewritten HEAD resets baseline without importing old work as new");
            await Git(other, "config", "filter.unsafe.clean", "must-not-be-executed");
            await Reject(() => CodeTracking.ApproveAsync(store, other, false, Array.Empty<string>()), "executable clean filters rejected before any diff reads");
            var emptyRepo = Path.Combine(root, "empty"); Directory.CreateDirectory(emptyRepo); await Git(emptyRepo, "init");
            var emptyId = await CodeTracking.ApproveAsync(store, emptyRepo, false, Array.Empty<string>());
            File.WriteAllText(Path.Combine(emptyRepo, "first.txt"), "first commit\n"); await Git(emptyRepo, "add", "first.txt"); await Commit(emptyRepo);
            await CodeTracking.PollAsync(store);
            Check(store.Read().CodeChanges.Any(c => c.RepositoryId == emptyId && c.Current.Layer == "Commit"), "first commit after an unborn baseline captured");
            store.Update(s => { var old = s.CodeChanges[0]; s.CodeChanges[0] = old with { At = now.AddDays(-31) }; CodeTracking.Prune(s, now); return true; });
            Check(store.Read().CodeChanges.All(c => c.At >= now.AddDays(-30)), "30-day source retention enforced");
            store.Update(s => { s.Repositories.Single(r => r.Id == emptyId).BaselineAt = now.AddDays(-31); return true; });
            await Reject(() => Task.Run(() => store.Update(s => { CodeTracking.Pause(s, emptyId, false); return true; })),
                "expired baseline cannot resume and relabel historical commits as new");
        }
        finally
        {
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.Combine(Path.GetFullPath(Path.GetTempPath()), "gcr-code-fixtures-"), StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe fixture cleanup");
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(root, true);
        }
    }
}
