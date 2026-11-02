using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using GentleControlRoom.Desktop.CodingWork;

internal static class GitHubCommitTests
{
    private static void Check(bool yes, string message)
    {
        if (!yes) throw new Exception("GitHub commit evidence: " + message);
        Console.WriteLine("PASS GitHub commit evidence: " + message);
    }

    private sealed class GitHubResponse : HttpMessageHandler
    {
        public int Requests;
        public Uri? LastRequest;
        public bool Rename;
        public bool UnsafeRename;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Requests++; LastRequest = request.RequestUri;
            object changedFile = Rename
                ? new {
                    filename = "src/new.tsx",
                    previous_filename = UnsafeRename ? ".env.local" : "src/old.tsx",
                    status = "renamed", additions = 1, deletions = 1,
                    patch = "@@ -1 +1 @@\n-old code\n+new code"
                }
                : new {
                    filename = "src/main.tsx", status = "modified", additions = 1, deletions = 0,
                    patch = "@@ -2,4 +2,5 @@\n import App from \"./App.tsx\";\n import \"./index.css\";\n \n+// Gentle Control Room tracking test: this harmless change should appear in local Git diffs.\n createRoot(document.getElementById(\"root\")!).render(<App />);"
                };
            var json = JsonSerializer.Serialize(new
            {
                sha = "28de267f6353f99977c5185080f5573a45ab12de",
                files = new[] { changedFile }
            });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }
    internal static async Task Run()
    {
        Check(GitHubCommitImporter.RemoteName("https://github.com/Testerinopapa/gentle-control-room.git") ==
            "testerinopapa/gentle-control-room", "recognizes public HTTPS origin");
        Check(GitHubCommitImporter.RemoteName("git@github.com:Testerinopapa/gentle-control-room.git") ==
            "testerinopapa/gentle-control-room", "recognizes GitHub SSH origin");
        Check(GitHubCommitImporter.RemoteName("https://github.com.evil.invalid/a/b") is null &&
            GitHubCommitImporter.RemoteName("https://evil.invalid/a/b") is null,
            "does not trust unrelated hosts");
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP GitHub importer requires Windows DPAPI"); return; }

        var root = Path.Combine(Path.GetTempPath(), "gcr-github-commits-" + Guid.NewGuid().ToString("N"));
        var local = Path.Combine(root, "local"); var data = Path.Combine(root, "activity");
        Directory.CreateDirectory(local);
        Directory.CreateDirectory(data);
        try
        {
            var init = await RepositoryReader.Git(local, "init");
            Check(init.Code == 0, "fixture git repository initialized");
            var remote = await RepositoryReader.Git(local, "remote", "add", "origin",
                "https://github.com/Testerinopapa/gentle-control-room.git");
            Check(remote.Code == 0, "fixture origin configured without network access");
            var store = new WorkStore(data);
            store.Update(s => { s.LocalEnabled = true; return true; });
            var approval = await CodeTracking.ApproveAsync(store, local, false, Array.Empty<string>());
            var session = "123e4567-e89b-42d3-a456-426614174000";
            var at = DateTimeOffset.UtcNow;
            var browserLine = JsonSerializer.Serialize(new {
                schemaVersion = 1, source = "chatgpt_browser", timestamp = at,
                eventType = "github_commit_ref", sessionPseudonym = session,
                repository = "testerinopapa/gentle-control-room",
                commitSha = "28de267f6353f99977c5185080f5573a45ab12de",
                prompt = "PRIVATE CONVERSATION"
            });
            var reference = EvidenceImporter.Normalize(browserLine, "ChatGPT", "fixture", 0, at.AddMinutes(1));
            Check(reference is not null && reference.Kind == "github_commit_reference" &&
                !JsonSerializer.Serialize(reference).Contains("PRIVATE CONVERSATION"),
                "approved browser metadata normalization discards conversation text");
            store.Update(s => { s.Evidence.Add(reference!); return true; });
            var wrongLink = browserLine.Replace("testerinopapa/gentle-control-room", "someone/else");
            var wrong = EvidenceImporter.Normalize(wrongLink, "ChatGPT", "fixture", 100, at.AddMinutes(1));
            store.Update(s => { s.Evidence.Add(wrong!); return true; });
            var handler = new GitHubResponse();
            using var http = new HttpClient(handler);
            Check(await GitHubCommitImporter.ImportAsync(store, http) == 1 &&
                handler.Requests == 1 &&
                handler.LastRequest?.Host == "api.github.com",
                "one matched approved reference fetches only its GitHub commit");
            var after = store.Read();
            var change = after.CodeChanges.Single();
            var actual = after.Evidence.Single(e => e.Id == change.Id);
            Check(change.Current.Path == "src/main.tsx" &&
                change.Current.Patch.Contains("+// Gentle Control Room tracking test:") &&
                change.Current.Layer == "GitHub commit" &&
                actual.SessionKey == reference!.SessionKey &&
                actual.Reference == "28de267f6353f99977c5185080f5573a45ab12de",
                "exact GitHub patch stays tied to the originating browser session");
            Check(await GitHubCommitImporter.ImportAsync(store, http) == 0 && handler.Requests == 1,
                "repeated timer checks do not fetch or store the commit again");
            // GitHub reports renamed files using the new filename plus previous_filename.
            // Patch headers must preserve both paths, and exclusions apply to both.
            var renameHandler = new GitHubResponse { Rename = true };
            using var renameHttp = new HttpClient(renameHandler);
            var approvedRepo = store.Read().Repositories.Single(x => x.Id == approval);
            var renamed = await GitHubCommitImporter.DownloadAsync(renameHttp, approvedRepo,
                "testerinopapa/gentle-control-room", "28de267f6353f99977c5185080f5573a45ab12de");
            Check(renamed.Length == 1 && renamed[0].Path == "src/new.tsx" &&
                renamed[0].Patch.Contains("diff --git a/src/old.tsx b/src/new.tsx") &&
                renamed[0].Patch.Contains("rename from src/old.tsx\nrename to src/new.tsx") &&
                renamed[0].Patch.Contains("--- a/src/old.tsx\n+++ b/src/new.tsx"),
                "renamed file patch includes original and new filenames");
            renameHandler.UnsafeRename = true;
            var excludedRename = await GitHubCommitImporter.DownloadAsync(renameHttp, approvedRepo,
                "testerinopapa/gentle-control-room", "28de267f6353f99977c5185080f5573a45ab12de");
            Check(excludedRename.Length == 0,
                "renamed patch is excluded when its original filename was sensitive");
            var task = store.Update(s => TaskService.Create(s, "Inspect linked GitHub change", "fixture"));
            store.Update(s => { TaskService.Associate(s, new[] { change.Id }, task.Id); return true; });
            var included = TaskService.Package(store.Read(), task.Id, new[] { change.Id });
            var excluded = TaskService.Package(store.Read(), task.Id);
            Check(included.Timeline.Any(e => e.Change?.Diff.Contains("+// Gentle Control Room tracking test:") == true) &&
                excluded.Timeline.All(e => e.Change is null),
                "only explicitly selected source appears in DeepSeek preview");
            store.Update(s => { CodeTracking.Revoke(s, approval); return true; });
            Check(await GitHubCommitImporter.ImportAsync(store, http) == 0 && handler.Requests == 1,
                "revoked repository cannot trigger GitHub requests");
        }
        finally { Directory.Delete(root, true); }
    }
}
