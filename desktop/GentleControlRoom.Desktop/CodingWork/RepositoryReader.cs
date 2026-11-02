using System.Diagnostics;
using System.IO;
using System.IO.Enumeration;
using System.Text;
using System.Text.RegularExpressions;

namespace GentleControlRoom.Desktop.CodingWork;

internal static class RepositoryReader
{
    internal const int MaxFile = 256 * 1024, MaxPatch = 64 * 1024, MaxSnapshot = 1024 * 1024;
    private static readonly string[] Sensitive = { ".ssh", ".aws", ".azure", ".env*", "*secret*", "*credential*", "*.pem", "*.key", "*.pfx", "*.p12", "id_rsa*", "id_ed25519*", "*.kdbx", ".npmrc", ".pypirc", "appsettings*.json" };
    internal static void NoLinks(string path)
    {
        for (var item = Path.GetFullPath(path); !string.IsNullOrEmpty(item); item = Path.GetDirectoryName(item))
            if ((File.Exists(item) || Directory.Exists(item)) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Linked paths are not supported for tracking.");
    }
    internal static bool SafePath(TrackedRepository repo, string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Any(char.IsControl) || name.Contains(':') || name.Contains('\\') || Path.IsPathRooted(name)) return false;
        var segments = name.Split('/');
        if (segments.Any(s => s is "." or ".." || s.Equals(".git", StringComparison.OrdinalIgnoreCase) || s.Length == 0)) return false;
        var full = Path.GetFullPath(Path.Combine(repo.Root, name));
        if (!full.StartsWith(repo.Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return false;
        if (segments.Any(segment => Sensitive.Concat(repo.Exclusions).Any(pattern => FileSystemName.MatchesSimpleExpression(pattern, segment, true)))) return false;
        try
        {
            NoLinks(full);
            var parent = Path.GetDirectoryName(full);
            while (parent is not null && !string.Equals(parent, repo.Root, StringComparison.OrdinalIgnoreCase))
            { if (Directory.Exists(Path.Combine(parent, ".git")) || File.Exists(Path.Combine(parent, ".git"))) return false; parent = Path.GetDirectoryName(parent); }
            return true;
        }
        catch { return false; }
    }
    internal static async Task<(int Code, string Output)> Git(string root, params string[] args)
    {
        var executable = new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd") }
            .Concat((Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
            .Where(p => Path.IsPathFullyQualified(p) && !Path.GetFullPath(p).StartsWith(root, StringComparison.OrdinalIgnoreCase))
            .Select(p => Path.Combine(p, OperatingSystem.IsWindows() ? "git.exe" : "git")).FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException("Install Git outside the approved repository.");
        var start = new ProcessStartInfo(executable) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, StandardOutputEncoding = new UTF8Encoding(false, true) };
        foreach (var key in start.Environment.Keys.Where(k => k.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1"; start.Environment["GIT_CONFIG_GLOBAL"] = OperatingSystem.IsWindows() ? "NUL" : "/dev/null";
        start.Environment["GIT_OPTIONAL_LOCKS"] = "0"; start.Environment["GIT_TERMINAL_PROMPT"] = "0"; start.Environment["GIT_NO_LAZY_FETCH"] = "1";
        foreach (var arg in new[] { "--literal-pathspecs", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "core.quotePath=false" }.Concat(args)) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException();
        process.StandardInput.Close();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        async Task<string> Read(StreamReader reader)
        {
            var result = new StringBuilder(); var buffer = new char[4096]; int n;
            while ((n = await reader.ReadAsync(buffer.AsMemory(), deadline.Token)) > 0)
            { if (result.Length + n > 2 * MaxSnapshot) { deadline.Cancel(); throw new IOException(); } result.Append(buffer, 0, n); }
            return result.ToString();
        }
        try
        {
            var stdout = Read(process.StandardOutput); var stderr = Read(process.StandardError);
            await process.WaitForExitAsync(deadline.Token); var output = await stdout; await stderr;
            return (process.ExitCode, output);
        }
        catch { if (!process.HasExited) process.Kill(true); throw new InvalidOperationException("Git observation failed or exceeded its limit; no baseline was changed."); }
    }
    private static async Task<string> Required(string root, params string[] args)
    { var result = await Git(root, args); if (result.Code != 0) throw new InvalidOperationException("The approved repository could not be read."); return result.Output; }
    internal static async Task<string> ValidateRoot(string path)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)); NoLinks(root);
        if (root.StartsWith("\\\\") || new DriveInfo(Path.GetPathRoot(root)!).DriveType == DriveType.Network) throw new InvalidOperationException("Choose a local repository.");
        if (!Directory.Exists(Path.Combine(root, ".git"))) throw new InvalidOperationException("Choose a standard Git repository root; linked worktrees and submodules are not supported.");
        NoLinks(Path.Combine(root, ".git")); NoLinks(Path.Combine(root, ".git", "config"));
        if (File.Exists(Path.Combine(root, ".git", "objects", "info", "alternates"))) throw new InvalidOperationException("Alternate object stores are not supported.");
        if ((await Git(root, "config", "--get-regexp", @"^filter\..*\.(clean|smudge|process)$")).Code == 0)
            throw new InvalidOperationException("Repositories with executable content filters are not supported by passive observation.");
        NoLinks(Path.Combine(root, ".git", "objects"));
        NoLinks(Path.Combine(root, ".git", "objects", "pack"));
        if ((await Git(root, "config", "--get-regexp", @"remote\..*\.promisor")).Code == 0 ||
            (await Git(root, "config", "--get", "extensions.partialClone")).Code == 0)
            throw new InvalidOperationException("Partial clones are not supported; observation never fetches missing objects.");
        var actual = (await Required(root, "rev-parse", "--show-toplevel")).Trim();
        if (!string.Equals(Path.GetFullPath(actual), root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select the repository root.");
        return root;
    }
    internal static string Identity(string root) => WorkJson.Hash(root.ToUpperInvariant() + Directory.GetCreationTimeUtc(Path.Combine(root, ".git")).Ticks);
    private static bool Hash(string value) => Regex.IsMatch(value, "^[0-9a-f]{40,64}$");
    private static async Task<bool> SafeObject(string root, string reference, string name)
    {
        if (reference == "") return true;
        var tree = await Required(root, "ls-tree", reference, "--", name);
        if (tree.Length == 0) return true;
        if (!tree.StartsWith("100644 ") && !tree.StartsWith("100755 ")) return false;
        var size = await Required(root, "cat-file", "-s", reference + ":" + name);
        return long.TryParse(size.Trim(), out var length) && length <= MaxFile;
    }
    internal static async Task<RepositorySnapshot> Capture(TrackedRepository repo, bool baseline = false)
    {
        await ValidateRoot(repo.Root);
        if (repo.Identity != "" && repo.Identity != Identity(repo.Root)) throw new InvalidOperationException("Repository identity changed. Revoke and approve it again.");
        var headResult = await Git(repo.Root, "rev-parse", "--verify", "HEAD");
        var head = headResult.Code == 0 ? headResult.Output.Trim() : "";
        if (head != "" && !Hash(head)) throw new IOException();
        var files = new Dictionary<string, FileChange>(StringComparer.Ordinal); var commits = new List<FileChange>(); int skipped = 0, bytes = 0;
        void Skip(string layer, string name)
        {
            skipped++;
            if (layer != "Commit" && RepositoryReader.SafePath(repo, name) && repo.Baseline.TryGetValue(layer + ":" + name, out var old))
                files[layer + ":" + name] = old;
        }
        async Task ReadDiff(string layer, string from, string to, bool cached = false)
        {
            var args = new List<string> { "diff", "--no-ext-diff", "--no-textconv", "--no-renames" };
            if (cached) args.Add("--cached");
            if (from != "") args.Add(from); if (to != "") args.Add(to);
            var names = (await Required(repo.Root, args.Concat(new[] { "--numstat", "-z" }).ToArray())).Split('\0', StringSplitOptions.RemoveEmptyEntries);
            if (names.Length > 200) throw new InvalidOperationException("Too many changed files; tracking did not advance.");
            foreach (var entry in names)
            {
                var pieces = entry.Split('\t', 3); if (pieces.Length != 3) throw new IOException();
                var name = pieces[2];
                if (!int.TryParse(pieces[0], out var add) || !int.TryParse(pieces[1], out var del) || !SafePath(repo, name)) { Skip(layer, name); continue; }
                var path = Path.Combine(repo.Root, name);
                if ((File.Exists(path) && new FileInfo(path).Length > MaxFile) || !await SafeObject(repo.Root, head, name) ||
                    !await SafeObject(repo.Root, from, name) || !await SafeObject(repo.Root, to, name)) { Skip(layer, name); continue; }
                var index = await Required(repo.Root, "ls-files", "--stage", "--", name);
                if (index.Split('\n', StringSplitOptions.RemoveEmptyEntries).Any(l => !l.StartsWith("100644 ") && !l.StartsWith("100755 "))) { Skip(layer, name); continue; }
                // Force a textual rendering; reject NULs/invalid UTF-8 and bound the complete patch.
                var patch = await Required(repo.Root, args.Concat(new[] { "--patch", "--unified=3", "--", name }).ToArray());
                if (patch.Contains('\0') || Encoding.UTF8.GetByteCount(patch) > MaxPatch || patch.Contains("GIT binary patch") || patch.Contains("Binary files")) { Skip(layer, name); continue; }
                if (!SafePath(repo, name)) { Skip(layer, name); continue; }
                add = 0; del = 0; bool inHunk = false;
                foreach (var line in patch.Split('\n'))
                {
                    if (line.StartsWith("@@ ")) inHunk = true;
                    else if (line.StartsWith("diff --git ")) inHunk = false;
                    else if (inHunk && line.StartsWith('+')) add++;
                    else if (inHunk && line.StartsWith('-')) del++;
                }
                bytes += Encoding.UTF8.GetByteCount(patch); if (bytes > MaxSnapshot) throw new InvalidOperationException("Snapshot exceeds its size limit; tracking did not advance.");
                var change = new FileChange(name, layer, patch, add, del, to);
                if (layer == "Commit") commits.Add(change); else files[layer + ":" + name] = change;
            }
        }
        await ReadDiff("Unstaged", "", ""); await ReadDiff("Staged", "", "", true);
        if (repo.IncludeUntracked)
        {
            var names = (await Required(repo.Root, "ls-files", "--others", "--exclude-standard", "-z")).Split('\0', StringSplitOptions.RemoveEmptyEntries);
            if (names.Length > 100) throw new InvalidOperationException("More than 100 untracked files; narrow the repository before tracking.");
            foreach (var name in names)
            {
                if (!SafePath(repo, name)) { Skip("Untracked", name); continue; }
                var path = Path.Combine(repo.Root, name); if (!File.Exists(path) || new FileInfo(path).Length > MaxFile) { Skip("Untracked", name); continue; }
                string content;
                try
                {
                    using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    var data = new byte[MaxFile + 1]; int read = 0, n;
                    while (read < data.Length && (n = await input.ReadAsync(data.AsMemory(read))) > 0) read += n;
                    if (read > MaxFile) { Skip("Untracked", name); continue; }
                    content = new UTF8Encoding(false, true).GetString(data, 0, read);
                }
                catch (DecoderFallbackException) { Skip("Untracked", name); continue; }
                NoLinks(path); if (content.Contains('\0') || Encoding.UTF8.GetByteCount(content) > MaxPatch / 2) { Skip("Untracked", name); continue; }
                var lines = content.Length == 0 ? Array.Empty<string>() : content.Split('\n');
                if (content.EndsWith('\n')) lines = lines[..^1];
                var patch = "diff --git a/" + name + " b/" + name + "\nnew file mode 100644\n--- /dev/null\n+++ b/" + name + "\n";
                if (lines.Length > 0) patch += $"@@ -0,0 +1,{lines.Length} @@\n" + string.Join("\n", lines.Select(l => "+" + l)) + "\n";
                if (content.Length > 0 && !content.EndsWith('\n')) patch += "\\ No newline at end of file\n";
                bytes += Encoding.UTF8.GetByteCount(patch); if (bytes > MaxSnapshot) throw new InvalidOperationException("Snapshot exceeds its limit.");
                files["Untracked:" + name] = new(name, "Untracked", patch, content.Length == 0 ? 0 : content.Count(c => c == '\n') + (content.EndsWith('\n') ? 0 : 1), 0);
            }
        }
        bool reset = false;
        if (!baseline && head != repo.Head)
        {
            if (head == "" || (repo.Head != "" && (await Git(repo.Root, "merge-base", "--is-ancestor", repo.Head, head)).Code != 0)) reset = true;
            else
            {
                var added = (await Required(repo.Root, "rev-list", "--reverse", "--max-count=21", repo.Head == "" ? head : repo.Head + ".." + head)).Split('\n', StringSplitOptions.RemoveEmptyEntries);
                if (added.Length > 20) reset = true;
                else foreach (var commit in added.Select(x => x.Trim()))
                {
                    if (!Hash(commit)) throw new IOException(); if (repo.SeenCommits.Contains(commit)) continue;
                    var parents = (await Required(repo.Root, "rev-list", "--parents", "-n", "1", commit)).Trim().Split(' ');
                    var parent = parents.Length > 1 ? parents[1] : (await Required(repo.Root, "hash-object", "-t", "tree", "--stdin")).Trim();
                    if (!Hash(parent)) throw new IOException(); await ReadDiff("Commit", parent, commit);
                }
            }
        }
        // If HEAD moves during observation, discard the whole scan and retry next time.
        var after = await Git(repo.Root, "rev-parse", "--verify", "HEAD");
        if ((after.Code == 0 ? after.Output.Trim() : "") != head) throw new InvalidOperationException("Repository changed during observation; retrying later.");
        return new(head, files, commits.ToArray(), reset, skipped);
    }
}
