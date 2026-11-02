namespace GentleControlRoom.Desktop.CodingWork;

internal sealed class TrackedRepository
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Root { get; set; } = "";
    public string Identity { get; set; } = "";
    public bool Approved { get; set; }
    public bool Paused { get; set; }
    public bool IncludeUntracked { get; set; }
    public string[] Exclusions { get; set; } = Array.Empty<string>();
    public string Head { get; set; } = "";
    public string ReceiptKey { get; set; } = "";
    public DateTimeOffset BaselineAt { get; set; }
    public Dictionary<string, FileChange> Baseline { get; set; } = new();
    public HashSet<string> SeenCommits { get; set; } = new();
    public string Status { get; set; } = "Not tracking";
    public override string ToString() => $"{System.IO.Path.GetFileName(Root)} - {(Approved ? Paused ? "Paused" : "Tracking" : "Revoked")}";
}
// Exact local snapshots, not inferred authorship or verification.
internal sealed record FileChange(string Path, string Layer, string Patch, int Additions, int Deletions, string Reference = "");
internal sealed record CodeChange(string Id, string RepositoryId, DateTimeOffset At, FileChange Current,
    string PreviousPatch, bool BaselineReset = false);
internal sealed record SelectedChange(string File, string Layer, string Diff, string PreviousDiff,
    int Additions, int Deletions, string Commit, string Attribution, string Verification);
internal sealed record RepositorySnapshot(string Head, Dictionary<string, FileChange> Files, FileChange[] Commits,
    bool Reset, int Skipped);
