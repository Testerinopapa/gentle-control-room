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
  Check(empty.State == "Recording" && empty.EventsToday == 0 && empty.Recent.Count == 0,
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
  Check(result.SessionsToday == 1 && result.ToolUsesToday == 6 && result.EventsToday == 8,
    "local day, session deduplication, malformed and future records");
  Check(result.Categories.All(c => c.Count == 1), "all six categories, unknown tools map to Other");
  Check(result.Recent.Count == 5 && result.Recent.SequenceEqual(result.Recent.OrderByDescending(e => e.Timestamp)),
    "five newest events ordered by timestamp");
  Check(!JsonSerializer.Serialize(result).Contains("PRIVATE"), "snapshot contains only allowlisted display data");
  Consent(true);
  Check(CodexActivityReader.ReadFrom(root, true, now).State == "Paused", "paused collector keeps history");
  File.AppendAllText(file, "\n" + Event("turn_finished", now));
  var updated = CodexActivityReader.ReadFrom(root, true, now);
  Check(updated.EventsToday == 9 && updated.Recent[0].Category == "Turn finished", "refresh sees appended event");
  Check(CodexActivityReader.ReadFrom(root, false, now).State.StartsWith("Off"), "missing hooks cannot report recording");
  File.WriteAllText(Path.Combine(root, "consent.json"), "{}");
  Check(CodexActivityReader.ReadFrom(root, true, now).State == "Unavailable", "malformed consent fails closed");
}
finally { Directory.Delete(root, true); }

if (args.Contains("--local"))
{
  var local = CodexActivityReader.Read();
  Console.WriteLine(JsonSerializer.Serialize(local));
}
