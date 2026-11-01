using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace GentleControlRoom.Desktop;

/// <summary>Reads only aggregate Codex activity for the current Windows account.</summary>
internal readonly record struct CodexActivitySnapshot(
  string State, int Projects, int Sessions, int ToolUses,
  int Events, IReadOnlyList<CodexToolCount> Categories, IReadOnlyList<CodexRecentEvent> Recent,
  string Summary, IReadOnlyList<CodexSessionInsight> History, IReadOnlyList<string> Patterns);

internal sealed record CodexToolCount(string Label, int Count, int Maximum);
internal sealed record CodexRecentEvent(string Category, DateTimeOffset Timestamp)
{
  public string TimeLabel => Timestamp.ToLocalTime().ToString("MMM d - HH:mm:ss", CultureInfo.CurrentCulture);
}

internal static class CodexActivityReader
{
  private const string CollectorMarker = "GCR opt-in local collector";
  private const int MaxEventLineLength = 4096;

  public static CodexActivitySnapshot Read(CodexPeriod period = CodexPeriod.Today)
  {
    var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (string.IsNullOrWhiteSpace(localData)) return Empty("Unavailable");
    return ReadFrom(Path.Combine(localData, "GentleControlRoom", "CodexActivity"),
      HooksRegistered(), DateTimeOffset.Now, period);
  }

  // Explicit inputs keep fixture tests isolated from real consent and activity.
  internal static CodexActivitySnapshot ReadFrom(string root, bool hooksPresent, DateTimeOffset now, CodexPeriod period = CodexPeriod.Today)
  {
    // No logging: local consent contains approved paths and a secret.
    try
    {
      var consentFile = Path.Combine(root, "consent.json");
      if (!File.Exists(consentFile))
      {
        return Empty("Off");
      }

      using var consent = JsonDocument.Parse(File.ReadAllText(consentFile));
      var config = consent.RootElement;
      if (config.ValueKind != JsonValueKind.Object ||
          !config.TryGetProperty("paused", out var paused) ||
          (paused.ValueKind != JsonValueKind.True && paused.ValueKind != JsonValueKind.False) ||
          !config.TryGetProperty("projects", out var projects) ||
          projects.ValueKind != JsonValueKind.Array)
      {
        return Empty("Unavailable");
      }

      var projectCount = 0;
      foreach (var project in projects.EnumerateArray())
      {
        if (project.ValueKind == JsonValueKind.Object &&
            ReadString(project, "path") is not null)
        {
          projectCount++;
        }
      }

      var state = !hooksPresent ? "Off - hooks missing" :
        projectCount == 0 ? "Off" :
        paused.GetBoolean() ? "Paused" : "Recording";

      var records = new List<CodexObservedEvent>();
      var incompleteRead = false;

      if (Directory.Exists(root))
      {
        foreach (var file in Directory.EnumerateFiles(root, "events-????????-*.jsonl"))
        {
          try
          {
            foreach (var line in File.ReadLines(file))
            {
              if (line.Length is 0 or > MaxEventLineLength)
              {
                continue;
              }

              try
              {
                using var entry = JsonDocument.Parse(line);
                var item = entry.RootElement;
                if (item.ValueKind != JsonValueKind.Object ||
                    !item.TryGetProperty("schemaVersion", out var version) ||
                    version.ValueKind != JsonValueKind.Number ||
                    !version.TryGetInt32(out var schema) || schema != 1)
                {
                  continue;
                }

                var eventType = ReadString(item, "eventType");
                var label = eventType switch
                {
                  "session_started" => "Session started",
                  "prompt_submitted" => "Prompt submitted",
                  "tool_used" => "Tool used",
                  "turn_finished" => "Turn finished",
                  "session_ended" => "Session ended",
                  _ => null
                };
                var timestamp = ReadString(item, "timestamp");
                if (label is null || timestamp is null ||
                    !DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture,
                      DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                      out var when) || when > now)
                {
                  continue;
                }

                if (!CodexInsights.InPeriod(when, now, period)) continue;
                var session = ReadString(item, "sessionPseudonym");
                if (string.IsNullOrWhiteSpace(session) || session.Length > 64) session = null;
                var category = ReadString(item, "toolCategory") switch
                {
                  "shell" => 0, "file_edit" => 1, "inspect" => 2,
                  "git" => 3, "test_build" => 4, _ => 5
                };
                records.Add(new CodexObservedEvent(eventType!, when, session, category));
              }
              catch (JsonException)
              {
                // Concurrent hook writes can expose a partial final line.
              }
            }
          }
          catch (IOException)
          {
            incompleteRead = true; // File may be rotated, deleted or locked.
          }
          catch (UnauthorizedAccessException)
          {
            incompleteRead = true; // Keep the dashboard usable without claiming complete counts.
          }
        }
      }

      return CodexInsights.Describe(state, projectCount, records, incompleteRead);
    }
    catch (Exception)
    {
      // Fail closed; no local file content or error details leave the reader.
      return Empty("Unavailable");
    }
  }

  private static CodexActivitySnapshot Empty(string state) =>
    CodexInsights.Describe(state, 0, Array.Empty<CodexObservedEvent>());

  private static string? ReadString(JsonElement element, string name)
  {
    if (element.ValueKind != JsonValueKind.Object ||
        !element.TryGetProperty(name, out var property) ||
        property.ValueKind != JsonValueKind.String)
    {
      return null;
    }

    return property.GetString();
  }

  private static bool HooksRegistered()
  {
    try
    {
      var home = Environment.GetEnvironmentVariable("CODEX_HOME");
      if (string.IsNullOrWhiteSpace(home))
      {
        home = Path.Combine(
          Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
      }

      var configPath = Path.Combine(home, "hooks.json");
      if (!File.Exists(configPath))
      {
        return false;
      }

      using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
      return ContainsCollectorMarker(doc.RootElement, 0);
    }
    catch (Exception)
    {
      return false;
    }
  }

  private static bool ContainsCollectorMarker(JsonElement element, int depth)
  {
    if (depth > 12)
    {
      return false;
    }

    if (element.ValueKind == JsonValueKind.Object)
    {
      foreach (var property in element.EnumerateObject())
      {
        if (property.NameEquals("statusMessage") &&
            property.Value.ValueKind == JsonValueKind.String &&
            property.Value.GetString() == CollectorMarker)
        {
          return true;
        }

        if (ContainsCollectorMarker(property.Value, depth + 1))
        {
          return true;
        }
      }
    }
    else if (element.ValueKind == JsonValueKind.Array)
    {
      foreach (var child in element.EnumerateArray())
      {
        if (ContainsCollectorMarker(child, depth + 1))
        {
          return true;
        }
      }
    }

    return false;
  }
}
