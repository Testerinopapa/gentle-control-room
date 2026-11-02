using System.Text.Json;
using GentleControlRoom.Desktop;

var root = Path.Combine(Path.GetTempPath(), "gcr-reader-tests-" + Guid.NewGuid());
Directory.CreateDirectory(root);
var now = DateTimeOffset.Now;
void Check(bool condition, string label)
{
  if (!condition) throw new Exception(label);
  Console.WriteLine("PASS " + label);
}
void Consent(bool paused = false) => File.WriteAllText(Path.Combine(root, "consent.json"),
  JsonSerializer.Serialize(new { paused, projects = new[] { new { path = "PRIVATE-PATH" } }, secret = "PRIVATE-SECRET" }));
string Event(string type, DateTimeOffset when, string category = "shell", string session = "PRIVATE-ID") =>
  JsonSerializer.Serialize(new { schemaVersion = 1, eventType = type, timestamp = when,
    toolCategory = category, sessionPseudonym = session, prompt = "PRIVATE-PROMPT" });
try
{
  Check(CodexActivityReader.ReadFrom(root, false, now).State == "Off", "missing consent is off");
  Consent();
  var empty = CodexActivityReader.ReadFrom(root, true, now);
  Check(empty.State == "Recording" && empty.Events == 0 && empty.Recent.Count == 0,
    "recording does not imply recent events");
  var file = Path.Combine(root, "events-20000101-0.jsonl");
  var today = new DateTimeOffset(now.LocalDateTime.Date, TimeZoneInfo.Local.GetUtcOffset(now.LocalDateTime.Date));
  File.WriteAllLines(file, new[] {
    Event("session_started", today), Event("session_started", today),
    Event("tool_used", today, "shell"), Event("tool_used", today, "file_edit"),
    Event("tool_used", today, "inspect"), Event("tool_used", today, "git"),
    Event("tool_used", today, "test_build"), Event("tool_used", today, "PRIVATE-UNKNOWN"),
    Event("tool_used", today.AddSeconds(-1)), Event("unknown", today),
    Event("tool_used", now.AddDays(1)), "{partial" });
  var result = CodexActivityReader.ReadFrom(root, true, now);
  Check(result.Sessions == 1 && result.ToolUses == 6 && result.Events == 8,
    "local day, session deduplication, malformed and future records");
  Check(result.Categories.All(c => c.Count == 1), "all six categories, unknown tools map to Other");
  Check(result.Recent.Count == 5 && result.Recent.SequenceEqual(result.Recent.OrderByDescending(e => e.Timestamp)),
    "five newest events ordered by timestamp");
  Check(!JsonSerializer.Serialize(result).Contains("PRIVATE"), "snapshot contains only allowlisted display data");
  Consent(true);
  Check(CodexActivityReader.ReadFrom(root, true, now).State == "Paused", "paused collector keeps history");
  File.AppendAllText(file, "\n" + Event("turn_finished", now));
  var updated = CodexActivityReader.ReadFrom(root, true, now);
  Check(updated.Events == 9 && updated.Recent[0].Category == "Response turn ended", "refresh sees appended event");
  Check(CodexActivityReader.ReadFrom(root, false, now).State.StartsWith("Off"), "missing hooks cannot report recording");
  File.WriteAllText(Path.Combine(root, "consent.json"), "{}");
  Check(CodexActivityReader.ReadFrom(root, true, now).State == "Unavailable", "malformed consent fails closed");
}
finally { Directory.Delete(root, true); }

// Native layout regression: one scrolling workspace, unconstrained history rows,
// and no nested scrollbar that can clip session descriptions.
var xaml = System.Xml.Linq.XDocument.Load(
  Path.Combine(AppContext.BaseDirectory, "MainWindow.xaml"));
var nodes = xaml.Descendants().ToArray();
Check(nodes.Count(e => e.Name.LocalName == "ScrollViewer") == 1,
  "one primary scrollbar for the entire native workspace");
var codexHistoryNode = nodes.Single(e => e.Name.LocalName == "ItemsControl" &&
  (string?)e.Attributes().FirstOrDefault(a => a.Name.LocalName == "Name") == "CodexHistory");
Check(codexHistoryNode.Ancestors().Count(e => e.Name.LocalName == "ScrollViewer") == 1,
  "session history uses only the outer workspace scroller");
var browserHistoryNode = nodes.Single(e => e.Name.LocalName == "ItemsControl" &&
  (string?)e.Attributes().FirstOrDefault(a => a.Name.LocalName == "Name") == "BrowserHistory");
Check(browserHistoryNode.Ancestors().Count(e => e.Name.LocalName == "ScrollViewer") == 1,
  "ChatGPT session history shares the single scrolling dashboard");
Check(nodes.Any(e => e.Name.LocalName == "TextBlock" &&
  e.Attributes().Any(a => a.Name.LocalName == "Name" && a.Value == "SessionBreakdownText")),
  "combined session total has an explicit native text label");
Check(nodes.Any(e => e.Name.LocalName == "TextBlock" &&
  (string?)e.Attribute("Text") == "Codex session history"),
  "Codex-specific history is clearly distinguished from browser history");
Check(!nodes.Any(e => e.Name.LocalName == "ScrollViewer" &&
  (string?)e.Attribute("MaxHeight") == "300"),
  "session history has no nested capped-height scrolling container");
Check(nodes.Any(e => e.Name.LocalName == "Grid" &&
  (string?)e.Attributes().FirstOrDefault(a => a.Name.LocalName == "Name") == "Workspace"),
  "constrained Grid controls layout width");
Check(nodes.Any(e => e.Name.LocalName == "Expander" &&
  (string?)e.Attribute("Header") == "Codex detailed statistics"),
  "secondary statistics are available without duplicating the summary");


var browserRoot = Path.Combine(Path.GetTempPath(), "gcr-browser-reader-" + Guid.NewGuid());
Directory.CreateDirectory(browserRoot);
try
{
  var day = DateTime.UtcNow.Date;
  var testNow = new DateTimeOffset(day.AddHours(20), TimeSpan.Zero);
  var morning = new DateTimeOffset(day.AddHours(12), TimeSpan.Zero);
  var first = "123e4567-e89b-42d3-a456-426614174000";
  var second = "123e4567-e89b-42d3-a456-426614174001";
  string BrowserEvent(string type, string session, DateTimeOffset when, int? user = null, int? assistant = null,
    string source = "chatgpt_browser") => JsonSerializer.Serialize(new {
      schemaVersion = 1, source, timestamp = when, eventType = type,
      sessionPseudonym = session, visibleUser = user, visibleAssistant = assistant, secret = "NEVER-EXPOSE" });
  var browserFile = Path.Combine(browserRoot, $"events-{day:yyyyMMdd}-000.jsonl");
  File.WriteAllLines(browserFile, new[] {
    BrowserEvent("session_started", first, morning),
    BrowserEvent("visible_counts", first, morning.AddSeconds(1), 2, 3),
    BrowserEvent("visible_counts", first, morning.AddSeconds(2), 3, 5),
    BrowserEvent("session_started", second, morning.AddSeconds(3)),
    BrowserEvent("visible_counts", second, morning.AddSeconds(4), 1, 1),
    BrowserEvent("session_ended", first, morning.AddSeconds(5)),
    BrowserEvent("visible_counts", second, morning.AddSeconds(6), 900, 900, "unknown_source"),
    BrowserEvent("visible_counts", first, morning.AddDays(-1), 999, 999),
    "{invalid json"
  });
  var browser = BrowserActivityReader.ReadFrom(browserRoot, testNow);
  Check(browser.SessionsToday == 2 && browser.EventsToday == 6,
    "browser reader counts only valid current-day events");
  Check(browser.VisibleUser == 4 && browser.VisibleAssistant == 6,
    "browser reader uses latest count per approved session");
  Check(!JsonSerializer.Serialize(browser).Contains("NEVER-EXPOSE"),
    "browser summary excludes payload text and secrets");
  Check(browser.Latest.Contains("tracking stopped"),
    "browser reader exposes only safe status labels");
  Check(browser.StoreFound && browser.FilesRead == 1 &&
    browser.StartedSessions == 2 && browser.SessionsToday == 2 &&
    browser.LatestEventUtc.HasValue,
    "dashboard reports local file availability and actual start events");
  Check(browser.History.Count == 2 &&
    browser.History.All(h => h.Title.StartsWith("ChatGPT", StringComparison.Ordinal)) &&
    browser.History[0].LastSeen >= browser.History[1].LastSeen &&
    browser.History[0].Summary.Contains("Last observed messages"),
    "browser sessions appear newest first with safe display summaries");
  Check(browser.History.Any(h => h.Boundaries.Contains("Duration unavailable")) &&
    browser.History.Any(h => h.Boundaries.Contains("End event not captured.")),
    "browser history does not invent missing session boundaries");
  Check(!JsonSerializer.Serialize(browser.History).Contains(first, StringComparison.Ordinal) &&
    !JsonSerializer.Serialize(browser.History).Contains(second, StringComparison.Ordinal) &&
    !JsonSerializer.Serialize(browser.History).Contains("NEVER-EXPOSE", StringComparison.Ordinal),
    "session history never exposes pseudonyms or private input");
  Check(!BrowserActivityReader.ReadFrom(
    Path.Combine(browserRoot, "does-not-exist"), testNow).StoreFound,
    "missing activity folder is identified explicitly");


  var olderDay = day.AddDays(-3);
  var olderAt = new DateTimeOffset(olderDay.AddHours(12), TimeSpan.Zero);
  var sessionsWithCode = Enumerable.Range(2, 3).Select(n =>
    "123e4567-e89b-42d3-a456-42661417400" + n).ToArray();
  var olderRecords = sessionsWithCode.SelectMany((sessionId, i) => new[] {
    BrowserEvent("session_started", sessionId, olderAt.AddMinutes(i * 10)),
    JsonSerializer.Serialize(new {
      schemaVersion = 1, source = "chatgpt_browser",
      timestamp = olderAt.AddMinutes(i * 10 + 1),
      eventType = "visible_counts", sessionPseudonym = sessionId,
      visibleUser = 2, visibleAssistant = 2, visibleCodeBlocks = i + 1,
      secret = "PRIVATE CODE"
    }),
    JsonSerializer.Serialize(new {
      schemaVersion = 1, source = "chatgpt_browser",
      timestamp = olderAt.AddMinutes(i * 10 + 2),
      eventType = "coding_tag", sessionPseudonym = sessionId,
      codingMarked = true, text = "PRIVATE CONVERSATION"
    })
  }).ToArray();
  var olderFile = Path.Combine(browserRoot, $"events-{olderDay:yyyyMMdd}-000.jsonl");
  File.WriteAllLines(olderFile, olderRecords);
  var history = BrowserActivityReader.ReadFrom(browserRoot, testNow, CodexPeriod.AvailableHistory);
  Check(history.CodeBlocks == 6 && history.CodingSessions == 3 &&
    history.Patterns.Count == 2 && history.Patterns.All(p => p.Contains("3 separate")),
    "three separate coding sessions generate patterns without exposing code");
  Check(history.History.Count == 5 &&
    history.History.Count(h => h.Summary.Contains("Manually marked as coding work")) == 3 &&
    history.History.All(h => !h.Title.Contains("123e4567", StringComparison.Ordinal)) &&
    history.History.Any(h => h.Summary.Contains("Peak visible code examples: 3")),
    "ChatGPT history reports coding evidence without revealing session IDs");
  Check(!JsonSerializer.Serialize(history).Contains("PRIVATE"),
    "coding history never returns conversation text or code");
  var recent = BrowserActivityReader.ReadFrom(browserRoot, testNow, CodexPeriod.LastSevenDays);
  Check(recent.Patterns.Count == 2 && recent.CodeBlocks == 6,
    "seven-day filter includes previously opted-in coding sessions");
  var todayOnly = BrowserActivityReader.ReadFrom(browserRoot, testNow, CodexPeriod.Today);
  Check(todayOnly.Patterns.Count == 0 && todayOnly.CodeBlocks == 0,
    "today filter does not infer patterns from past sessions");
  File.AppendAllText(olderFile, "\n" + JsonSerializer.Serialize(new {
    schemaVersion = 1, source = "chatgpt_browser",
    timestamp = olderAt.AddMinutes(99), eventType = "coding_tag",
    sessionPseudonym = sessionsWithCode[0], codingMarked = false
  }));
  var unmarked = BrowserActivityReader.ReadFrom(browserRoot, testNow, CodexPeriod.AvailableHistory);
  Check(unmarked.Patterns.Count == 1 &&
    unmarked.Patterns[0].Contains("code examples") && unmarked.CodingSessions == 3,
    "removing a coding tag retracts only the manual-tag recurrence");
  Check(unmarked.History.Count(h => h.Summary.Contains("Manually marked as coding work")) == 2 &&
    unmarked.History.Any(h => h.Summary.Contains("Coding-work tag removed")),
    "historical coding-tag removals appear correctly in session summaries");

  File.AppendAllText(browserFile, "\n" + BrowserEvent(
    "visible_counts", "123e4567-e89b-42d3-a456-426614174007",
    morning.AddMinutes(30), 1, 1));
  var partialSession = BrowserActivityReader.ReadFrom(
    browserRoot, testNow, CodexPeriod.AvailableHistory);
  Check(partialSession.SessionsToday == 6 && partialSession.StartedSessions == 5,
    "session count includes valid recorded activity even if a start was missed");
  Check(partialSession.EventsToday == history.EventsToday + 2,
    "local appended events are included on subsequent refreshes");
  var workflowRoot = Path.Combine(browserRoot, "workflow-fixture");
  Directory.CreateDirectory(workflowRoot);
  var workflowSessions = new[] {
    "123e4567-e89b-42d3-a456-426614174008",
    "123e4567-e89b-42d3-a456-426614174009",
    "123e4567-e89b-42d3-a456-426614174010"
  };
  string WorkflowEvent(string sessionId, int offset, string? stage = null,
    string kind = "workflow_stage") => JsonSerializer.Serialize(new {
      schemaVersion = 1, source = "chatgpt_browser",
      timestamp = olderAt.AddMinutes(offset),
      eventType = kind, sessionPseudonym = sessionId,
      workflowStage = stage, prompt = "PRIVATE-REQUEST-CONTENT"
    });
  File.WriteAllLines(Path.Combine(workflowRoot, $"events-{olderDay:yyyyMMdd}-000.jsonl"),
    workflowSessions.SelectMany((sessionId, i) => new[] {
      WorkflowEvent(sessionId, 20 * i, null, "session_started"),
      WorkflowEvent(sessionId, 20 * i + 1, "debugging"),
      WorkflowEvent(sessionId, 20 * i + 2, "implementation"),
      WorkflowEvent(sessionId, 20 * i + 3, "testing")
    }));
  var analyzed = BrowserActivityReader.ReadFrom(workflowRoot, testNow, CodexPeriod.AvailableHistory);
  Check(analyzed.ClassifiedRequests == 9 && analyzed.AnalyzedSessions == 3 &&
    analyzed.WorkflowSummary.Contains("Debugging (3)") &&
    analyzed.WorkflowSummary.Contains("Implementation (3)"),
    "coding workflow requests are classified and summarized across sessions");
  Check(analyzed.Patterns.Any(p => p.Contains("Debugging") &&
    p.Contains("Implementation") && p.Contains("3 separate")),
    "repeated debugging-to-implementation sequence generates a meaningful pattern");
  Check(analyzed.Patterns.Any(p => p.Contains("Implementation") &&
    p.Contains("Testing") && p.Contains("3 separate")),
    "implementation-to-testing sequence appears after three distinct sessions");
  Check(analyzed.History.All(h => h.Summary.Contains("categorized coding requests")) &&
    !JsonSerializer.Serialize(analyzed).Contains("PRIVATE-REQUEST-CONTENT"),
    "no prompt text is stored in coding workflow summaries");
  File.WriteAllLines(Path.Combine(workflowRoot, $"events-{olderDay:yyyyMMdd}-000.jsonl"),
    workflowSessions.Take(2).SelectMany((sessionId, i) => new[] {
      WorkflowEvent(sessionId, 20 * i + 1, "debugging"),
      WorkflowEvent(sessionId, 20 * i + 2, "implementation")
    }));
  var early = BrowserActivityReader.ReadFrom(workflowRoot, testNow, CodexPeriod.AvailableHistory);
  Check(early.AnalyzedSessions == 2 && early.Patterns.Count == 0 &&
    early.WorkflowSummary.Contains("4 categorized requests"),
    "two sessions produce preliminary analysis without claiming recurrence");





}
finally { Directory.Delete(browserRoot, true); }

InsightTests.Run();
await CodingWorkTests.Run();
await CodeTrackingTests.Run();

if (args.Contains("--local"))
{
  var local = CodexActivityReader.Read();
  Console.WriteLine(JsonSerializer.Serialize(local));
}
