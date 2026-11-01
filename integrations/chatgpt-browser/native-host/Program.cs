using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace GentleControlRoom.ChatGPTHost;

// Dedicated Edge native messaging executable. It never reads cookies, text,
// conversations, page contents, tokens, URLs, or arbitrary browser data.
internal static class Program
{
  private const int MaxMessageBytes = 8192;
  private const int MaxDailyFileBytes = 1024 * 1024;
  private const string HostManifest = "native-host.json";

  public static int Main(string[] args)
  {
    try
    {
      if (args.Length == 1 && args[0] == "--self-test")
      {
        var parsed = ParseEvent("""{"version":1,"event":"visible_counts","sessionId":"123e4567-e89b-42d3-a456-426614174000","visibleUser":4,"visibleAssistant":3,"secret":"NEVER_COPY"}""");
        if (parsed is null || parsed.Value.VisibleUser != 4 || parsed.Value.VisibleAssistant != 3)
        {
          return 1;
        }
        var workflow = ParseEvent("""{"version":1,"event":"workflow_stage","sessionId":"123e4567-e89b-42d3-a456-426614174000","stage":"debugging","prompt":"PRIVATE CODE"}""");
        if (workflow?.WorkflowStage != "debugging" ||
            JsonSerializer.Serialize(workflow).Contains("PRIVATE CODE", StringComparison.Ordinal) ||
            ParseEvent("""{"version":1,"event":"workflow_stage","sessionId":"123e4567-e89b-42d3-a456-426614174000","stage":"PRIVATE CODE"}""") is not null)
          return 1;
        var coding = ParseEvent("""{"version":1,"event":"coding_tag","sessionId":"123e4567-e89b-42d3-a456-426614174000","codingMarked":true,"code":"PRIVATE"}""");
        var codeBlocks = ParseEvent("""{"version":1,"event":"visible_counts","sessionId":"123e4567-e89b-42d3-a456-426614174000","visibleUser":4,"visibleAssistant":3,"visibleCodeBlocks":2}""");
        if (coding?.CodingMarked != true || codeBlocks?.VisibleCodeBlocks != 2 ||
            ParseEvent("""{"version":1,"event":"visible_counts","sessionId":"123e4567-e89b-42d3-a456-426614174000","visibleUser":4,"visibleAssistant":3,"visibleCodeBlocks":-1}""") is not null ||
            ParseEvent("""{"version":1,"event":"coding_tag","sessionId":"123e4567-e89b-42d3-a456-426614174000","codingMarked":"PRIVATE"}""") is not null ||
            JsonSerializer.Serialize(coding).Contains("PRIVATE", StringComparison.Ordinal) ||
            JsonSerializer.Serialize(parsed).Contains("NEVER_COPY", StringComparison.Ordinal) ||
            !IsHealthCheck("""{"version":1,"event":"health_check"}""") ||
            IsHealthCheck("""{"version":2,"event":"health_check"}"""))
        {
          return 1;
        }
        return 0;
      }

      // Installer smoke check: confirm the published executable can read its own
      // manifest and that the registered extension origin is allowlisted.
      if (args.Length == 2 && args[0] == "--check-install")
      {
        return IsAllowedOrigin(args[1]) ? 0 : 1;
      }

      // Edge only launches a native host for manifest-listed extension IDs.
      // Enforce the expected extension origin again within the executable.
      if (args.Length == 0 || !IsAllowedOrigin(args[0]))
      {
        return 1;
      }

      using var stdin = Console.OpenStandardInput();
      using var stdout = Console.OpenStandardOutput();
      Span<byte> prefix = stackalloc byte[4];
      if (!ReadExactly(stdin, prefix)) return 1;
      var length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
      if (length <= 0 || length > MaxMessageBytes)
      {
        WriteResult(stdout, false);
        return 1;
      }

      var data = new byte[length];
      if (!ReadExactly(stdin, data))
      {
        WriteResult(stdout, false);
        return 1;
      }

      var json = Encoding.UTF8.GetString(data);
      // A health check is deliberately read-only: never create an activity file
      // or a session just to test native messaging connectivity.
      if (IsHealthCheck(json))
      {
        WriteResult(stdout, true);
        return 0;
      }

      var record = ParseEvent(json);
      if (record is null)
      {
        WriteResult(stdout, false);
        return 1;
      }

      SaveEvent(record.Value);
      WriteResult(stdout, true);
      return 0;
    }
    catch (Exception)
    {
      // Never echo unsafe browser input or filesystem details to stdout/stderr.
      return 1;
    }
  }

  private static bool IsAllowedOrigin(string supplied)
  {
    try
    {
      var manifestPath = Path.Combine(AppContext.BaseDirectory, HostManifest);
      using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
      var origins = manifest.RootElement.GetProperty("allowed_origins");
      if (origins.ValueKind != JsonValueKind.Array) return false;
      return origins.EnumerateArray().Any(origin =>
        origin.ValueKind == JsonValueKind.String &&
        string.Equals(origin.GetString()?.TrimEnd('/'), supplied.TrimEnd('/'), StringComparison.Ordinal));
    }
    catch (Exception)
    {
      return false;
    }
  }

  internal static bool IsHealthCheck(string raw)
  {
    try
    {
      using var doc = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 5 });
      var item = doc.RootElement;
      return item.ValueKind == JsonValueKind.Object &&
        item.TryGetProperty("version", out var version) &&
        version.ValueKind == JsonValueKind.Number &&
        version.TryGetInt32(out var schema) && schema == 1 &&
        item.TryGetProperty("event", out var kind) &&
        kind.ValueKind == JsonValueKind.String &&
        kind.GetString() == "health_check";
    }
    catch (JsonException)
    {
      return false;
    }
  }

  internal readonly record struct BrowserEvent(
    string EventType, string Session, int? VisibleUser, int? VisibleAssistant,
    int? VisibleCodeBlocks, bool? CodingMarked, string? WorkflowStage);

  internal static BrowserEvent? ParseEvent(string raw)
  {
    try
    {
      using var doc = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 5 });
      var root = doc.RootElement;
      if (root.ValueKind != JsonValueKind.Object) return null;
      if (!root.TryGetProperty("version", out var version) || version.GetInt32() != 1)
        return null;
      if (!root.TryGetProperty("event", out var kind) || kind.ValueKind != JsonValueKind.String)
        return null;
      var name = kind.GetString();
      if (name is not ("session_started" or "visible_counts" or "session_ended" or "coding_tag" or "workflow_stage")) return null;
      if (!root.TryGetProperty("sessionId", out var token) ||
          token.ValueKind != JsonValueKind.String ||
          !Guid.TryParseExact(token.GetString(), "D", out var session))
        return null;

      int? user = null;
      int? assistant = null;
      int? codeBlocks = null;
      bool? codingMarked = null;
      string? workflowStage = null;
      if (name == "visible_counts")
      {
        if (!root.TryGetProperty("visibleUser", out var userProp) ||
            !root.TryGetProperty("visibleAssistant", out var assistantProp) ||
            !userProp.TryGetInt32(out var userCount) ||
            !assistantProp.TryGetInt32(out var assistantCount) ||
            userCount is < 0 or > 10000 || assistantCount is < 0 or > 10000)
          return null;
        user = userCount;
        assistant = assistantCount;
        // Absent for older extension versions; do not invent a code count.
        if (root.TryGetProperty("visibleCodeBlocks", out var codeProp))
        {
          if (codeProp.ValueKind != JsonValueKind.Number ||
              !codeProp.TryGetInt32(out var count) || count is < 0 or > 10000)
            return null;
          codeBlocks = count;
        }
      }
      if (name == "coding_tag")
      {
        if (!root.TryGetProperty("codingMarked", out var tag) ||
            tag.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
          return null;
        codingMarked = tag.GetBoolean();
      }
      if (name == "workflow_stage")
      {
        if (!root.TryGetProperty("stage", out var stage) ||
            stage.ValueKind != JsonValueKind.String)
          return null;
        workflowStage = stage.GetString();
        if (workflowStage is not ("investigation" or "implementation" or
            "debugging" or "testing" or "version_control" or "deployment"))
          return null;
      }
      // Reconstruct from allowlisted fields only. Raw page text is discarded.
      return new BrowserEvent(name!, session.ToString("D"), user, assistant,
        codeBlocks, codingMarked, workflowStage);
    }
    catch (Exception)
    {
      return null;
    }
  }

  private static void SaveEvent(BrowserEvent record)
  {
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (string.IsNullOrWhiteSpace(local)) throw new IOException();
    var folder = Path.Combine(local, "GentleControlRoom", "BrowserActivity");
    Directory.CreateDirectory(folder);
    var now = DateTimeOffset.UtcNow;
    var day = now.ToString("yyyyMMdd");
    // Session tokens are random local IDs generated by the extension; no URLs.
    var line = JsonSerializer.Serialize(new
    {
      schemaVersion = 1, source = "chatgpt_browser",
      timestamp = now.ToString("O"), eventType = record.EventType,
      sessionPseudonym = record.Session,
      visibleUser = record.VisibleUser,
      visibleAssistant = record.VisibleAssistant,
      visibleCodeBlocks = record.VisibleCodeBlocks,
      codingMarked = record.CodingMarked,
      workflowStage = record.WorkflowStage
    }) + "\n";
    var bytes = Encoding.UTF8.GetBytes(line);
    var index = 0;
    for (; index < 1000; index++)
    {
      var path = Path.Combine(folder, $"events-{day}-{index:D3}.jsonl");
      for (var attempt = 0; attempt < 10; attempt++)
      {
        try
        {
          using var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None);
          if (stream.Length + bytes.Length > MaxDailyFileBytes)
          {
            break;
          }
          stream.Seek(0, SeekOrigin.End);
          stream.Write(bytes);
          stream.Flush(true);
          Cleanup(folder, now.UtcDateTime.Date);
          return;
        }
        catch (IOException) when (attempt < 9)
        {
          System.Threading.Thread.Sleep(30);
        }
      }
    }
    throw new IOException();
  }

  private static void Cleanup(string folder, DateTime today)
  {
    foreach (var file in Directory.EnumerateFiles(folder, "events-????????-???.jsonl"))
    {
      var name = Path.GetFileName(file);
      if (!DateTime.TryParseExact(name.Substring(7, 8), "yyyyMMdd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var day))
      {
        continue;
      }
      if (day.Date < today.AddDays(-29) || day.Date > today)
      {
        try { File.Delete(file); } catch (IOException) { }
      }
    }
  }

  private static bool ReadExactly(Stream stream, Span<byte> buffer)
  {
    while (!buffer.IsEmpty)
    {
      var read = stream.Read(buffer);
      if (read == 0) return false;
      buffer = buffer[read..];
    }
    return true;
  }

  private static void WriteResult(Stream stream, bool success)
  {
    var payload = Encoding.UTF8.GetBytes(success ? """{"ok":true}""" : """{"ok":false}""");
    Span<byte> prefix = stackalloc byte[4];
    BinaryPrimitives.WriteInt32LittleEndian(prefix, payload.Length);
    stream.Write(prefix);
    stream.Write(payload);
    stream.Flush();
  }
}
