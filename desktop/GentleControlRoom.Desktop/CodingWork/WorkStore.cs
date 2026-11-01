using System.IO;
using System.Text.Json;

namespace GentleControlRoom.Desktop.CodingWork;

// Atomic versioned snapshots. An OS file lock covers read/modify/write, including
// request-budget reservation across multiple app instances. Unknown versions fail closed.
internal sealed class WorkStore(string root)
{
    private readonly string _root = root;
    private readonly object _gate = new();
    public WorkState Read() => Update(s => s, false);
    public T Update<T>(Func<WorkState, T> action, bool save = true)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(_root);
            using var held = new FileStream(Path.Combine(_root, "state.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            var file = Path.Combine(_root, "work-v1.json");
            WorkState state;
            try
            {
                if (File.Exists(file) && new FileInfo(file).Length > 64 * 1024 * 1024) throw new IOException();
                state = File.Exists(file) ? JsonSerializer.Deserialize<WorkState>(File.ReadAllText(file), WorkJson.Options)! : new();
                if (state is null || state.SchemaVersion != 1) throw new JsonException();
            }
            catch (Exception e) when (e is IOException or JsonException)
            { throw new InvalidOperationException("Local analysis data could not be opened. Restore a backup; the existing file has not been replaced."); }
            var result = action(state);
            if (save)
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(WorkJson.Serialize(state));
                if (bytes.Length > 64 * 1024 * 1024) throw new InvalidOperationException("Local analysis storage limit reached.");
                var temp = file + ".tmp";
                using (var output = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                { output.Write(bytes); output.Flush(true); }
                File.Move(temp, file, true);
            }
            return result;
        }
    }
}
