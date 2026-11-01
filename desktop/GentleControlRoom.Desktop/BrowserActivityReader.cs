using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace GentleControlRoom.Desktop;

/// <summary>Summarizes opted-in browser metadata. Never reads conversation contents.</summary>
internal readonly record struct BrowserActivitySnapshot(
  int SessionsToday, int VisibleUser, int VisibleAssistant, int EventsToday, string Latest,
  int CodeBlocks, int CodingSessions, IReadOnlyList<string> Patterns);

internal static class BrowserActivityReader
{
  // Bound each refresh while preferring the newest local files.
  private const long MaxBytesPerRefresh = 64L * 1024 * 1024;

  internal static BrowserActivitySnapshot Read(CodexPeriod period = CodexPeriod.Today)
  {
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (string.IsNullOrWhiteSpace(local)) return Empty();
    return ReadFrom(Path.Combine(local, "GentleControlRoom", "BrowserActivity"),
      DateTimeOffset.Now, period);
  }

  internal static BrowserActivitySnapshot ReadFrom(
    string root, DateTimeOffset now, CodexPeriod period = CodexPeriod.Today)
  {
    try
    {
      if (!Directory.Exists(root)) return Empty();
      var sessions = new HashSet<string>(StringComparer.Ordinal);
      var counts = new Dictionary<string,
        (DateTimeOffset At, int User, int Assistant, int? CodeBlocks)>(StringComparer.Ordinal);
      var tags = new Dictionary<string, (DateTimeOffset At, bool Marked)>(StringComparer.Ordinal);
      var events = 0;
      DateTimeOffset? latest = null;
      string latestLabel = "No browser activity recorded in this period.";
      long scanned = 0;

      foreach (var file in Directory.EnumerateFiles(root, "events-????????-???.jsonl")
                 .OrderByDescending(filePath => Path.GetFileName(filePath), StringComparer.Ordinal))
      {
        try
        {
          var length = new FileInfo(file).Length;
          if (length > MaxBytesPerRefresh - scanned) break;
          scanned += length;
          foreach (var line in File.ReadLines(file))
          {
            if (line.Length is 0 or > 4096) continue;
            try
            {
              using var doc = JsonDocument.Parse(line);
              var record = doc.RootElement;
              if (record.ValueKind != JsonValueKind.Object ||
                  !record.TryGetProperty("schemaVersion", out var version) ||
                  version.ValueKind != JsonValueKind.Number ||
                  !version.TryGetInt32(out var schema) || schema != 1 ||
                  GetString(record, "source") != "chatgpt_browser") continue;

              var type = GetString(record, "eventType");
              if (type is not ("session_started" or "visible_counts" or "session_ended" or "coding_tag"))
                continue;
              var session = GetString(record, "sessionPseudonym");
              if (session is null || !Guid.TryParseExact(session, "D", out _)) continue;

              var textTime = GetString(record, "timestamp");
              if (!DateTimeOffset.TryParse(textTime, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var when) ||
                  !CodexInsights.InPeriod(when, now, period)) continue;

              int user = 0, assistant = 0;
              int? codeBlocks = null;
              bool? marked = null;
              if (type == "visible_counts")
              {
                if (!TryCount(record, "visibleUser", out user) ||
                    !TryCount(record, "visibleAssistant", out assistant)) continue;
                if (record.TryGetProperty("visibleCodeBlocks", out var c) &&
                    c.ValueKind != JsonValueKind.Null)
                {
                  if (!TryCount(record, "visibleCodeBlocks", out var n)) continue;
                  codeBlocks = n;
                }
                if (!counts.TryGetValue(session, out var previous) || when >= previous.At)
                  counts[session] = (when, user, assistant, codeBlocks);
              }
              if (type == "coding_tag")
              {
                if (!record.TryGetProperty("codingMarked", out var tag) ||
                    tag.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) continue;
                marked = tag.GetBoolean();
                if (!tags.TryGetValue(session, out var previous) || when >= previous.At)
                  tags[session] = (when, marked.Value);
              }

              events++;
              if (type == "session_started") sessions.Add(session);
              if (latest is null || when >= latest)
              {
                latest = when;
                latestLabel = type switch
                {
                  "session_started" => "Conversation tracking started",
                  "session_ended" => "Conversation tracking stopped",
                  "coding_tag" => marked == true ? "Coding session marked" : "Coding session unmarked",
                  _ => "Visible message counts updated"
                };
              }
            }
            catch (JsonException)
            {
              // Ignore malformed and partially written event lines.
            }
          }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
      }

      var visibleUser = counts.Values.Sum(v => v.User);
      var visibleAssistant = counts.Values.Sum(v => v.Assistant);
      var codeBlocksTotal = counts.Values.Sum(v => v.CodeBlocks ?? 0);
      var withCode = counts.Where(pair => pair.Value.CodeBlocks > 0)
        .Select(pair => pair.Key).ToHashSet(StringComparer.Ordinal);
      var markedSessions = tags.Where(pair => pair.Value.Marked)
        .Select(pair => pair.Key).ToHashSet(StringComparer.Ordinal);
      var codingSessions = new HashSet<string>(withCode, StringComparer.Ordinal);
      codingSessions.UnionWith(markedSessions);

      var patterns = new List<string>();
      if (withCode.Count >= CodexInsights.MinimumPatternSessions)
        patterns.Add($"ChatGPT displayed code examples in {withCode.Count} separate opted-in browser sessions. Displayed code does not confirm repository edits.");
      if (markedSessions.Count >= CodexInsights.MinimumPatternSessions)
        patterns.Add($"You marked {markedSessions.Count} separate ChatGPT browser sessions as coding work.");

      var recentText = latest is null ? latestLabel :
        $"{latestLabel} · {latest.Value.ToLocalTime():MMM d HH:mm:ss}";
      return new BrowserActivitySnapshot(sessions.Count, visibleUser, visibleAssistant,
        events, recentText, codeBlocksTotal, codingSessions.Count, patterns);
    }
    catch (Exception)
    {
      return Empty();
    }
  }

  private static bool TryCount(JsonElement element, string property, out int result)
  {
    result = 0;
    return element.TryGetProperty(property, out var value) &&
      value.ValueKind == JsonValueKind.Number &&
      value.TryGetInt32(out result) && result is >= 0 and <= 10000;
  }

  private static string? GetString(JsonElement element, string key)
  {
    return element.TryGetProperty(key, out var value) &&
           value.ValueKind == JsonValueKind.String ? value.GetString() : null;
  }

  private static BrowserActivitySnapshot Empty() =>
    new(0, 0, 0, 0, "No opted-in browser activity recorded in this period.",
      0, 0, Array.Empty<string>());
}
