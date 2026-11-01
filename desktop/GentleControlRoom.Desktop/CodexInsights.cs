using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GentleControlRoom.Desktop;

internal enum CodexPeriod { Today, LastSevenDays, AvailableHistory }
// Identifiers exist only inside the analysis boundary, never in display models.
internal sealed record CodexObservedEvent(string Kind, DateTimeOffset When, string? Session, int Category);
internal sealed record CodexSessionInsight(string Title, string Summary, string Boundaries, string Timeline);

internal static class CodexInsights
{
  internal const int MinimumPatternSessions = 3;
  private static readonly string[] Labels =
    { "Command line", "File editing", "Inspection", "Version control", "Tests / builds", "Other tools" };
  private static readonly string[] Operations =
    { "command-line operations", "file-editing operations", "inspection operations",
      "version-control operations", "test/build tool operations", "other tool operations" };

  internal static bool InPeriod(DateTimeOffset when, DateTimeOffset now, CodexPeriod period) =>
    when <= now && (period == CodexPeriod.AvailableHistory ||
      when.LocalDateTime.Date >= now.LocalDateTime.Date.AddDays(period == CodexPeriod.LastSevenDays ? -6 : 0));

  internal static CodexActivitySnapshot Describe(string state, int projects,
    IReadOnlyList<CodexObservedEvent> records, bool incompleteRead = false)
  {
    var ordered = records.OrderBy(e => e.When).ToArray();
    var tools = ordered.Where(e => e.Kind == "tool_used").ToArray();
    var counts = Enumerable.Range(0, 6).Select(c => tools.Count(e => e.Category == c)).ToArray();
    var groups = ordered.Where(e => e.Session is not null).GroupBy(e => e.Session!, StringComparer.Ordinal)
      .Select(g => g.ToArray()).OrderByDescending(g => g[^1].When).ToArray();
    var patterns = new List<string>();
    AddPattern(patterns, groups.Count(g => ToolPair(g, 2, 1)),
      "inspection tools were followed by file-editing tools", "inspect-then-edit");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 1, 4)),
      "file-editing tools were followed by test/build tools", "edit-then-check");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 0, 0)),
      "command-line tools were used at least twice in succession", "repeated command-line");
    AddPattern(patterns, groups.Count(g => ToolPair(g, 2, 2)),
      "inspection tools were used at least twice in succession", "repeated inspection");
    AddPattern(patterns, groups.Count(g => g.Count(e => e.Kind == "prompt_submitted") >= 3),
      "at least three prompts were submitted", "multiple-prompt");
    if (patterns.Count == 0)
      patterns.Add("There isn't enough recorded evidence to identify recurring workflows. A pattern needs support from at least three separate sessions in this period.");

    var summary = records.Count == 0
      ? "No activity was recorded in this period."
      : $"Recorded {Quantity(tools.Length, "tool operation")} and {Quantity(ordered.Count(e => e.Kind == "prompt_submitted"), "submitted prompt")}. Activity could be linked to {Quantity(groups.Length, "session")}.";
    if (tools.Length > 0 && counts.Max() > tools.Length / 2.0)
      summary += $" Most recorded tool activity involved {Operations[Array.IndexOf(counts, counts.Max())]}.";
    var ungrouped = ordered.Count(e => e.Session is null);
    if (ungrouped > 0) summary += $" {Quantity(ungrouped, "event")} could not be linked to a session.";
    if (state == "Unavailable") summary = "Local activity could not be read. Try refreshing.";
    if (incompleteRead) summary += " Some local files could not be read; these results may be incomplete.";

    return new CodexActivitySnapshot(state, projects, groups.Length, tools.Length, records.Count,
      Labels.Select((label, i) => new CodexToolCount(label, counts[i], Math.Max(1, counts.Max()))).ToArray(),
      ordered.Reverse().Take(5).Select(e => new CodexRecentEvent(EventLabel(e), e.When)).ToArray(),
      summary, groups.Select(DescribeSession).ToArray(), patterns);
  }

  private static void AddPattern(List<string> patterns, int support, string observation, string name)
  {
    if (support >= MinimumPatternSessions)
      patterns.Add($"In {support} separate sessions, {observation}. This may represent a recurring {name} workflow.");
  }

  // Only consecutive tool operations with distinct timestamps support order.
  // Tied timestamps cannot establish which operation happened first.
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
    var categories = Enumerable.Range(0, 6).Select(c => (Count: tools.Count(e => e.Category == c), Category: c))
      .Where(c => c.Count > 0).Select(c => $"{Quantity(c.Count, Operations[c.Category][..^1])}");
    var summary = $"Recorded {Quantity(events.Count(e => e.Kind == "prompt_submitted"), "submitted prompt")} and {Quantity(tools.Length, "tool operation")}" +
      (tools.Length > 0 ? $": {string.Join(", ", categories)}." : ".");
    var boundaries = starts.Length == 1 ? $"Start recorded: {Local(starts[0].When)}." :
      starts.Length == 0 ? "Start not recorded in this period." : "Multiple start records; start is uncertain.";
    boundaries += ends.Length == 1 ? $" End recorded: {Local(ends[0].When)}." :
      ends.Length == 0 ? " End not recorded in this period." : " Multiple end records; end is uncertain.";
    if (starts.Length == 1 && ends.Length == 1 && starts[0].When < ends[0].When &&
        events.All(e => e.When >= starts[0].When && e.When <= ends[0].When))
      boundaries += $" Recorded duration: {(ends[0].When - starts[0].When).TotalMinutes:0.##} minutes.";
    else boundaries += " Duration unavailable.";

    // Limit rendered detail while retaining all events for totals and patterns.
    var moments = events.GroupBy(e => e.When).ToArray();
    var timeline = string.Join("\n", moments.Take(12).Select(g =>
      $"{Local(g.Key)} - {string.Join(", ", g.GroupBy(EventLabel).Select(x => x.Count() == 1 ? x.Key : $"{x.Key} ({x.Count()})"))}" +
      (g.Count() > 1 ? " (same timestamp; order unknown)" : "")));
    if (moments.Length > 12) timeline += $"\n{moments.Length - 12} more recorded timestamps; all events are included in counts.";
    return new CodexSessionInsight($"Session - {Local(events[0].When)}", summary, boundaries, timeline);
  }

  private static string Quantity(int count, string singular) => $"{count} {singular}{(count == 1 ? "" : "s")}";

  private static string Local(DateTimeOffset when) => when.ToLocalTime().ToString("MMM d, yyyy HH:mm:ss zzz", CultureInfo.CurrentCulture);
  private static string EventLabel(CodexObservedEvent e) => e.Kind switch
  {
    "session_started" => "Session started", "session_ended" => "Session ended",
    "prompt_submitted" => "Prompt submitted", "turn_finished" => "Response turn ended",
    _ => Labels[e.Category] + " tool used"
  };
}
