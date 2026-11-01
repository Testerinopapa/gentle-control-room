using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace GentleControlRoom.Desktop;

/// <summary>Reads only aggregate Codex activity for the current Windows account.</summary>
internal readonly record struct CodexActivitySnapshot(
  string State, int Projects, int SessionsToday, int ToolUsesToday,
  int EventsToday, string LastActivity);

internal static class CodexActivityReader
{
  private const string CollectorMarker = "GCR opt-in local collector";
  private const int MaxEventLineLength = 4096;

  public static CodexActivitySnapshot Read()
  {
    // No logging: local consent contains approved paths and a secret.
    try
    {
      var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      if (string.IsNullOrWhiteSpace(localData))
      {
        return Empty("Unavailable");
      }

      var root = Path.Combine(localData, "GentleControlRoom", "CodexActivity");
      var hooksPresent = HooksRegistered();
      var consentFile = Path.Combine(root, "consent.json");
      if (!File.Exists(consentFile))
      {
        return Empty(hooksPresent ? "Off" : "Not installed");
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

      var state = !hooksPresent ? "Hooks missing" :
        projectCount == 0 ? "Off" :
        paused.GetBoolean() ? "Paused" : "Recording";

      var today = DateTime.UtcNow.Date;
      var dateTag = today.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
      var events = 0;
      var toolUses = 0;
      var sessions = new HashSet<string>(StringComparer.Ordinal);
      DateTimeOffset? lastTime = null;
      string lastLabel = "No activity recorded today.";

      if (Directory.Exists(root))
      {
        foreach (var file in Directory.EnumerateFiles(root, $"events-{dateTag}-*.jsonl"))
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
                      out var when) || when.UtcDateTime.Date != today)
                {
                  continue;
                }

                events++;
                if (eventType == "session_started")
                {
                  var session = ReadString(item, "sessionPseudonym");
                  if (!string.IsNullOrEmpty(session) && session.Length <= 64)
                  {
                    sessions.Add(session);
                  }
                }

                if (eventType == "tool_used")
                {
                  toolUses++;
                  var category = ReadString(item, "toolCategory");
                  label = category switch
                  {
                    "file_edit" => "File edit tool",
                    "shell" => "Shell tool",
                    "test_build" => "Test/build tool",
                    "inspect" => "Inspection tool",
                    "git" => "Git tool",
                    _ => "Other tool"
                  };
                }

                if (lastTime is null || when > lastTime)
                {
                  lastTime = when;
                  lastLabel = $"{label} · {when:HH:mm:ss} UTC";
                }
              }
              catch (JsonException)
              {
                // Concurrent hook writes can expose a partial final line.
              }
            }
          }
          catch (IOException)
          {
            // File may be rotated, deleted or locked while it is being read.
          }
          catch (UnauthorizedAccessException)
          {
            // Do not crash the Windows app because of the activity store.
          }
        }
      }

      return new CodexActivitySnapshot(state, projectCount, sessions.Count,
        toolUses, events, lastLabel);
    }
    catch (Exception)
    {
      // Fail closed; no local file content or error details leave the reader.
      return Empty("Unavailable");
    }
  }

  private static CodexActivitySnapshot Empty(string state) =>
    new(state, 0, 0, 0, 0, "Local data stays on this Windows account.");

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
