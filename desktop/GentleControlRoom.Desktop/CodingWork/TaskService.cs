using System.Text.RegularExpressions;

namespace GentleControlRoom.Desktop.CodingWork;

internal static class Privacy
{
    // Defense in depth, not a replacement for the mandatory human payload review.
    public static string Minimize(string text, int limit = 4000)
    {
        if (text.Length > limit) throw new InvalidOperationException("Text is too long. Add a shorter, focused summary.");
        text = Regex.Replace(text, @"-----BEGIN[\s\S]*?-----END[^\r\n]*", "[private key removed]", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"(?im)^.*(?:password|passwd|secret|authorization|bearer|api[_ -]?key|cookie|access[_ -]?token|refresh[_ -]?token|connection[_ -]?string)\s*[:= ].*$", "[credential line removed]");
        text = Regex.Replace(text, @"(?i)\b(?:sk-|ghp_|github_pat_|gho_|xox[baprs]-)[a-z0-9_-]+", "[token removed]");
        text = Regex.Replace(text, @"\b[A-Za-z0-9_+/=-]{32,}\b", "[opaque value removed]");
        text = Regex.Replace(text, @"(?i)(?:[a-z]:[\\/]|\\\\|/(?:home|Users|tmp|var)/)[^\s""<>]+", "[local path removed]");
        text = Regex.Replace(text, @"https?://[^\s<>""]+", "[link removed]");
        text = Regex.Replace(text, @"\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b", "[identifier removed]");
        text = Regex.Replace(text, @"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email removed]");
        return text.Trim();
    }
}

internal static class TaskService
{
    public static CodingTask Create(WorkState s, string objective, string repository)
    {
        objective = Privacy.Minimize(objective, 240);
        if (string.IsNullOrWhiteSpace(objective)) throw new InvalidOperationException("Describe the coding objective first.");
        var task = new CodingTask { Objective = objective, Repository = string.IsNullOrWhiteSpace(repository) ? "Unassigned project" : Privacy.Minimize(repository, 160) };
        s.Tasks.Add(task);
        AddContext(s, task.Id, "Objective: " + objective, "Planning");
        return task;
    }
    public static void Edit(WorkState s, string id, string objective, string repository, string status)
    {
        var t = s.Tasks.Single(t => t.Id == id);
        if (status is not ("Active" or "Completed" or "Unresolved" or "Abandoned")) throw new InvalidOperationException("Invalid task status.");
        var clean = Privacy.Minimize(objective, 240);
        if (clean.Length == 0) throw new InvalidOperationException("An objective is required.");
        var project = Privacy.Minimize(repository, 160);
        if (t.Objective != clean || t.Repository != project || t.Status != status)
            AddContext(s, id, $"Task revised: {t.Objective} ({t.Repository}, {t.Status}) → {clean} ({project}, {status}). Status is user declared.", "Revision");
        t.Objective = clean; t.Repository = project; t.Status = status;
    }
    public static Observation AddContext(WorkState s, string taskId, string text, string category = "Context")
    {
        if (!s.Tasks.Any(t => t.Id == taskId)) throw new InvalidOperationException("Choose a task.");
        if (!new[] { "Context", "Investigation", "Planning", "Implementation", "Debugging", "Testing", "Revision", "Verification", "Completion", "Blocker", "Decision" }.Contains(category))
            throw new InvalidOperationException("Invalid context category.");
        var clean = Privacy.Minimize(text);
        if (clean.Length == 0) throw new InvalidOperationException("Add a focused summary or selected excerpt.");
        var e = new Observation(Guid.NewGuid().ToString("N"), "User context", "", "", DateTimeOffset.UtcNow,
            "user_context", category, clean, "UNVERIFIED");
        s.Evidence.Add(e); Associate(s, new[] { e.Id }, taskId); return e;
    }
    public static void Associate(WorkState s, IEnumerable<string> ids, string? taskId)
    {
        if (taskId is not null && !s.Tasks.Any(t => t.Id == taskId)) throw new InvalidOperationException("Task not found.");
        foreach (var id in ids.Distinct())
        {
            if (!s.Evidence.Any(e => e.Id == id)) throw new InvalidOperationException("Evidence no longer exists.");
            s.Associations.TryGetValue(id, out var old);
            if (old == taskId) continue;
            s.AssociationHistory.Add(new(DateTimeOffset.UtcNow, id, old, taskId));
            if (taskId is null) s.Associations.Remove(id); else s.Associations[id] = taskId;
        }
        if (s.AssociationHistory.Count > 5000) s.AssociationHistory.RemoveRange(0, s.AssociationHistory.Count - 5000);
        s.Patterns = FindPatterns(s);
    }
    // Suggestions only: a session may contain several tasks. Neither proximity
    // nor a shared repository automatically assigns evidence to a task.
    public static string[] Suggest(WorkState s, Observation evidence) => s.Evidence
        .Where(e => e.Id != evidence.Id && s.Associations.ContainsKey(e.Id) &&
            ((e.SessionKey != "" && e.SessionKey == evidence.SessionKey) ||
             (e.ProjectKey != "" && e.ProjectKey == evidence.ProjectKey)))
        .Select(e => s.Associations[e.Id]).Distinct().ToArray();
    public static Observation[] Timeline(WorkState s, string id) => s.Evidence
        .Where(e => s.Associations.GetValueOrDefault(e.Id) == id).OrderBy(e => e.At).ThenBy(e => e.Id, StringComparer.Ordinal).ToArray();
    public static string Fingerprint(WorkState s, string id)
    {
        var t = s.Tasks.Single(t => t.Id == id);
        var timeline = Timeline(s, id);
        var ids = timeline.Select(e => e.Id).ToHashSet();
        var changes = s.CodeChanges.Where(c => ids.Contains(c.Id)).ToArray();
        // Preserve metadata-only fingerprints across the additive migration.
        if (changes.Length == 0) return WorkJson.Hash(WorkJson.Serialize(new { t.Objective, t.Repository, t.Status, Evidence = timeline }));
        var repos = changes.Select(c => c.RepositoryId).ToHashSet();
        return WorkJson.Hash(WorkJson.Serialize(new { t.Objective, t.Repository, t.Status, Evidence = timeline, Changes = changes,
            CodeConsent = s.Repositories.Where(r => repos.Contains(r.Id)).Select(r => new { r.Id, r.Approved, Epoch = WorkJson.Hash(r.ReceiptKey) }).ToArray() }));
    }
    public static bool IsCurrent(WorkState s, CodingTask t) => s.Analyses.TryGetValue(t.Id, out var a) && a.Fingerprint == Fingerprint(s, t.Id) && a.Model == s.Settings.Model;
    public static EvidencePackage Package(WorkState s, string id, IEnumerable<string>? selected = null)
    {
        var task = s.Tasks.Single(t => t.Id == id);
        var all = Timeline(s, id);
        var chosen = selected?.ToHashSet();
        var evidence = chosen is null ? all : all.Where(e => chosen.Contains(e.Id)).ToArray();
        if (evidence.Length is 0 or > 400) throw new InvalidOperationException("Select between 1 and 400 relevant observations for this task.");
        var sessions = all.Where(e => e.SessionKey != "").Select(e => e.SessionKey).Distinct().Select((key, i) => (key, name: $"Session {i + 1}")).ToDictionary(x => x.key, x => x.name);
        var records = evidence.Select(e => new PackageEvidence(e.Id, e.Source,
            sessions.GetValueOrDefault(e.SessionKey, "Added context"), e.At, e.Kind, e.Category,
            Privacy.Minimize(e.Summary), e.Basis, e.Outcome,
            e.Kind == "git_commit" && Regex.IsMatch(e.Reference, "^[0-9a-f]{40,64}$") ? e.Reference[..12] : "", e.FilesChanged, CodeTracking.Selected(s, e, chosen?.Contains(e.Id) == true), e.ExitCode)).ToArray();
        // Local hashes are replaced by package-local references. Model output is
        // bound to this exact package rather than exposing source identifiers.
        records = records.Select((e, i) => e with { Id = $"E{i + 1}" }).ToArray();
        return new(1, Privacy.Minimize(task.Objective), Privacy.Minimize(task.Repository), task.Status + " (user declared)", records,
            new[] { "Legacy metadata contains no code or results. Only explicit Change fields contain selected minimized diffs. Process exit records cover only user-designated commands, not task completion.",
                "Tool categories indicate invocation, not success. Browser stages classify requests, not actions. User context is an unverified report.",
                "Observations with equal timestamps have no established relative order; display ordering is not proof of a sequence.",
                "Local commits prove recorded changes, not deployment, remote synchronization or tests. Missing evidence is not proof an activity did not happen.",
                $"This package includes {evidence.Length} of {all.Length} assigned observations. Session labels are local aliases, not conversation identifiers." });
    }
    public static List<RecurringPattern> FindPatterns(WorkState s)
    {
        var result = new List<RecurringPattern>();
        var loops = new List<(string Task, string[] Evidence)>();
        var unverified = new List<(string Task, string[] Evidence)>();
        foreach (var t in s.Tasks)
        {
            var es = Timeline(s, t.Id);
            var work = es.Where(e => e.Source == "Codex" && e.Kind == "metadata" && e.Category is "Implementation" or "Testing")
                .GroupBy(e => e.At).Where(group => group.Count() == 1).Select(group => group.Single()).ToArray();
            int changes = 0;
            for (int i = 1; i < work.Length; i++) if (work[i].Category != work[i - 1].Category) changes++;
            if (changes >= 3) loops.Add((t.Id, work.Select(e => e.Id).ToArray()));
            if (t.Status == "Completed" && es.Length > 0 && !es.Any(e => e.Kind == "verification" && e.Basis == "OBSERVED" && e.Outcome == "passed"))
                unverified.Add((t.Id, es.Select(e => e.Id).ToArray()));
            var debugging = es.Where(e => e.Category == "Debugging").ToArray();
            if (debugging.Length >= 3) result.Add(new("Repeated debugging signals within one task", new[] { t.Id }, debugging.Select(e => e.Id).ToArray(), debugging.Length,
                "INFERRED", .55, "Review the recorded attempts together and document what changed; these signals do not establish failures or root cause."));
        }
        if (loops.Count >= 2) result.Add(new("Repeated edit/test invocation loops", loops.Select(x => x.Task).ToArray(), loops.SelectMany(x => x.Evidence).ToArray(), loops.Count,
            "OBSERVED", .9, "Consider a reusable edit/test checklist for these tasks. Invocation order alone cannot establish unnecessary repetition or test failures."));
        if (unverified.Count >= 2) result.Add(new("Completion declared without captured verification", unverified.Select(x => x.Task).ToArray(), unverified.SelectMany(x => x.Evidence).ToArray(), unverified.Count,
            "OBSERVED", 1, "Record verification evidence before closing future tasks. This is an evidence gap, not proof that testing was skipped."));
        // Semantic signals come from validated whole-task analyses, never prompt
        // keywords. Outdated analyses cannot establish current recurrence.
        var signals = s.Tasks.Where(t => IsCurrent(s, t)).SelectMany(t => s.Analyses[t.Id].Result.Claims
            .Where(c => c.Pattern != "none" && c.Basis != "UNVERIFIED")
            .Select(c => (Task: t.Id, Claim: c)));
        foreach (var group in signals.GroupBy(x => x.Claim.Pattern))
        {
            var tasks = group.Select(x => x.Task).Distinct().ToArray();
            if (tasks.Length < 2) continue;
            var title = group.Key switch {
                "configuration_failure" => "Configuration problems across tasks", "authentication_blocker" => "Authentication blockers across tasks",
                "repeated_revision" => "Repeated changes of approach", "failed_verification" => "Verification difficulties across tasks",
                _ => "Potentially reusable successful routines"
            };
            result.Add(new(title, tasks, group.SelectMany(x => x.Claim.EvidenceIds.Select(e => x.Task + "/" + e)).Distinct().ToArray(), tasks.Length,
                "INFERRED", Math.Min(.8, group.Min(x => x.Claim.Confidence)),
                "Compare the cited task analyses before adopting a shared checklist or Codex skill. This is an AI-inferred recurring theme; no workflow or skill has been created or executed."));
        }
        return result;
    }
    public static string PatternEvidence(WorkState state, string id)
    {
        var direct = state.Evidence.FirstOrDefault(e => e.Id == id);
        if (direct is not null) return direct.Display;
        var pair = id.Split('/');
        if (pair.Length == 2 && state.Analyses.TryGetValue(pair[0], out var a))
        {
            var e = a.Package.Timeline.FirstOrDefault(e => e.Id == pair[1]);
            if (e is not null) return $"{a.Package.Objective}: {e.Id} · {e.Source} · {e.At:g} · {e.Summary}";
        }
        return "Supporting evidence is no longer available.";
    }
}
