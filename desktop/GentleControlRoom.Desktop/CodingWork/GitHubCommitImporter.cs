using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GentleControlRoom.Desktop.CodingWork;

// A ChatGPT link establishes only that a commit URL appeared in an opted-in
// assistant message. GitHub's response supplies the real patch. Neither
// source establishes who made the edit or whether it worked.
internal static class GitHubCommitImporter
{
    private const int MaxResponse = 512 * 1024;
    private static readonly HttpClient Shared = new(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(15) };

    internal static string? RemoteName(string raw)
    {
        var value = raw.Trim();
        string tail;
        if (value.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase))
            tail = value["https://github.com/".Length..];
        else if (value.StartsWith("git@github.com:", StringComparison.OrdinalIgnoreCase))
            tail = value["git@github.com:".Length..];
        else if (value.StartsWith("ssh://git@github.com/", StringComparison.OrdinalIgnoreCase))
            tail = value["ssh://git@github.com/".Length..];
        else return null;
        tail = tail.TrimEnd('/');
        if (tail.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) tail = tail[..^4];
        return Regex.IsMatch(tail, @"^[a-z0-9-]{1,39}/[a-z0-9_.-]{1,100}$", RegexOptions.IgnoreCase)
            ? tail.ToLowerInvariant() : null;
    }

    internal static async Task<string?> ApprovedRemoteAsync(TrackedRepository repository)
    {
        if (!repository.Approved || repository.Paused) return null;
        try
        {
            // No remote fetch: this command only reads approved local Git configuration.
            var result = await RepositoryReader.Git(repository.Root, "remote", "get-url", "origin");
            return result.Code == 0 ? RemoteName(result.Output) : null;
        }
        catch { return null; }
    }

    internal static async Task<FileChange[]> DownloadAsync(HttpClient client, TrackedRepository approved,
        string repository, string sha, CancellationToken token = default)
    {
        if (!Regex.IsMatch(repository, @"^[a-z0-9-]{1,39}/[a-z0-9_.-]{1,100}$", RegexOptions.IgnoreCase) ||
            !Regex.IsMatch(sha, @"^[a-f0-9]{40}$", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Invalid GitHub reference.");
        // A fixed HTTPS authority avoids redirects to other servers and SSRF.
        using var request = new HttpRequestMessage(HttpMethod.Get,
            "https://api.github.com/repos/" + repository + "/commits/" + sha);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("GentleControlRoom", "0.5"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (!response.IsSuccessStatusCode || (int)response.StatusCode is >= 300 and <= 399 ||
            response.Content.Headers.ContentLength > MaxResponse)
            throw new InvalidOperationException("GitHub commit details unavailable.");
        using var stream = await response.Content.ReadAsStreamAsync(token);
        var bytes = new byte[MaxResponse + 1];
        int length = 0, count;
        while (length < bytes.Length &&
               (count = await stream.ReadAsync(bytes.AsMemory(length), token)) > 0) length += count;
        if (length > MaxResponse) throw new InvalidOperationException("GitHub evidence response exceeds limit.");

        using var json = JsonDocument.Parse(bytes.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 32 });
        var root = json.RootElement;
        if (!root.TryGetProperty("sha", out var commit) ||
            !string.Equals(commit.GetString(), sha, StringComparison.OrdinalIgnoreCase) ||
            !root.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array ||
            files.GetArrayLength() > 100)
            throw new InvalidOperationException("GitHub response is not a matching commit.");
        var changes = new List<FileChange>();
        int total = 0;
        foreach (var entry in files.EnumerateArray())
        {
            if (!entry.TryGetProperty("filename", out var pathValue) || pathValue.ValueKind != JsonValueKind.String ||
                !entry.TryGetProperty("patch", out var patchValue) || patchValue.ValueKind != JsonValueKind.String) continue;
            var path = pathValue.GetString()!;
            if (!RepositoryReader.SafePath(approved, path)) continue;
            var hunk = patchValue.GetString()!;
            if (!hunk.StartsWith("@@ ", StringComparison.Ordinal) || hunk.Contains('\0') ||
                hunk.Contains("GIT binary patch") || hunk.Contains("Binary files")) continue;
            if (!entry.TryGetProperty("additions", out var adds) || !adds.TryGetInt32(out var plus) ||
                !entry.TryGetProperty("deletions", out var dels) || !dels.TryGetInt32(out var minus) ||
                plus < 0 || minus < 0) continue;
            var kind = entry.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String
                ? status.GetString() : "modified";
            // GitHub uses the NEW filename for a rename. Preserve the old name
            // in the patch headers and enforce exclusions against both paths.
            var previousPath = path;
            if (kind == "renamed")
            {
                if (!entry.TryGetProperty("previous_filename", out var oldName) ||
                    oldName.ValueKind != JsonValueKind.String) continue;
                previousPath = oldName.GetString()!;
                if (!RepositoryReader.SafePath(approved, previousPath)) continue;
            }
            var before = kind == "added" ? "/dev/null" : "a/" + previousPath;
            var after = kind == "removed" ? "/dev/null" : "b/" + path;
            var rename = kind == "renamed"
                ? "rename from " + previousPath + "\nrename to " + path + "\n" : "";
            // GitHub supplies the exact patch hunk; accurately reconstruct Git headers.
            var patch = "diff --git a/" + previousPath + " b/" + path + "\n" + rename +
                "--- " + before + "\n+++ " + after + "\n" + hunk + "\n";
            var size = Encoding.UTF8.GetByteCount(patch);
            if (size > RepositoryReader.MaxPatch) continue;
            total += size;
            if (total > MaxResponse / 2) throw new InvalidOperationException("Commit evidence exceeds local limit.");
            changes.Add(new FileChange(path, "GitHub commit", patch, plus, minus, sha));
        }
        return changes.ToArray();
    }

    internal static async Task<int> ImportAsync(WorkStore store, HttpClient? transport = null)
    {
        var state = store.Read();
        if (!state.LocalEnabled) return 0;
        var references = state.Evidence.Where(e => e.Source == "ChatGPT" &&
            e.Kind == "github_commit_reference" && e.Reference.Contains('@')).TakeLast(100).ToArray();
        if (references.Length == 0) return 0;
        var remotes = new Dictionary<string, TrackedRepository>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in state.Repositories.Where(r => r.Approved && !r.Paused))
        {
            var remote = await ApprovedRemoteAsync(candidate);
            if (remote is not null) remotes.TryAdd(remote, candidate);
        }
        int added = 0, fetched = 0;
        foreach (var reference in references)
        {
            if (fetched >= 3) break;
            var at = reference.Reference.LastIndexOf('@');
            if (at < 1) continue;
            var name = reference.Reference[..at];
            var sha = reference.Reference[(at + 1)..];
            if (!remotes.TryGetValue(name, out var approved)) continue;
            var key = approved.Id + ":" + sha;
            if (state.ImportedGitHubCommits.Contains(key) ||
                (state.GitHubRetryAfter.TryGetValue(key, out var until) && until > DateTimeOffset.UtcNow)) continue;
            fetched++;
            try
            {
                var patches = await DownloadAsync(transport ?? Shared, approved, name, sha);
                added += store.Update(s =>
                {
                    var current = s.Repositories.FirstOrDefault(r => r.Id == approved.Id);
                    if (!s.LocalEnabled || current is null || !current.Approved || current.Paused ||
                        current.ReceiptKey != approved.ReceiptKey || current.Identity != approved.Identity ||
                        !s.Evidence.Any(e => e.Id == reference.Id) || s.ImportedGitHubCommits.Contains(key))
                        return 0;
                    var time = DateTimeOffset.UtcNow;
                    foreach (var patch in patches)
                    {
                        var id = Guid.NewGuid().ToString("N");
                        s.CodeChanges.Add(new CodeChange(id, current.Id, time, patch, ""));
                        s.Evidence.Add(new Observation(id, "GitHub commit", reference.SessionKey,
                            WorkJson.Hash(current.Root.ToUpperInvariant()), time, "code_change", "Implementation",
                            "Commit patch retrieved from GitHub: " + patch.Path +
                            $" (+{patch.Additions}/-{patch.Deletions}). A link appeared in an approved ChatGPT session; authorship, tests and deployment unknown.",
                            Reference: sha, FilesChanged: 1));
                    }
                    s.ImportedGitHubCommits.Add(key);
                    s.GitHubRetryAfter.Remove(key);
                    CodeTracking.Prune(s, time);
                    return patches.Length;
                });
                state.ImportedGitHubCommits.Add(key);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or
                IOException or JsonException or InvalidOperationException)
            {
                // Rate-limit transient errors; no prompts, patches or URLs go into logs.
                store.Update(s => { s.GitHubRetryAfter[key] = DateTimeOffset.UtcNow.AddMinutes(10); return true; });
            }
        }
        return added;
    }
}
