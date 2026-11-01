using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GentleControlRoom.Desktop;

internal enum CodexPeriod { Today, LastSevenDays, AvailableHistory }
// Raw pseudonyms are used only for session grouping; display models never contain them.
internal sealed record CodexObservedEvent(string Kind, DateTimeOffset When, string? Session, int Category);
internal sealed record CodexSessionInsight(string Title, string Summary, string Boundaries, string Timeline);

internal static class CodexInsights
{
  internal const int MinimumPatternSessions = 3;
  private static readonly string[] Labels =
    { "Command line", "File editing", "Inspection", "Version control", "Tests / builds", "Other tools" };
  private static readonly string[] ToolKinds =
    { "command-line", "file-editing", "inspection", "version-control", "test/build", "other" };

  internal static bool InPeriod(DateTimeOffset when, DateTimeOffset now, CodexPeriod period) =>
    when <= now && (period == CodexPeriod.AvailableHistory ||
      when.LocalDateTime.Date >= now.LocalDateTime.Date.AddDays(period == CodexPeriod.LastSevenDays ? -6 : 0));

  internal static CodexActivitySnapshot Describe(string state, int projects,
    IReadOnlyList<CodexObservedEvent> records, bool incompleteRead = false)
  {
    var ordered = records.OrderBy(e => e.When).ToArray();
    var tools = ordered.Where(e => e.Kind == "tool_used").ToArray();
    var counts = Enumerable.Range(0, Labels.Length).Select(c => tools.Count(e => e.Category == c)).ToArray();
    var groups = ordered.Where(e => e.Session is not null)
      .GroupBy(e => e.Session!, StringComparer.Ordinal)
      .Select(g => g.ToArray()).OrderByDescending(g => g[^1].When).ToArray();

    // Each group represents one distinct session, not repeated events in a session.
    var patterns = new List<string>();
    AddPattern(patterns, groups.Count(g => ToolPair(g, 2, 1)),
      "Inspection tools were followed by file-editing tools");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 1, 4)),
      "File-editing tools were followed by test/build tools");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 0, 0)),
      "Command-line tools appeared consecutively");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 2, 2)),
      "Inspection tools appeared consecutively");
    AddPattern(patterns, groups.Count(g => g.Count(e => e.Kind == "prompt_submitted") >= 3),
      "At least three prompt submissions were captured");
    if (patterns.Count == 0)
    {
      patterns.Add("No recurring sequence is established yet. It needs evidence from at least three different sessions.");
    }

    var promptEvents = ordered.Count(e => e.Kind == "prompt_submitted");
    string summary;
    if (records.Count == 0)
    {
      summary = "No Codex activity was recorded in this period.";
    }
    else
    {
      var parts = new List<string>();
      if (tools.Length > 0)
      {
        parts.Add($"Codex used tools {tools.Length} {(tools.Length == 1 ? "time" : "times")}" +
          (groups.Length > 0 ? $" across {Quantity(groups.Length, "identifiable session")}" : "") + ".");
        var most = Array.IndexOf(counts, counts.Max());
        if (counts[most] > tools.Length / 2.0)
        {
          parts.Add($"{CategoryName(most)} tools accounted for {counts[most]} of those uses.");
        }
      }
      else if (groups.Length > 0)
      {
        parts.Add($"Events were recorded in {Quantity(groups.Length, "identifiable session")}, but no tool uses were captured.");
      }
      else
      {
        parts.Add("Some Codex activity was recorded, but it could not be associated with a session.");
      }

      if (promptEvents > 0)
      {
        parts.Add($"{Quantity(promptEvents, "prompt-submission event")} captured.");
      }
      else if (tools.Length > 0)
      {
        parts.Add("No prompt events were captured. This may reflect incomplete hook coverage, not a lack of prompts.");
      }

      var ungrouped = ordered.Count(e => e.Session is null);
      if (ungrouped > 0)
      {
        parts.Add($"{Quantity(ungrouped, "event")} could not be linked to a session.");
      }
      summary = string.Join(" ", parts);
    }

    if (state == "Unavailable")
    {
      summary = "Local activity could not be read. Try refreshing.";
    }
    if (incompleteRead)
    {
      summary += " Some local activity files could not be read, so this summary may be incomplete.";
    }

    return new CodexActivitySnapshot(state, projects, groups.Length, tools.Length, records.Count,
      Labels.Select((label, i) => new CodexToolCount(label, counts[i], Math.Max(1, counts.Max()))).ToArray(),
      ordered.Reverse().Take(5).Select(e => new CodexRecentEvent(EventLabel(e), e.When)).ToArray(),
      summary, groups.Select(DescribeSession).ToArray(), patterns);
  }

  private static void AddPattern(List<string> patterns, int support, string observation)
  {
    if (support >= MinimumPatternSessions)
    {
      patterns.Add($"{observation} in {support} separate sessions.");
    }
  }

  private static string CategoryName(int category) => category switch
  {
    0 => "Command-line",
    1 => "File-editing",
    2 => "Inspection",
    3 => "Version-control",
    4 => "Test/build",
    _ => "Other"
  };

  // Count only adjacent tool-category events with established chronological order.
  // Equal timestamps never prove which operation happened first.
  private static bool ToolPair(CodexObservedEvent[] events, int first, int second)
  {
    var tools = events.Where(e => e.Kind == "tool_used").ToArray();
    var ambiguousTimes = tools.GroupBy(e => e.When).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
    return Enumerable.Range(1, Math.Max(0, tools.Length - 1)).Any(i =>
      tools[i - 1].Category == first && tools[i].Category == second &&
      tools[i - 1].When < tools[i].When && !ambiguousTimes.Contains(tools[i - 1].When) &&
      !ambiguousTimes.Contains(tools[i].When));
  }

  private static CodexSessionInsight DescribeSession(CodexObservedEvent[] events)
  {
    var starts = events.Where(e => e.Kind == "session_started").ToArray();
    var ends = events.Where(e => e.Kind == "session_ended").ToArray();
    var tools = events.Where(e => e.Kind == "tool_used").ToArray();
    var prompts = events.Count(e => e.Kind == "prompt_submitted");
    var categories = Enumerable.Range(0, ToolKinds.Length)
      .Select(i => (Count: tools.Count(e => e.Category == i), Index: i))
      .Where(c => c.Count > 0)
      .OrderByDescending(c => c.Count).ToArray();

    string summary;
    if (tools.Length == 0)
    {
      summary = "No tool use was captured for this session.";
    }
    else
    {
      var details = categories
        .Take(3)
        .Select(c => $"{c.Count} {ToolKinds[c.Index]}")
        .ToList();
      var otherCount = categories.Skip(3).Sum(c => c.Count);
      if (otherCount > 0)
      {
        details.Add($"{otherCount} more");
      }
      summary = $"Codex used tools {tools.Length} {(tools.Length == 1 ? "time" : "times")} ({string.Join(", ", details)}).";
    }
    if (prompts > 0)
    {
      summary += $" {Quantity(prompts, "prompt-submission event")} captured.";
    }

    var boundaries = starts.Length == 1 ? $"Start recorded: {Local(starts[0].When)}." :
      starts.Length == 0 ? "Start not recorded in this period." : "Multiple start records; start is uncertain.";
    boundaries += ends.Length == 1 ? $" End recorded: {Local(ends[0].When)}." :
      ends.Length == 0 ? " End not recorded in this period." : " Multiple end records; end is uncertain.";
    if (starts.Length == 1 && ends.Length == 1 && starts[0].When < ends[0].When &&
        events.All(e => e.When >= starts[0].When && e.When <= ends[0].When))
    {
      boundaries += $" Recorded duration: {(ends[0].When - starts[0].When).TotalMinutes:0.##} minutes.";
    }
    else
    {
      boundaries += " Duration unavailable.";
    }

    // The timeline is abbreviated; totals and pattern checks still use every event.
    var moments = events.GroupBy(e => e.When).ToArray();
    var timeline = string.Join("\n", moments.Take(12).Select(g =>
      $"{Local(g.Key)} - {string.Join(", ", g.GroupBy(EventLabel).Select(x => x.Count() == 1 ? x.Key : $"{x.Key} ({x.Count()})"))}" +
      (g.Count() > 1 ? " (same timestamp; order unknown)" : "")));
    if (moments.Length > 12)
    {
      timeline += $"\n{moments.Length - 12} more recorded timestamps; all events are included in counts.";
    }

    return new CodexSessionInsight($"Session - {Local(events[0].When)}", summary, boundaries, timeline);
  }

  private static string Quantity(int count, string singular) => $"{count} {singular}{(count == 1 ? "" : "s")}";
  private static string Local(DateTimeOffset when) =>
    when.ToLocalTime().ToString("MMM d, yyyy HH:mm:ss zzz", CultureInfo.CurrentCulture);

  private static string EventLabel(CodexObservedEvent e) => e.Kind switch
  {
    "session_started" => "Session started",
    "session_ended" => "Session ended",
    "prompt_submitted" => "Prompt submitted",
    "turn_finished" => "Response turn ended",
    _ => Labels[e.Category] + " tool used"
  };
}
