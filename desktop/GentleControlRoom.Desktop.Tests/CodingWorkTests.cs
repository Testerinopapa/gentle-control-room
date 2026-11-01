using GentleControlRoom.Desktop.CodingWork;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;

internal static class CodingWorkTests
{
    private static void Check(bool condition, string name) { if (!condition) throw new Exception(name); Console.WriteLine("PASS harness: " + name); }
    private static async Task Reject(Func<Task> action, string name) { try { await action(); } catch (Exception) { Check(true, name); return; } throw new Exception(name); }
    private static TaskAnalysis Valid(EvidencePackage p) => new(p.Objective, "unresolved", new[] {
        new Claim("unknowns", "Technical outcomes remain unverified in the available evidence.", "UNVERIFIED", 1, new[] { p.Timeline[0].Id }) });
    internal static async Task Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "gcr-harness-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var now = DateTimeOffset.UtcNow;
            string Legacy(string session, string category, int seconds, string source = "Codex") => JsonSerializer.Serialize(new {
                schemaVersion = 1, timestamp = now.AddMinutes(-10).AddSeconds(seconds), sessionPseudonym = session,
                projectPseudonym = "PRIVATE-PROJECT", eventType = source == "Codex" ? "tool_used" : "workflow_stage",
                source = "chatgpt_browser", toolCategory = category, workflowStage = category,
                prompt = "PRIVATE RAW CONVERSATION", command = "PASSWORD=secret", secret = "NEVER-COPY" });
            var state = new WorkState { LocalEnabled = true };
            var a = TaskService.Create(state, "Fix browser integration", "example/project");
            var b = TaskService.Create(state, "Improve another feature", "example/project");
            var e1 = EvidenceImporter.Normalize(Legacy("one", "file_edit", 4), "Codex", "fixture", 0, now)!;
            var e2 = EvidenceImporter.Normalize(Legacy("two", "test_build", 2), "Codex", "fixture", 200, now)!;
            var e3 = EvidenceImporter.Normalize(Legacy("one", "shell", 5), "Codex", "fixture", 400, now)!;
            Check(e1 is not null && !WorkJson.Serialize(e1).Contains("PRIVATE") && !WorkJson.Serialize(e1).Contains("NEVER-COPY"), "legacy records normalized without raw fields");
            state.Evidence.AddRange(new[] { e1!, e2, e3 });
            TaskService.Associate(state, new[] { e1!.Id, e2.Id }, a.Id);
            TaskService.Associate(state, new[] { e3.Id }, b.Id);
            Check(TaskService.Timeline(state, a.Id).Select(e => e.SessionKey).Where(x => x != "").Distinct().Count() == 2, "multiple sessions form one confirmed task");
            Check(state.Associations[e1.Id] != state.Associations[e3.Id] && e1.SessionKey == e3.SessionKey, "one session can contain distinct tasks");
            Check(TaskService.Timeline(state, a.Id)[0].Id == e2.Id, "timeline ordered by observation timestamp");
            TaskService.Associate(state, new[] { e3.Id }, a.Id);
            Check(state.Associations[e3.Id] == a.Id && state.AssociationHistory.Any(h => h.FromTask == b.Id), "manual correction retained in relationship history");
            var nearby = EvidenceImporter.Normalize(Legacy("unrelated", "shell", 6), "Codex", "fixture", 600, now)! with { ProjectKey = "other" };
            state.Evidence.Add(nearby);
            Check(TaskService.Suggest(state, nearby).Length == 0 && !state.Associations.ContainsKey(nearby.Id), "temporal proximity never groups tasks");
            var proposed = TaskService.Suggest(state, e3);
            Check(proposed.Contains(a.Id), "shared session suggests but does not auto-assign");
            var browser = EvidenceImporter.Normalize(Legacy("browser", "debugging", 8, "ChatGPT"), "ChatGPT", "browser", 0, now)!;
            Check(browser.Basis == "INFERRED" && browser.Outcome == "unknown", "browser classification is not an observed action or outcome");
            var folder = Path.Combine(root, "BrowserActivity"); Directory.CreateDirectory(folder);
            var file = Path.Combine(folder, "events-20260101-000.jsonl");
            File.WriteAllText(file, Legacy("browser", "debugging", 8, "ChatGPT") + "\n{partial");
            var imported = new WorkState();
            Check(EvidenceImporter.Refresh(imported, root, now) == 0, "local normalization requires opt-in");
            imported.LocalEnabled = true;
            Check(EvidenceImporter.Refresh(imported, root, now) == 1 && EvidenceImporter.Refresh(imported, root, now) == 0, "partial lines and incremental unchanged refresh");
            File.AppendAllText(file, "}\n" + Legacy("browser", "testing", 9, "ChatGPT") + "\n");
            Check(EvidenceImporter.Refresh(imported, root, now) == 1 && imported.Evidence.Count == 2, "append resumes without reconstructing history");
            File.WriteAllText(file, Legacy("browser", "implementation", 10, "ChatGPT") + "\n");
            EvidenceImporter.Refresh(imported, root, now);
            Check(imported.Evidence.Count == 1, "rewritten source replaces stale normalized evidence");
            File.WriteAllText(file, Legacy("browser", "debugging", 10, "ChatGPT") + "\n" + Legacy("browser", "testing", 11, "ChatGPT") + "\n");
            EvidenceImporter.Refresh(imported, root, now);
            Check(imported.Evidence.Count == 2 && !imported.Evidence.Any(e => e.Category == "Implementation"), "larger rewritten file is distinguished from an append by prefix fingerprint");
            Check(Privacy.Minimize("password: unsafe\nC:\\Users\\private\\file.txt\nsk-abcdefghijk\nhello").Contains("hello") &&
                !Privacy.Minimize("password: unsafe\nC:\\Users\\private\\file.txt\nsk-abcdefghijk").Contains("unsafe"), "credentials and paths minimized before persistence");
            var store = new WorkStore(Path.Combine(root, "store"));
            store.Update(s => { s.LocalEnabled = true; s.Tasks = state.Tasks; s.Evidence = state.Evidence; s.Associations = state.Associations; return true; });
            Check(new WorkStore(Path.Combine(root, "store")).Read().Tasks.Count == 2, "durable versioned task relationships survive reload");
            var package = TaskService.Package(store.Read(), a.Id);
            var serialized = WorkJson.Serialize(package);
            Check(!serialized.Contains(e1.SessionKey) && !serialized.Contains("PRIVATE") && package.Timeline.All(e => e.Id.StartsWith("E")), "payload uses local evidence and session aliases only");
            var invalid = Valid(package) with { Claims = new[] { new Claim("tests", "All tests passed", "OBSERVED", 1, new[] { package.Timeline[0].Id }) } };
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate(WorkJson.Serialize(invalid), package)), "cannot upgrade metadata to observed test success");
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate(WorkJson.Serialize(Valid(package) with { Status = "completed" }), package)), "no invented completion");
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate("{\"extra\":1}", package)), "strict JSON response schema");
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate(WorkJson.Serialize(Valid(package) with { Claims = new[] { new Claim("actions", "Something happened", "INFERRED", .5, new[] { "missing" }) } }), package)), "every conclusion references existing evidence");
            var fake = new FakeProvider(); var coordinator = new AnalysisCoordinator(store, fake);
            var preview = coordinator.Prepare(a.Id);
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(preview, false), "payload approval enforced");
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(preview, true), "separate external opt-in enforced");
            Check(fake.Calls == 0, "no network before both consent gates");
            store.Update(s => { s.Settings.ExternalEnabled = true; return true; });
            preview = coordinator.Prepare(a.Id);
            var result = await coordinator.ApproveAndAnalyzeAsync(preview, true);
            Check(result.Result.Status == "unresolved" && fake.Calls == 1, "whole-task provider receives coherent multi-session package");
            await coordinator.ApproveAndAnalyzeAsync(coordinator.Prepare(a.Id), true);
            Check(fake.Calls == 1 && store.Read().RequestsReserved == 1, "unchanged analysis cache avoids paid requests");
            var old = coordinator.Prepare(a.Id);
            store.Update(s => TaskService.AddContext(s, a.Id, "A different approach is being investigated.", "Revision"));
            Check(!TaskService.IsCurrent(store.Read(), a), "new evidence marks analysis outdated");
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(old, true), "evidence change invalidates payload approval");
            await coordinator.ApproveAndAnalyzeAsync(coordinator.Prepare(a.Id), true);
            Check(fake.Calls == 2, "changed evidence reanalyzed incrementally");
            Check(store.Read().Analyses[a.Id].Package.Timeline.Length > result.Package.Timeline.Length, "analysis preserves its own citation snapshot");
            store.Update(s => { s.Settings.DailyRequests = 2; TaskService.AddContext(s, a.Id, "New blocker", "Blocker"); return true; });
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(coordinator.Prepare(a.Id), true), "durable request budget blocks extra calls");
            Check(fake.Calls == 2, "budget rejection has no provider call");
            var busy = new FakeProvider { Failures = 1 };
            store.Update(s => { s.Settings.DailyRequests = 10; return true; });
            var retryCoordinator = new AnalysisCoordinator(store, busy);
            await retryCoordinator.ApproveAndAnalyzeAsync(retryCoordinator.Prepare(a.Id), true);
            Check(busy.Calls == 2 && store.Read().RequestsReserved == 4, "retry count bounded and each attempt budgeted");
            var paused = retryCoordinator.Prepare(a.Id);
            store.Update(s => { s.Settings.ExternalEnabled = false; return true; });
            await Reject(async () => await retryCoordinator.ApproveAndAnalyzeAsync(paused, true), "revoked consent blocks even cached analysis execution");
            var patterns = new WorkState();
            foreach (var title in new[] { "Task one", "Task two" })
            {
                var task = TaskService.Create(patterns, title, "Project"); task.Status = "Completed";
                for (int i = 0; i < 4; i++)
                {
                    var ev = e1 with { Id = Guid.NewGuid().ToString(), At = now.AddMinutes(i), Category = i % 2 == 0 ? "Implementation" : "Testing" };
                    patterns.Evidence.Add(ev); TaskService.Associate(patterns, new[] { ev.Id }, task.Id);
                }
            }
            var recurrent = TaskService.FindPatterns(patterns);
            Check(recurrent.Any(p => p.Title.Contains("invocation loops") && p.TaskIds.Length == 2 && p.Frequency == 2), "cross-task edit/test loops require distinct tasks");
            Check(recurrent.Any(p => p.Title.Contains("without captured verification")), "missing testing remains an evidence gap, not an asserted failure");
            var tied = JsonSerializer.Deserialize<WorkState>(WorkJson.Serialize(patterns), WorkJson.Options)!;
            tied.Evidence = tied.Evidence.Select(e => e with { At = now }).ToList();
            Check(!TaskService.FindPatterns(tied).Any(p => p.Title.Contains("invocation loops")), "equal timestamps cannot prove ordered workflow loops");
            var debugTask = patterns.Tasks[0];
            for (int i = 0; i < 3; i++) { var e = browser with { Id = Guid.NewGuid().ToString(), At = now.AddMinutes(i) }; patterns.Evidence.Add(e); TaskService.Associate(patterns, new[] { e.Id }, debugTask.Id); }
            Check(TaskService.FindPatterns(patterns).Any(p => p.TaskIds.Length == 1 && p.Basis == "INFERRED" && p.Frequency == 3), "within-task repeated debugging explicitly distinguished");
            foreach (var task in patterns.Tasks)
            {
                var context = TaskService.AddContext(patterns, task.Id, "The service rejected the configured callback; the attempted fix changed its configuration.", "Blocker");
                var pack = TaskService.Package(patterns, task.Id);
                var alias = pack.Timeline.Single(x => x.Summary == context.Summary).Id;
                var ai = new TaskAnalysis(task.Objective, "unresolved", new[] { new Claim("problems", "The reported blocker may relate to configuration.", "INFERRED", .7, new[] { alias }, "configuration_failure") });
                DeepSeekProvider.Validate(WorkJson.Serialize(ai), pack);
                patterns.Analyses[task.Id] = new(task.Id, TaskService.Fingerprint(patterns, task.Id), patterns.Settings.Model, now, ai, pack);
            }
            var theme = TaskService.FindPatterns(patterns).Single(p => p.Title == "Configuration problems across tasks");
            Check(theme.TaskIds.Length == 2 && theme.Basis == "INFERRED" && TaskService.PatternEvidence(patterns, theme.EvidenceIds[0]).Contains("reported") == false,
                "semantic recurrence derives from cited whole-task analyses, not prompt keywords");
            TaskService.AddContext(patterns, patterns.Tasks[0].Id, "More evidence arrived.");
            Check(!TaskService.FindPatterns(patterns).Any(p => p.Title == "Configuration problems across tasks"), "outdated AI analyses cannot establish recurrence");
            var verifiedPackage = package with { Timeline = new[] { new PackageEvidence("E1", "Test runner fixture", "Session 1", now,
                "test_result", "Testing", "The recorded test process exited successfully.", "OBSERVED", "passed", "", null) } };
            var verified = new TaskAnalysis(package.Objective, "active", new[] { new Claim("tests", verifiedPackage.Timeline[0].Summary, "OBSERVED", 1, new[] { "E1" }) });
            Check(DeepSeekProvider.Validate(WorkJson.Serialize(verified), verifiedPackage).Claims[0].Basis == "OBSERVED", "explicit recorded test result can support an observed result");
            await Reject(() => Task.Run(() => DeepSeekProvider.Validate(WorkJson.Serialize(verified), verifiedPackage with { Timeline = new[] { verifiedPackage.Timeline[0] with { Basis = "UNVERIFIED" } } })), "reported results cannot become observed tests");
            if (OperatingSystem.IsWindows())
            {
                var vault = new WindowsAnalysisSecret(Path.Combine(root, "keys"));
                vault.Save("fixture-key-not-real");
                Check(vault.Read() == "fixture-key-not-real" && !Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(root, "keys", "deepseek-key.dpapi"))).Contains("fixture-key"), "Windows user-scoped DPAPI secret round trip");
                vault.Delete();
                Check(!File.Exists(Path.Combine(root, "keys", "deepseek-key.dpapi")), "API key removal deletes encrypted secret");
            }
            var secret = new FakeSecret();
            var response = JsonSerializer.Serialize(new { choices = new[] { new { finish_reason = "stop", message = new { content = WorkJson.Serialize(Valid(package)) } } } });
            var handler = new FakeHandler((req, _) => {
                Check(req.RequestUri!.Host == "api.deepseek.com" && req.Headers.Authorization?.Scheme == "Bearer", "official endpoint and header-only key");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response) });
            });
            var provider = new DeepSeekProvider(new HttpClient(handler), secret);
            await provider.AnalyzeAsync(DeepSeekProvider.Request(package, new()), package, 5, default);
            var timeoutProvider = new DeepSeekProvider(new HttpClient(new FakeHandler(async (_, ct) => { await Task.Delay(10000, ct); return new(HttpStatusCode.OK); })), secret);
            await Reject(async () => await timeoutProvider.AnalyzeAsync("{}", package, 0, default), "API timeout handled without sensitive exception details");
            var failProvider = new DeepSeekProvider(new HttpClient(new FakeHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("SECRET RESPONSE") }))), secret);
            try { await failProvider.AnalyzeAsync("{}", package, 5, default); throw new Exception("expected failure"); }
            catch (AnalysisFailure ex) { Check(!ex.Message.Contains("SECRET"), "raw server errors never leak to logs or UI"); }
            var blank = new DeepSeekProvider(new HttpClient(new FakeHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"   \"}}]}") }))), secret);
            await Reject(async () => await blank.AnalyzeAsync("{}", package, 5, default), "blank JSON mode content rejected");
            var offline = new DeepSeekProvider(new HttpClient(new FakeHandler((_, _) => throw new HttpRequestException("PRIVATE NETWORK DETAILS"))), secret);
            try { await offline.AnalyzeAsync("{}", package, 5, default); throw new Exception("expected failure"); }
            catch (AnalysisFailure ex) { Check(!ex.Message.Contains("PRIVATE"), "offline failure remains safe and local evidence preserved"); }
            store.Update(s => { s.Settings.ExternalEnabled = true; s.Settings.DailyTokenBudget = 1000; TaskService.AddContext(s, a.Id, "Token budget check"); return true; });
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(coordinator.Prepare(a.Id), true), "token reservation budget enforced before request");
            store.Update(s => { s.Settings.DailyTokenBudget = 100000; s.Settings.Retries = 1; return true; });
            var alwaysBusy = new FakeProvider { Failures = 10 }; var bounded = new AnalysisCoordinator(store, alwaysBusy);
            await Reject(async () => await bounded.ApproveAndAnalyzeAsync(bounded.Prepare(a.Id), true), "API failures stop after bounded retry count");
            Check(alwaysBusy.Calls == 2, "no unbounded network retry loop");
            var tampered = coordinator.Prepare(a.Id);
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(tampered with { Payload = "PRIVATE UNAPPROVED TEXT" }, true), "preview tampering cannot bypass payload review");
            var changedSettings = coordinator.Prepare(a.Id);
            store.Update(s => { s.Settings.Retries = 0; return true; });
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(changedSettings, true), "changed retry and budget configuration requires new approval");
            var detached = coordinator.Prepare(a.Id);
            store.Update(s => { TaskService.Associate(s, new[] { e1.Id }, b.Id); return true; });
            await Reject(async () => await coordinator.ApproveAndAnalyzeAsync(detached, true), "manual reassociation invalidates previously reviewed package");
            var gitRoot = Path.Combine(root, "repository"); Directory.CreateDirectory(gitRoot);
            async Task Git(params string[] command)
            {
                var start = new System.Diagnostics.ProcessStartInfo("git") { WorkingDirectory = gitRoot, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                foreach (var arg in command) start.ArgumentList.Add(arg);
                using var process = System.Diagnostics.Process.Start(start)!;
                var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync(); await stdout; await stderr;
                if (process.ExitCode != 0) throw new Exception("Git fixture setup failed");
            }
            await Git("init");
            File.WriteAllText(Path.Combine(gitRoot, "private-name.txt"), "PRIVATE SOURCE CONTENT");
            await Git("add", "private-name.txt");
            await Git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=NUL", "commit", "-m", "PRIVATE COMMIT MESSAGE");
            var commits = await GitEvidence.ReadAsync(gitRoot);
            Check(commits.Length == 1 && commits[0].FilesChanged == 1 && commits[0].Kind == "git_commit" &&
                !WorkJson.Serialize(commits).Contains("PRIVATE") && !WorkJson.Serialize(commits).Contains("private-name"), "local Git evidence records actual commit and file count without private text");
            var xaml = XDocument.Load(Path.Combine(AppContext.BaseDirectory, "CodingWorkPanel.xaml"));
            Check(xaml.Root!.Attribute("FontSize")!.Value == "16" && !xaml.Descendants().Any(n => n.Attribute("FontSize") is { } z && double.Parse(z.Value) < 16), "native analyzer minimum font size 16");
            Check(xaml.Descendants().Any(n => (string?)n.Attribute("Click") == "Send_Click") && xaml.Descendants().Any(n => n.Name.LocalName == "PasswordBox"), "native explicit approval and password input wired");
            var main = XDocument.Load(Path.Combine(AppContext.BaseDirectory, "MainWindow.xaml"));
            Check(main.Descendants().Any(n => n.Name.LocalName == "CodingWorkPanel"), "analyzer integrated in existing native workspace");
            var badRoot = Path.Combine(root, "future"); Directory.CreateDirectory(badRoot);
            File.WriteAllText(Path.Combine(badRoot, "work-v1.json"), "{\"SchemaVersion\":999}");
            await Reject(() => Task.Run(() => new WorkStore(badRoot).Read()), "unknown persistence versions fail closed without overwriting");
        }
        finally
        {
            var expected = Path.Combine(Path.GetFullPath(Path.GetTempPath()), "gcr-harness-tests-");
            if (!Path.GetFullPath(root).StartsWith(expected, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe fixture cleanup path");
            // Git stores loose objects read-only on Windows.
            foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)) File.SetAttributes(path, FileAttributes.Normal);
            Directory.Delete(root, true);
        }
    }
    private sealed class FakeProvider : IAnalysisProvider
    {
        public int Calls, Failures;
        public Task<TaskAnalysis> AnalyzeAsync(string request, EvidencePackage package, int seconds, CancellationToken token)
        { Calls++; if (Failures-- > 0) throw new AnalysisFailure("Busy", true); return Task.FromResult(Valid(package)); }
    }
    private sealed class FakeSecret : IAnalysisSecret { public string Read() => "FAKE-KEY"; public void Save(string key) { } public void Delete() { } }
    private sealed class FakeHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken); }
}
