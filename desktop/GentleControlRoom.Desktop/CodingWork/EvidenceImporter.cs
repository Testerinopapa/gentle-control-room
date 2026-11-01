using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace GentleControlRoom.Desktop.CodingWork;

internal static class EvidenceImporter
{
    private static string PrefixDigest(string path, long length)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var bytes = new byte[8192];
        while (length > 0)
        {
            int read = file.Read(bytes, 0, (int)Math.Min(bytes.Length, length));
            if (read == 0) throw new IOException();
            hash.AppendData(bytes, 0, read); length -= read;
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }
    // Allowlist adapter: never copy prompts, commands, paths, tool outputs, or
    // additional fields from legacy records into the normalized evidence store.
    internal static Observation? Normalize(string line, string source, string fileKey, long offset, DateTimeOffset now)
    {
        if (line.Length > 4096) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object || !r.TryGetProperty("schemaVersion", out var v) || !v.TryGetInt32(out var version) || version != 1) return null;
            string Get(string key) => r.TryGetProperty(key, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString()! : "";
            var type = Get("eventType");
            var session = Get("sessionPseudonym");
            if (session.Length is < 1 or > 128 || !DateTimeOffset.TryParse(Get("timestamp"), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var at) || at > now) return null;
            var category = "Unknown";
            var summary = "";
            if (source == "Codex")
            {
                summary = type switch { "session_started" => "Session start recorded", "session_ended" => "Session end recorded",
                    "prompt_submitted" => "Request submitted; content not collected", "turn_finished" => "Response turn ended; outcome unknown",
                    "tool_used" => "Tool invocation recorded; result not collected", _ => "" };
                category = Get("toolCategory") switch { "inspect" => "Investigation", "file_edit" => "Implementation",
                    "test_build" => "Testing", "git" => "Version control", "shell" => "Shell", _ => "Unknown" };
                if (type == "tool_used") summary = category + ": " + summary;
            }
            else if (source == "ChatGPT" && Get("source") == "chatgpt_browser")
            {
                summary = type switch { "session_started" => "Approved browser recording started", "session_ended" => "Browser recording stopped",
                    "visible_counts" => "Visible message counts updated; content not collected", "coding_tag" => "Coding-work tag changed",
                    "workflow_stage" => "Request classified locally; no action or outcome verified", _ => "" };
                category = Get("workflowStage") switch { "investigation" => "Investigation", "implementation" => "Implementation",
                    "debugging" => "Debugging", "testing" => "Testing", "version_control" => "Version control", "deployment" => "Deployment", _ => "Unknown" };
            }
            if (summary == "") return null;
            var basis = source == "ChatGPT" && type == "workflow_stage" ? "INFERRED" : "OBSERVED";
            return new(WorkJson.Hash(source + fileKey + offset + line), source, WorkJson.Hash(source + session),
                source == "Codex" && Get("projectPseudonym") != "" ? WorkJson.Hash(Get("projectPseudonym")) : "",
                at.ToUniversalTime(), "metadata", category, summary, basis, FileKey: fileKey);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException) { return null; }
    }

    public static int Refresh(WorkState state, string activityRoot, DateTimeOffset now)
    {
        if (!state.LocalEnabled) return 0;
        int added = 0;
        var known = state.Evidence.Select(e => e.Id).ToHashSet();
        long remaining = 16 * 1024 * 1024;
        foreach (var (folder, source) in new[] { ("CodexActivity", "Codex"), ("BrowserActivity", "ChatGPT") })
        {
            var root = Path.Combine(activityRoot, folder);
            if (!Directory.Exists(root)) continue;
            foreach (var path in Directory.EnumerateFiles(root, "events-*.jsonl").OrderBy(p => p, StringComparer.Ordinal))
            {
                if (remaining <= 0 || state.Evidence.Count >= 100000) return added;
                var key = WorkJson.Hash(folder + Path.GetFileName(path));
                var info = new FileInfo(path);
                state.Cursors.TryGetValue(key, out var cursor);
                if (cursor is not null && cursor.Digest != "" && cursor.Length == info.Length && cursor.ModifiedTicks == info.LastWriteTimeUtc.Ticks && cursor.Offset == info.Length) continue;
                // Replaced/truncated files are re-normalized. Appends resume at the last complete line.
                var reset = cursor is not null && (info.Length < cursor.Length || cursor.Digest == "" || PrefixDigest(path, cursor.Offset) != cursor.Digest);
                var previous = reset ? state.Evidence.Where(e => e.FileKey == key).ToArray() : Array.Empty<Observation>();
                if (reset) { state.Evidence.RemoveAll(e => e.FileKey == key); foreach (var old in previous) known.Remove(old.Id); }
                var offset = reset ? 0 : cursor?.Offset ?? 0;
                try
                {
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    stream.Seek(offset, SeekOrigin.Begin);
                    var buffer = new List<byte>();
                    var start = offset;
                    bool oversized = false;
                    while (remaining-- > 0 && state.Evidence.Count < 100000)
                    {
                        int next = stream.ReadByte();
                        if (next < 0) break;
                        if (next != 10) { if (buffer.Count < 16384) buffer.Add((byte)next); else oversized = true; continue; }
                        if (!oversized)
                        {
                            var item = Normalize(Encoding.UTF8.GetString(buffer.ToArray()).TrimEnd('\r'), source, key, start, now);
                            if (item is not null && known.Add(item.Id)) { state.Evidence.Add(item); added++; }
                        }
                        buffer.Clear(); oversized = false; offset = stream.Position; start = offset;
                    }
                    state.Cursors[key] = new(offset, info.Length, info.LastWriteTimeUtc.Ticks, PrefixDigest(path, offset));
                    foreach (var old in previous.Where(p => !known.Contains(p.Id))) state.Associations.Remove(old.Id);
                }
                catch (IOException) { throw new InvalidOperationException("Some activity files are busy. Refresh evidence again."); }
                catch (UnauthorizedAccessException) { throw new InvalidOperationException("Some local activity files are unavailable."); }
            }
        }
        return added;
    }
}
