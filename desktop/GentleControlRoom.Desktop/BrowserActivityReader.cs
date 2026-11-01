using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace GentleControlRoom.Desktop;

/// <summary>Reads sanitized, local-only Edge extension events. Never exposes raw records to WebView.</summary>
internal readonly record struct BrowserActivitySnapshot(
  int SessionsToday, int VisibleUser, int VisibleAssistant, int EventsToday, string Latest);

internal static class BrowserActivityReader
{
  internal static BrowserActivitySnapshot Read()
  {
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (string.IsNullOrWhiteSpace(local)) return Empty();
    return ReadFrom(Path.Combine(local, "GentleControlRoom", "BrowserActivity"), DateTimeOffset.UtcNow);
  }

  internal static BrowserActivitySnapshot ReadFrom(string root, DateTimeOffset now)
  {
    try
    {
      if (!Directory.Exists(root)) return Empty();
      var today = now.UtcDateTime.Date;
      var sessions = new HashSet<string>(StringComparer.Ordinal);
      var counts = new Dictionary<string, (DateTimeOffset At, int User, int Assistant)>(StringComparer.Ordinal);
      var events = 0;
      DateTimeOffset? latest = null;
      string latestLabel = "No browser activity recorded today.";

      foreach (var file in Directory.EnumerateFiles(root,
                 $"events-{today:yyyyMMdd}-*.jsonl"))
      {
        try
        {
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
                  GetString(record, "source") != "chatgpt_browser")
              {
                continue;
              }
              var type = GetString(record, "eventType");
              if (type is not ("session_started" or "visible_counts" or "session_ended")) continue;
              var session = GetString(record, "sessionPseudonym");
              if (session is null || !Guid.TryParseExact(session, "D", out _)) continue;
              var textTime = GetString(record, "timestamp");
              if (!DateTimeOffset.TryParse(textTime, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var when) || when.UtcDateTime.Date != today || when > now)
              {
                continue;
              }

              int? user = null;
              int? assistant = null;
              if (type == "visible_counts")
              {
                if (!record.TryGetProperty("visibleUser", out var u) ||
                    !record.TryGetProperty("visibleAssistant", out var a) ||
                    u.ValueKind != JsonValueKind.Number || a.ValueKind != JsonValueKind.Number ||
                    !u.TryGetInt32(out var un) || !a.TryGetInt32(out var an) ||
                    un is < 0 or > 10000 || an is < 0 or > 10000)
                {
                  continue;
                }
                user = un; assistant = an;
                if (!counts.TryGetValue(session, out var previous) || when >= previous.At)
                {
                  counts[session] = (when, un, an);
                }
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
                  _ => "Visible message counts updated"
                };
              }
            }
            catch (JsonException)
            {
              // A concurrent native message may leave a partial final line.
            }
          }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
      }

      var visibleUser = 0;
      var visibleAssistant = 0;
      foreach (var item in counts.Values)
      {
        visibleUser += item.User;
        visibleAssistant += item.Assistant;
      }
      var recentText = latest is null ? latestLabel :
        $"{latestLabel} · {latest.Value.ToLocalTime():MMM d HH:mm:ss}";
      return new BrowserActivitySnapshot(sessions.Count, visibleUser,
        visibleAssistant, events, recentText);
    }
    catch (Exception)
    {
      return Empty();
    }
  }

  private static string? GetString(JsonElement element, string key)
  {
    return element.TryGetProperty(key, out var value) &&
           value.ValueKind == JsonValueKind.String ? value.GetString() : null;
  }

  private static BrowserActivitySnapshot Empty() =>
    new(0, 0, 0, 0, "No opted-in browser activity recorded today.");
}
