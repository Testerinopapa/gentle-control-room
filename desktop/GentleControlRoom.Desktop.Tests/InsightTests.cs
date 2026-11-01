using System.Text.Json;
using GentleControlRoom.Desktop;

internal static class InsightTests
{
  internal static void Run()
  {
    var root = Path.Combine(Path.GetTempPath(), "gcr-insights-" + Guid.NewGuid());
    Directory.CreateDirectory(root);
    var localNoon = new DateTime(2026, 10, 31, 12, 0, 0);
    var now = new DateTimeOffset(localNoon, TimeZoneInfo.Local.GetUtcOffset(localNoon));
    var day = now.AddHours(-12);
    var file = Path.Combine(root, "events-20261031-0.jsonl");
    string E(string kind, DateTimeOffset at, string? session, string category = "inspect") =>
      JsonSerializer.Serialize(new { schemaVersion = 1, eventType = kind, timestamp = at,
        sessionPseudonym = session, toolCategory = category, prompt = "PRIVATE-PROMPT",
        command = "PRIVATE-COMMAND", projectPseudonym = "PRIVATE-PROJECT" });
    void Check(bool condition, string label)
    {
      if (!condition) throw new Exception(label);
      Console.WriteLine("PASS " + label);
    }
    CodexActivitySnapshot Read(CodexPeriod period = CodexPeriod.Today) =>
      CodexActivityReader.ReadFrom(root, true, now, period);
    void Write(IEnumerable<string> lines) => File.WriteAllLines(file, lines);
    string[] Session(int number)
    {
      var t = day.AddHours(number);
      var id = "PRIVATE-SESSION-" + number;
      return new[] { E("session_started", t, id), E("prompt_submitted", t.AddMinutes(1), id),
        E("prompt_submitted", t.AddMinutes(2), id), E("prompt_submitted", t.AddMinutes(3), id),
        E("tool_used", t.AddMinutes(4), id), E("tool_used", t.AddMinutes(5), id, "file_edit"),
        E("tool_used", t.AddMinutes(6), id, "test_build"), E("session_ended", t.AddMinutes(7), id) };
    }
    try
    {
      File.WriteAllText(Path.Combine(root, "consent.json"), "{\"paused\":false,\"projects\":[{\"path\":\"PRIVATE-PATH\"}]}");
      Write(Session(1).Concat(Session(2)).Concat(Session(3)).Reverse());
      var result = Read();
      Check(result.Sessions == 3 && result.Events == 24 && result.ToolUses == 9,
        "grouping and counts across shuffled session records");
      Check(result.History.Count == 3 && result.History.All(h => h.Summary.Contains("3 prompt-submission events captured") && h.Summary.Contains("Codex used tools 3 times")),
        "session explanations match counts");
      Check(result.History.All(h => h.Boundaries.Contains("7 minutes")) &&
        result.History[0].Timeline.IndexOf("Session started") < result.History[0].Timeline.IndexOf("File editing"),
        "chronological timelines and reliable durations");
      Check(result.Patterns.Count == 3 && result.Patterns.All(p => p.Contains("3 separate sessions")),
        "three-session evidence threshold and tentative pattern wording");
      Check(!result.Summary.Contains("No prompt events were captured") &&
        result.Summary.Contains("prompt-submission events captured"),
        "available prompt events do not trigger missing-coverage warning");
      Check(result.History.All(h => h.Summary.Length < 180),
        "session descriptions remain concise even when tool events repeat");
      Check(!JsonSerializer.Serialize(result).Contains("PRIVATE"), "all insight display models exclude private fields and identifiers");
      Write(Session(1).Concat(Session(2)));
      Check(Read().Patterns.Single().Contains("No recurring sequence"), "two supporting sessions do not establish recurrence");
      Write(Enumerable.Range(1, 10).SelectMany(_ => Session(1)));
      Check(Read().Patterns.Single().Contains("No recurring sequence"), "repeated records cannot inflate distinct-session support");
      Check(Read().History.Single().Boundaries.Contains("Duration unavailable"), "ambiguous repeated boundaries suppress duration");
      Write(new[] { E("tool_used", day.AddHours(1), "partial", "shell"), E("prompt_submitted", day.AddHours(2), null) });
      result = Read();
      Check(result.Sessions == 1 && result.Events == 2 && result.History[0].Boundaries.Contains("Start not recorded") &&
        result.History[0].Boundaries.Contains("End not recorded") && result.Summary.Contains("could not be linked"),
        "incomplete and ungrouped events remain honest");
      Check(result.Summary.Contains("Command-line tools accounted for 1 of those uses"), "majority summary uses actual category counts");
      Write(new[] { E("session_started", day.AddMinutes(-1), "cross"), E("session_ended", day.AddMinutes(1), "cross") });
      Check(Read().History[0].Boundaries.Contains("Duration unavailable") &&
        Read(CodexPeriod.AvailableHistory).History[0].Boundaries.Contains("2 minutes"), "filter-clipped session boundaries suppress duration");
      Write(new[] { E("tool_used", day.AddDays(-7), "old"), E("tool_used", day.AddDays(-6), "week"),
        E("tool_used", day.AddSeconds(-1), "yesterday"), E("tool_used", day, "today"),
        E("tool_used", now.AddSeconds(1), "future"), "{broken", E("secret-event", day, "secret") });
      Check(Read().Events == 1 && Read(CodexPeriod.LastSevenDays).Events == 3 && Read(CodexPeriod.AvailableHistory).Events == 4,
        "all period boundaries use local calendar days and exclude future/malformed events");
      Check(Read().Recent.Count == 1 && Read().History.Count == 1 && Read().Categories.Sum(c => c.Count) == 1,
        "recent activity, history, and categories use the same time filter");
      Write(Enumerable.Range(1, 3).SelectMany(i => new[] {
        E("tool_used", day.AddHours(i), "tie" + i), E("tool_used", day.AddHours(i), "tie" + i, "file_edit") }));
      Check(Read().Patterns.Single().Contains("No recurring sequence") && Read().History.All(h => h.Timeline.Contains("order unknown")),
        "equal timestamps cannot establish a work sequence");
      Write(new[] { E("session_started", day.AddHours(2), "bad-order"), E("session_ended", day.AddHours(1), "bad-order") });
      Check(Read().History[0].Boundaries.Contains("Duration unavailable"), "reversed boundaries suppress duration");
      Write(Enumerable.Range(1, 3).SelectMany(i => new[] {
        E("tool_used", day.AddHours(i), "repeat" + i, "shell"),
        E("tool_used", day.AddHours(i).AddMinutes(1), "repeat" + i, "shell"),
        E("tool_used", day.AddHours(i).AddMinutes(2), "repeat" + i),
        E("tool_used", day.AddHours(i).AddMinutes(3), "repeat" + i) }));
      Check(Read().Patterns.Count == 2 && Read().Patterns.All(p => p.Contains("3 separate sessions")), "repeated command-line and inspection workflows");
      Write(new[] { E("tool_used", day, "unknown", "PRIVATE-CATEGORY") });
      Check(Read().History.Single().Summary.Contains("1 other") && !JsonSerializer.Serialize(Read()).Contains("PRIVATE"),
        "unknown categories never enter explanations");
      Check(Read().Summary.Contains("No prompt events were captured") &&
        Read().Summary.Contains("incomplete hook coverage") &&
        !Read().History[0].Summary.Contains("0 prompt"),
        "missing prompt hooks are described as incomplete coverage, not zero prompts given");

      Write(new[] { E("tool_used", day, "long-session", "shell") }
        .Concat(Enumerable.Range(1, 100).Select(i =>
          E("tool_used", day.AddSeconds(i), "long-session", i % 2 == 0 ? "file_edit" : "inspect"))));
      Check(Read().History.Single().Summary.Length < 180 &&
        Read().History.Single().Timeline.Contains("more recorded timestamps"),
        "long recorded histories use short summaries and expandable detail");
      Check(!JsonSerializer.Serialize(Read()).Contains("PRIVATE"),
        "even long session explanations exclude sensitive synthetic payload fields");
      Write(Array.Empty<string>());
      Check(Read().Summary == "No Codex activity was recorded in this period." && Read().History.Count == 0, "empty-period explanation");
    }
    finally { Directory.Delete(root, true); }
  }
}
