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
  int CodeBlocks, int CodingSessions, IReadOnlyList<string> Patterns,
  bool StoreFound, int FilesRead, int StartedSessions, DateTimeOffset? LatestEventUtc,
  bool IncompleteRead, IReadOnlyList<BrowserSessionInsight> History,
  int ClassifiedRequests, int AnalyzedSessions, string WorkflowSummary);

/// <summary>Safe per-session display model. No pseudonyms, URLs, titles or chat text.</summary>
internal sealed record BrowserSessionInsight(
  string Title, string Summary, string Boundaries, string Timeline, DateTimeOffset LastSeen);

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
      // Count every session with an accepted local event, not just the sessions
      // whose initial start event survived (e.g. older or partial event files).
      var sessions = new HashSet<string>(StringComparer.Ordinal);
      var startedSessions = new HashSet<string>(StringComparer.Ordinal);
      var sessionDetails = new Dictionary<string, BrowserSessionDetails>(StringComparer.Ordinal);
      var filesRead = 0;
      var incompleteRead = false;
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
              if (type is not ("session_started" or "visible_counts" or "session_ended" or "coding_tag" or "workflow_stage"))
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
              string? stage = null;
              if (type == "workflow_stage")
              {
                stage = GetString(record, "workflowStage");
                if (stage is not ("investigation" or "implementation" or
                    "debugging" or "testing" or "version_control" or "deployment"))
                  continue;
              }
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
              sessions.Add(session);
              if (!sessionDetails.TryGetValue(session, out var detail))
              {
                detail = new BrowserSessionDetails(when);
                sessionDetails.Add(session, detail);
              }
              detail.Observe(type!, when, user, assistant, codeBlocks, marked, stage);
              if (type == "session_started") startedSessions.Add(session);
              if (latest is null || when >= latest)
              {
                latest = when;
                latestLabel = type switch
                {
                  "session_started" => "Conversation tracking started",
                  "session_ended" => "Conversation tracking stopped",
                  "coding_tag" => marked == true ? "Coding session marked" : "Coding session unmarked",
                  "workflow_stage" => "Local coding request categorized",
                  _ => "Visible message counts updated"
                };
              }
            }
            catch (JsonException)
            {
              // Ignore malformed and partially written event lines.
            }
          }
          filesRead++;
        }
        catch (IOException) { incompleteRead = true; }
        catch (UnauthorizedAccessException) { incompleteRead = true; }
      }

      var visibleUser = counts.Values.Sum(v => v.User);
      var visibleAssistant = counts.Values.Sum(v => v.Assistant);
      var codeBlocksTotal = counts.Values.Sum(v => v.CodeBlocks ?? 0);
      // A rendered code example can disappear when ChatGPT virtualizes its
      // timeline. Track whether code was observed at any point in the session.
      var withCode = sessionDetails.Where(pair => pair.Value.PeakCodeBlocks > 0)
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

      var workflowGroups = sessionDetails.Values
        .Where(detail => detail.WorkflowStages.Count > 0).ToArray();
      var allStages = workflowGroups
        .SelectMany(detail => detail.WorkflowStages.Select(stage => stage.Stage)).ToArray();
      var topStages = allStages.GroupBy(stage => stage, StringComparer.Ordinal)
        .OrderByDescending(group => group.Count())
        .ThenBy(group => group.Key, StringComparer.Ordinal)
        .Take(3)
        .Select(group => $"{StageName(group.Key)} ({group.Count()})")
        .ToArray();
      string workflowSummary = allStages.Length == 0
        ? "No coding workflow requests classified yet. Enable Analyze coding workflow in the Edge sidebar for a recorded conversation; older metadata cannot be analyzed retroactively."
        : $"Local coding request analysis: {allStages.Length} categorized requests across " +
          $"{workflowGroups.Length} opted-in sessions. Most common: {string.Join(", ", topStages)}. " +
          "Heuristic classifications of requests; not verified file edits or completed actions.";

      // Count support at the session level. Repeated prompts in one session
      // cannot establish recurrence, even if they generate many events.
      var stageSupport = workflowGroups
        .SelectMany(group => group.WorkflowStages.Select(e => e.Stage).Distinct(StringComparer.Ordinal))
        .GroupBy(stage => stage, StringComparer.Ordinal);
      foreach (var category in stageSupport.OrderByDescending(group => group.Count()))
      {
        if (category.Count() >= CodexInsights.MinimumPatternSessions)
          patterns.Add($"ChatGPT requests involving {StageName(category.Key).ToLowerInvariant()} appeared in " +
            $"{category.Count()} separate analyzed sessions. These are requests, not verified actions.");
      }

      var pairs = new Dictionary<string, int>(StringComparer.Ordinal);
      foreach (var group in workflowGroups)
      {
        var orderedStages = group.WorkflowStages
          .OrderBy(e => e.At)
          .Select(e => e.Stage)
          .Where((stage, i) => true)
          .ToArray();
        var transitions = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 1; i < orderedStages.Length; i++)
        {
          if (orderedStages[i - 1] == orderedStages[i]) continue;
          transitions.Add(orderedStages[i - 1] + ">" + orderedStages[i]);
        }
        foreach (var transition in transitions)
          pairs[transition] = pairs.GetValueOrDefault(transition) + 1;
      }
      foreach (var pair in pairs.Where(p => p.Value >= CodexInsights.MinimumPatternSessions)
                 .OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).Take(5))
      {
        var labels = pair.Key.Split('>');
        patterns.Add($"ChatGPT request sequence: {StageName(labels[0])} → " +
          $"{StageName(labels[1])} in {pair.Value} separate analyzed sessions. " +
          "Request order does not verify that code was changed.");
      }

      var recentText = latest is null ? latestLabel :
        $"{latestLabel} · {latest.Value.ToLocalTime():MMM d HH:mm:ss}";
      var history = sessionDetails.Values
        .OrderByDescending(detail => detail.LastSeen)
        .Take(25)
        .Select(detail => detail.Describe())
        .ToArray();
      return new BrowserActivitySnapshot(sessions.Count, visibleUser, visibleAssistant,
        events, recentText, codeBlocksTotal, codingSessions.Count, patterns,
        true, filesRead, startedSessions.Count, latest, incompleteRead, history,
        allStages.Length, workflowGroups.Length, workflowSummary);
    }
    catch (Exception)
    {
      return Empty();
    }
  }

  // One mutable aggregate per random browser-session identifier. The identifier
  // is used as a dictionary key only and never enters the UI display model.
  private sealed class BrowserSessionDetails
  {
    internal DateTimeOffset FirstSeen { get; private set; }
    internal DateTimeOffset LastSeen { get; private set; }
    private DateTimeOffset? _start;
    private DateTimeOffset? _end;
    private DateTimeOffset? _latestCountAt;
    private DateTimeOffset? _latestTagAt;
    private int _starts;
    private int _ends;
    private int _countUpdates;
    private int _tagUpdates;
    private readonly List<(DateTimeOffset At, string Stage)> _workflowStages = new();
    internal IReadOnlyList<(DateTimeOffset At, string Stage)> WorkflowStages => _workflowStages;
    private int _user;
    private int _assistant;
    private bool _hasCounts;
    private bool? _marked;
    internal int PeakCodeBlocks { get; private set; }
    private bool _codeObserved;

    internal BrowserSessionDetails(DateTimeOffset first)
    {
      FirstSeen = first;
      LastSeen = first;
    }

    internal void Observe(string type, DateTimeOffset at, int user, int assistant,
      int? codeBlocks, bool? marked, string? stage)
    {
      if (at < FirstSeen) FirstSeen = at;
      if (at > LastSeen) LastSeen = at;
      if (type == "session_started")
      {
        _starts++;
        if (_start is null || at < _start) _start = at;
      }
      if (type == "session_ended")
      {
        _ends++;
        if (_end is null || at > _end) _end = at;
      }
      if (type == "visible_counts")
      {
        _countUpdates++;
        if (_latestCountAt is null || at >= _latestCountAt)
        {
          _latestCountAt = at;
          _user = user;
          _assistant = assistant;
          _hasCounts = true;
        }
        if (codeBlocks.HasValue)
        {
          _codeObserved = true;
          PeakCodeBlocks = Math.Max(PeakCodeBlocks, codeBlocks.Value);
        }
      }
      if (type == "workflow_stage" && stage is not null && _workflowStages.Count < 120)
        _workflowStages.Add((at, stage));
      if (type == "coding_tag")
      {
        _tagUpdates++;
        if (_latestTagAt is null || at >= _latestTagAt)
        {
          _latestTagAt = at;
          _marked = marked;
        }
      }
    }

    internal BrowserSessionInsight Describe()
    {
      var first = FirstSeen.ToLocalTime();
      var title = $"ChatGPT · {first:MMM d, yyyy HH:mm:ss}";
      var parts = new List<string>();
      if (_hasCounts)
        parts.Add($"Last observed messages: {_user} yours, {_assistant} ChatGPT.");
      else
        parts.Add("No visible message counts were captured.");
      if (_codeObserved)
        parts.Add($"Peak visible code examples: {PeakCodeBlocks} (not verified file edits).");
      if (_marked == true)
        parts.Add("Manually marked as coding work.");
      if (_workflowStages.Count > 0)
      {
        var frequent = _workflowStages.GroupBy(e => e.Stage)
          .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
          .Take(3).Select(g => $"{StageName(g.Key)} ({g.Count()})");
        parts.Add($"{_workflowStages.Count} categorized coding requests: {string.Join(", ", frequent)}.");
      }
      if (_marked == false && _tagUpdates > 0)
        parts.Add("Coding-work tag removed.");
      var boundaries = _starts == 1 && _start.HasValue
        ? $"Start recorded: {_start.Value.ToLocalTime():MMM d HH:mm:ss}."
        : _starts == 0 ? "Start event not captured." : "Multiple start events; start uncertain.";
      boundaries += _ends == 1 && _end.HasValue
        ? $" End recorded: {_end.Value.ToLocalTime():MMM d HH:mm:ss}."
        : _ends == 0 ? " End event not captured." : " Multiple end events; end uncertain.";
      if (_starts == 1 && _ends == 1 && _start.HasValue && _end.HasValue &&
          _end.Value > _start.Value &&
          FirstSeen >= _start.Value && LastSeen <= _end.Value)
        boundaries += $" Recorded duration: {(_end.Value - _start.Value).TotalMinutes:0.##} minutes.";
      else
        boundaries += " Duration unavailable.";
      var timeline = $"First local event: {FirstSeen.ToLocalTime():MMM d HH:mm:ss}. " +
        $"Latest local event: {LastSeen.ToLocalTime():MMM d HH:mm:ss}. " +
        $"Message-count updates: {_countUpdates}; coding-tag updates: {_tagUpdates}; " +
        $"categorized requests: {_workflowStages.Count}.";
      return new BrowserSessionInsight(title, string.Join(" ", parts), boundaries,
        timeline, LastSeen);
    }
  }

  private static string StageName(string stage) => stage switch
  {
    "investigation" => "Investigation",
    "implementation" => "Implementation",
    "debugging" => "Debugging",
    "testing" => "Testing",
    "version_control" => "Version control",
    "deployment" => "Deployment",
    _ => "Unclassified"
  };

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
      0, 0, Array.Empty<string>(), false, 0, 0, null, false,
      Array.Empty<BrowserSessionInsight>(), 0, 0,
      "No coding workflow analysis recorded yet.");
}
