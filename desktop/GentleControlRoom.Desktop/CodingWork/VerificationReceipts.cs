using System.IO;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace GentleControlRoom.Desktop.CodingWork;

internal sealed record ProcessReceipt(string RepositoryId, DateTimeOffset StartedAt, DateTimeOffset FinishedAt,
    string Kind, int ExitCode, string HeadBefore, string HeadAfter);
internal sealed record SignedReceipt(string Payload, string Signature);
internal static class VerificationReceipts
{
    internal static Observation? Accept(WorkState s, string json, DateTimeOffset now)
    {
        if (!s.LocalEnabled || json.Length > 8192) return null;
        try
        {
            var envelope = JsonSerializer.Deserialize<SignedReceipt>(json, WorkJson.Options)!;
            var receipt = JsonSerializer.Deserialize<ProcessReceipt>(envelope.Payload, WorkJson.Options)!;
            var repo = s.Repositories.SingleOrDefault(r => r.Id == receipt.RepositoryId && r.Approved && !r.Paused);
            if (repo is null || repo.ReceiptKey == "" || receipt.Kind is not ("test" or "build") ||
                receipt.StartedAt > receipt.FinishedAt || receipt.FinishedAt > now.AddSeconds(5) || receipt.StartedAt < now.AddDays(-30)) return null;
            var signature = HMACSHA256.HashData(Convert.FromBase64String(repo.ReceiptKey), Encoding.UTF8.GetBytes(envelope.Payload));
            if (!CryptographicOperations.FixedTimeEquals(signature, Convert.FromHexString(envelope.Signature))) return null;
            var id = WorkJson.Hash("code-result:" + envelope.Payload + envelope.Signature);
            if (s.Evidence.Any(e => e.Id == id)) return null;
            var outcome = receipt.ExitCode == 0 ? "passed" : "failed";
            var result = new Observation(id, "User-invoked process recorder", "", WorkJson.Hash(repo.Root.ToUpperInvariant()), receipt.FinishedAt,
                "test_result", receipt.Kind == "test" ? "Testing" : "Build",
                $"A user-designated {receipt.Kind} process exited with status {receipt.ExitCode} ({outcome}). Command meaning, coverage, implementation authorship and task completion are not verified.",
                Outcome: outcome, FileKey: "code-results:" + repo.Id, ExitCode: receipt.ExitCode);
            s.Evidence.Add(result); return result;
        }
        catch (Exception e) when (e is JsonException or FormatException or ArgumentException or InvalidOperationException or NullReferenceException) { return null; }
    }
    internal static void Delete(string root, string repositoryId)
    {
        if (!Directory.Exists(root)) return;
        RepositoryReader.NoLinks(root);
        foreach (var file in Directory.EnumerateFiles(root, "*.json"))
        {
            RepositoryReader.NoLinks(file); if (new FileInfo(file).Length > 8192) continue;
            try
            {
                var signed = JsonSerializer.Deserialize<SignedReceipt>(File.ReadAllText(file), WorkJson.Options)!;
                var receipt = JsonSerializer.Deserialize<ProcessReceipt>(signed.Payload, WorkJson.Options)!;
                if (receipt.RepositoryId == repositoryId) File.Delete(file);
            }
            catch (JsonException) { }
        }
    }
    internal static int Import(WorkState s, string root)
    {
        if (!s.LocalEnabled || !Directory.Exists(root)) return 0;
        RepositoryReader.NoLinks(root); int added = 0;
        foreach (var file in Directory.EnumerateFiles(root, "*.json").OrderByDescending(File.GetLastWriteTimeUtc).Take(100))
        {
            RepositoryReader.NoLinks(file); if (new FileInfo(file).Length > 8192) continue;
            if (Accept(s, File.ReadAllText(file), DateTimeOffset.UtcNow) is not null) added++;
        }
        var old = s.Evidence.Where(e => e.FileKey.StartsWith("code-results:")).OrderByDescending(e => e.At).Skip(200).ToArray();
        // Prune via the common retention path, including associated analysis snapshots.
        foreach (var e in old) s.Evidence[s.Evidence.IndexOf(e)] = e with { At = DateTimeOffset.MinValue };
        CodeTracking.Prune(s, DateTimeOffset.UtcNow); return added;
    }
}
