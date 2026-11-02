using System.IO;
using System.Text.Json;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;

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
            RepositoryReader.NoLinks(_root);
            Directory.CreateDirectory(_root);
            if (OperatingSystem.IsWindows())
            {
                var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
                foreach (var sid in new[] { WindowsIdentity.GetCurrent().User!, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
                    acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                new DirectoryInfo(_root).SetAccessControl(acl);
            }
            RepositoryReader.NoLinks(Path.Combine(_root, "state.lock"));
            using var held = new FileStream(Path.Combine(_root, "state.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            var file = Path.Combine(_root, "work-v1.json");
            RepositoryReader.NoLinks(file);
            WorkState state;
            try
            {
                if (File.Exists(file) && new FileInfo(file).Length > 64 * 1024 * 1024) throw new IOException();
                var json = File.Exists(file) ? File.ReadAllText(file) : "";
                if (json != "")
                {
                    using var envelope = JsonDocument.Parse(json);
                    if (envelope.RootElement.TryGetProperty("Protection", out _))
                        json = Encoding.UTF8.GetString(WindowsAnalysisSecret.Transform(Convert.FromBase64String(envelope.RootElement.GetProperty("Data").GetString()!), false));
                }
                state = json != "" ? JsonSerializer.Deserialize<WorkState>(json, WorkJson.Options)! : new();
                if (state is null || state.SchemaVersion is not (1 or 2)) throw new JsonException();
                state.SchemaVersion = 2; // Additive migration; existing evidence and consent are preserved.
            }
            catch (Exception e) when (e is IOException or JsonException)
            { throw new InvalidOperationException("Local analysis data could not be opened. Restore a backup; the existing file has not been replaced."); }
            var operationAt = DateTimeOffset.UtcNow;
            if (save) CodeTracking.Prune(state, operationAt);
            var result = action(state);
            if (save)
            {
                CodeTracking.Prune(state, operationAt);
                var json = WorkJson.Serialize(state);
                if (OperatingSystem.IsWindows()) json = WorkJson.Serialize(new { Protection = "CurrentUserDPAPI", Data = Convert.ToBase64String(WindowsAnalysisSecret.Transform(Encoding.UTF8.GetBytes(json), true)) });
                var bytes = Encoding.UTF8.GetBytes(json);
                if (bytes.Length > 64 * 1024 * 1024) throw new InvalidOperationException("Local analysis storage limit reached.");
                var temp = file + ".tmp";
                RepositoryReader.NoLinks(temp);
                using (var output = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                { output.Write(bytes); output.Flush(true); }
                File.Move(temp, file, true);
            }
            return result;
        }
    }
}
