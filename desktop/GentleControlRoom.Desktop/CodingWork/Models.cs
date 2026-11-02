using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GentleControlRoom.Desktop.CodingWork;

internal static class WorkJson
{
    public static readonly JsonSerializerOptions Options = new() { WriteIndented = true, PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}

internal sealed record Observation(string Id, string Source, string SessionKey, string ProjectKey,
    DateTimeOffset At, string Kind, string Category, string Summary, string Basis = "OBSERVED",
    string Outcome = "unknown", string Reference = "", int? FilesChanged = null, string FileKey = "", [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ExitCode = null)
{
    // Source identifiers stay in the local store. UI uses ordinal session names.
    public string Display => $"{At.ToLocalTime():MMM d HH:mm:ss} · {Source} · {Summary} [{Basis}]";
}
internal sealed class CodingTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Objective { get; set; } = "";
    public string Repository { get; set; } = "Unassigned project";
    public string Status { get; set; } = "Active";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public override string ToString() => Objective;
}
internal sealed record FileCursor(long Offset, long Length, long ModifiedTicks, string Digest = "");
internal sealed record AssociationChange(DateTimeOffset At, string EvidenceId, string? FromTask, string? ToTask);
internal sealed record Claim(string Section, string Text, string Basis, double Confidence, string[] EvidenceIds, string Pattern = "none");
internal sealed record TaskAnalysis(string Objective, string Status, Claim[] Claims);
internal sealed record SavedAnalysis(string TaskId, string Fingerprint, string Model, DateTimeOffset At, TaskAnalysis Result, EvidencePackage Package, string[]? SourceEvidenceIds = null);
internal sealed record RecurringPattern(string Title, string[] TaskIds, string[] EvidenceIds, int Frequency,
    string Basis, double Confidence, string Recommendation);
internal sealed class AnalysisSettings
{
    public bool ExternalEnabled { get; set; }
    public string Model { get; set; } = "deepseek-flash";
    public int OutputTokens { get; set; } = 2500;
    public int DailyRequests { get; set; } = 10;
    public int DailyTokenBudget { get; set; } = 100000;
    public int TimeoutSeconds { get; set; } = 45;
    public int Retries { get; set; } = 1;
    public void Validate()
    {
        if (Model is not ("deepseek-flash" or "deepseek-v4-pro") || OutputTokens is < 256 or > 8000 ||
            DailyRequests is < 1 or > 100 || DailyTokenBudget is < 1000 or > 1000000 ||
            TimeoutSeconds is < 5 or > 120 || Retries is < 0 or > 2)
            throw new InvalidOperationException("Choose valid model and budget settings.");
    }
}
internal sealed class WorkState
{
    public int SchemaVersion { get; set; } = 2;
    public List<TrackedRepository> Repositories { get; set; } = new();
    public List<CodeChange> CodeChanges { get; set; } = new();
    public HashSet<string> ImportedGitHubCommits { get; set; } = new(StringComparer.Ordinal);
    public bool LocalEnabled { get; set; }
    public List<Observation> Evidence { get; set; } = new();
    public List<CodingTask> Tasks { get; set; } = new();
    public Dictionary<string, string> Associations { get; set; } = new();
    public List<AssociationChange> AssociationHistory { get; set; } = new();
    public Dictionary<string, FileCursor> Cursors { get; set; } = new();
    public Dictionary<string, SavedAnalysis> Analyses { get; set; } = new();
    public List<RecurringPattern> Patterns { get; set; } = new();
    public AnalysisSettings Settings { get; set; } = new();
    public string BudgetDay { get; set; } = "";
    public int RequestsReserved { get; set; }
    public int TokensReserved { get; set; }
}
internal sealed record PackageEvidence(string Id, string Source, string Session, DateTimeOffset At,
    string Kind, string Category, string Summary, string Basis, string Outcome, string Reference, int? FilesChanged, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SelectedChange? Change = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ExitCode = null);
internal sealed record EvidencePackage(int Version, string Objective, string Repository, string DeclaredStatus,
    PackageEvidence[] Timeline, string[] Limitations);
internal sealed record AnalysisPreview(string TaskId, string Fingerprint, string Payload, string PayloadHash,
    string Model, int OutputTokens, string SettingsHash, DateTimeOffset ExpiresAt);
