using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO;

namespace GentleControlRoom.Desktop.CodingWork;

internal static class CodeTracking
{
    internal static async Task<string> ApproveAsync(WorkStore store, string path, bool untracked, string[] exclusions)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Private code tracking requires Windows protection.");
        if (!store.Read().LocalEnabled) throw new InvalidOperationException("Enable local analysis first.");
        if (exclusions.Length > 30 || exclusions.Any(x => x.Length is 0 or > 100 || x.Any(char.IsControl))) throw new InvalidOperationException("Use up to 30 short filename exclusion patterns.");
        var root = await RepositoryReader.ValidateRoot(path);
        var repository = new TrackedRepository { Root = root, Identity = RepositoryReader.Identity(root), Approved = true,
            IncludeUntracked = untracked, Exclusions = exclusions, ReceiptKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)) };
        var snapshot = await RepositoryReader.Capture(repository, true);
        return store.Update(s => {
            if (!s.LocalEnabled) throw new InvalidOperationException("Local analysis was disabled.");
            if (s.Repositories.Any(r => r.Approved && (root.StartsWith(r.Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                r.Root.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || root.Equals(r.Root, StringComparison.OrdinalIgnoreCase))))
                throw new InvalidOperationException("This repository overlaps an existing approval. Revoke it before changing approval settings.");
            if (s.Repositories.Count >= 20) throw new InvalidOperationException("Repository approval limit reached.");
            repository.Head = snapshot.Head; repository.Baseline = snapshot.Files; repository.BaselineAt = DateTimeOffset.UtcNow;
            repository.Status = $"Baseline established; {snapshot.Skipped} excluded files. Existing changes are not new observations.";
            if (snapshot.Head != "") repository.SeenCommits.Add(snapshot.Head);
            s.Repositories.Add(repository); return repository.Id;
        });
    }
    internal static async Task<int> PollAsync(WorkStore store)
    {
        var state = store.Read(); if (!state.LocalEnabled) return 0;
        int added = 0;
        foreach (var repo in state.Repositories.Where(r => r.Approved && !r.Paused))
        {
            try
            {
                var before = WorkJson.Hash(WorkJson.Serialize(repo));
                var snapshot = await RepositoryReader.Capture(repo);
                added += store.Update(s => {
                    var current = s.Repositories.FirstOrDefault(r => r.Id == repo.Id);
                    // A revoke/pause/rebaseline during Git IO wins. Never persist a stale scan.
                    if (!s.LocalEnabled || current is null || !current.Approved || current.Paused || WorkJson.Hash(WorkJson.Serialize(current)) != before) return 0;
                    return Apply(s, current, snapshot, DateTimeOffset.UtcNow);
                });
            }
            catch
            {
                store.Update(s => { var r = s.Repositories.FirstOrDefault(x => x.Id == repo.Id);
                    if (r is not null && r.Approved && !r.Paused) r.Status = "Observation unavailable or limit exceeded; baseline retained. Check repository access or exclusions.";
                    return false; });
            }
        }
        return added;
    }
    internal static int Apply(WorkState s, TrackedRepository repo, RepositorySnapshot snapshot, DateTimeOffset now)
    {
        if (!s.LocalEnabled || !repo.Approved || repo.Paused) return 0;
        int added = 0;
        if (!snapshot.Reset)
        {
            foreach (var key in repo.Baseline.Keys.Union(snapshot.Files.Keys).OrderBy(x => x, StringComparer.Ordinal))
            {
                repo.Baseline.TryGetValue(key, out var old); snapshot.Files.TryGetValue(key, out var next);
                if (old == next) continue;
                // A newly excluded file is not reintroduced through its previous patch.
                var name = (next ?? old)!.Path;
                if (!RepositoryReader.SafePath(repo, name)) continue;
                next ??= old! with { Patch = "", Additions = 0, Deletions = 0 };
                Add(s, repo, next, old?.Patch ?? "", now); added++;
            }
            foreach (var commit in snapshot.Commits) { Add(s, repo, commit, "", now); added++; repo.SeenCommits.Add(commit.Reference); }
        }
        repo.Baseline = snapshot.Files; repo.Head = snapshot.Head; repo.BaselineAt = now;
        if (snapshot.Head != "") repo.SeenCommits.Add(snapshot.Head);
        if (repo.SeenCommits.Count > 2000) repo.SeenCommits = repo.SeenCommits.TakeLast(2000).ToHashSet();
        repo.Status = snapshot.Reset ? "HEAD history changed or commit catch-up exceeded 20; baseline reset. No historical changes labelled new." :
            $"Checked {now.ToLocalTime():g}; {added} changed snapshots; {snapshot.Skipped} excluded files. Author and outcomes unknown.";
        Prune(s, now); return added;
    }
    private static void Add(WorkState s, TrackedRepository repo, FileChange file, string previous, DateTimeOffset now)
    {
        var id = Guid.NewGuid().ToString("N");
        s.CodeChanges.Add(new(id, repo.Id, now, file, previous));
        s.Evidence.Add(new(id, "Approved repository", "", WorkJson.Hash(repo.Root.ToUpperInvariant()), now, "code_change", "Implementation",
            $"{file.Layer} change snapshot observed: {file.Additions} added and {file.Deletions} removed lines relative to its Git base. Author, test result and deployment unknown.",
            Reference: file.Reference, FilesChanged: 1));
    }
    internal static void Pause(WorkState s, string id, bool paused)
    {
        var r = s.Repositories.Single(r => r.Id == id); if (!r.Approved) throw new InvalidOperationException("Approve the repository again first.");
        if (!paused && r.BaselineAt < DateTimeOffset.UtcNow.AddDays(-30))
            throw new InvalidOperationException("Baseline expired. Revoke and approve again; historical work must not become a new observation.");
        r.Paused = paused; r.Status = paused ? "Paused; no changes read." : "Resumed; next scan compares against the last baseline (including the paused interval).";
        // Prevent a recorder started before a consent change from being accepted later.
        r.ReceiptKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    }
    internal static void Revoke(WorkState s, string id)
    {
        var r = s.Repositories.Single(r => r.Id == id); r.Approved = false; r.Paused = true; r.ReceiptKey = "";
        r.Baseline.Clear(); r.Status = "Revoked; no repository reads. Retained history remains local until deleted.";
    }
    internal static void DeleteHistory(WorkState s, string id)
    {
        Revoke(s, id);
        var ids = s.CodeChanges.Where(c => c.RepositoryId == id).Select(c => c.Id)
            .Concat(s.Evidence.Where(e => e.FileKey == "code-results:" + id).Select(e => e.Id)).ToHashSet();
        Remove(s, ids); s.Repositories.RemoveAll(r => r.Id == id);
    }
    private static void Remove(WorkState s, HashSet<string> ids)
    {
        s.CodeChanges.RemoveAll(c => ids.Contains(c.Id)); s.Evidence.RemoveAll(e => ids.Contains(e.Id));
        foreach (var id in ids) s.Associations.Remove(id);
        s.AssociationHistory.RemoveAll(a => ids.Contains(a.EvidenceId));
        foreach (var key in s.Analyses.Where(a => a.Value.SourceEvidenceIds?.Any(ids.Contains) == true).Select(a => a.Key).ToArray()) s.Analyses.Remove(key);
        s.Patterns = TaskService.FindPatterns(s);
    }
    internal static void Prune(WorkState s, DateTimeOffset now)
    {
        var ordered = s.CodeChanges.OrderByDescending(c => c.At).ToArray(); int bytes = 0;
        var remove = new HashSet<string>();
        for (int i = 0; i < ordered.Length; i++)
        {
            bytes += Encoding.UTF8.GetByteCount(ordered[i].Current.Patch) + Encoding.UTF8.GetByteCount(ordered[i].PreviousPatch);
            if (i >= 200 || bytes > 8 * 1024 * 1024 || ordered[i].At < now.AddDays(-30)) remove.Add(ordered[i].Id);
        }
        foreach (var e in s.Evidence.Where(e => e.FileKey.StartsWith("code-results:") && e.At < now.AddDays(-30))) remove.Add(e.Id);
        if (remove.Count > 0) Remove(s, remove);
        foreach (var r in s.Repositories.Where(r => r.BaselineAt < now.AddDays(-30)))
        { r.Baseline.Clear(); r.Head = ""; r.Paused = true; r.Status = "Baseline expired after 30 days. Revoke and reapprove to establish a new baseline."; }
    }
    internal static SelectedChange? Selected(WorkState s, Observation e, bool explicitlySelected)
    {
        if (!explicitlySelected || e.Kind != "code_change") return null;
        var c = s.CodeChanges.Single(c => c.Id == e.Id);
        if (!s.Repositories.Any(r => r.Id == c.RepositoryId && r.Approved)) throw new InvalidOperationException("Repository consent was revoked. Code cannot enter an external payload.");
        return new(Privacy.Minimize(c.Current.Path, 1024), c.Current.Layer, Privacy.Minimize(c.Current.Patch, RepositoryReader.MaxPatch),
            Privacy.Minimize(c.PreviousPatch, RepositoryReader.MaxPatch), c.Current.Additions, c.Current.Deletions,
            c.Current.Reference.Length >= 12 ? c.Current.Reference[..12] : "", "Author unknown; session/task links are user-confirmed or inferred, not authorship evidence.",
            "Diffs and commits do not establish successful tests, deployment or task completion. Compare snapshots as recorded, not as independent edits.");
    }
}
