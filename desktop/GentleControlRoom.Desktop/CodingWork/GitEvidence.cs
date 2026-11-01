using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace GentleControlRoom.Desktop.CodingWork;

// Explicitly chosen repository only. No automatic drive scan, remotes, network,
// shell commands, source contents, commit messages, author names or file paths.
internal static class GitEvidence
{
    private static async Task<string> Git(string path, string[] args, CancellationToken token)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = path, UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var p = Process.Start(start) ?? throw new InvalidOperationException("Git is unavailable.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            var output = ReadBounded(p.StandardOutput, deadline.Token);
            var error = ReadBounded(p.StandardError, deadline.Token);
            await p.WaitForExitAsync(deadline.Token);
            var text = await output; await error;
            if (p.ExitCode != 0) throw new InvalidOperationException("Choose an accessible Git repository with committed history.");
            return text;
        }
        catch { if (!p.HasExited) p.Kill(true); throw new InvalidOperationException("Repository evidence could not be read. Check the selected folder and try again."); }
    }
    private static async Task<string> ReadBounded(StreamReader reader, CancellationToken token)
    {
        var text = new System.Text.StringBuilder(); var buffer = new char[4096]; int n;
        while ((n = await reader.ReadAsync(buffer.AsMemory(), token)) > 0)
        { if (text.Length + n > 1024 * 1024) throw new InvalidOperationException("Repository output limit reached."); text.Append(buffer, 0, n); }
        return text.ToString();
    }
    public static async Task<Observation[]> ReadAsync(string path, CancellationToken token = default)
    {
        var top = (await Git(path, new[] { "rev-parse", "--show-toplevel" }, token)).Trim();
        var project = WorkJson.Hash(Path.GetFullPath(top).ToUpperInvariant());
        var output = await Git(path, new[] { "--no-pager", "log", "-50", "--format=%H|%cI", "--no-show-signature" }, token);
        var records = new List<Observation>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Trim().Split('|');
            if (parts.Length != 2 || !Regex.IsMatch(parts[0], "^[0-9a-f]{40,64}$") || !DateTimeOffset.TryParse(parts[1], CultureInfo.InvariantCulture, DateTimeStyles.None, out var at)) continue;
            var names = await Git(path, new[] { "--no-pager", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", parts[0] }, token);
            var count = names.Split('\0', StringSplitOptions.RemoveEmptyEntries).Length;
            records.Add(new(WorkJson.Hash(project + parts[0]), "Local Git", "", project, at, "git_commit", "Version control",
                $"Local commit records changes to {count} files. No tests, push or deployment verified.", Reference: parts[0], FilesChanged: count));
        }
        return records.ToArray();
    }
}
