using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace GentleControlRoom.Desktop.CodingWork;

// DPAPI defaults to the current Windows user. No WebView bridge exposes this secret.
internal sealed class WindowsAnalysisSecret(string root) : IAnalysisSecret
{
    private string FileName => Path.Combine(root, "deepseek-key.dpapi");
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
    private static byte[] Transform(byte[] bytes, bool protect)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("API key storage requires Windows.");
        var input = new Blob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        Blob output = default;
        try
        {
            Marshal.Copy(bytes, 0, input.Data, bytes.Length);
            var ok = protect ? CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!ok) throw new InvalidOperationException("The API key could not be accessed for this Windows account.");
            var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
        }
        finally
        {
            for (int i = 0; i < input.Length; i++) Marshal.WriteByte(input.Data, i, 0);
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != IntPtr.Zero) { for (int i = 0; i < output.Length; i++) Marshal.WriteByte(output.Data, i, 0); LocalFree(output.Data); }
            Array.Clear(bytes);
        }
    }
    public string Read()
    {
        if (!File.Exists(FileName)) throw new AnalysisFailure("Add your DeepSeek API key in Analysis settings.");
        var bytes = Transform(File.ReadAllBytes(FileName), false);
        try { return Encoding.UTF8.GetString(bytes); } finally { Array.Clear(bytes); }
    }
    public void Save(string key)
    {
        if (key.Length is < 8 or > 512 || key.Any(char.IsWhiteSpace)) throw new InvalidOperationException("Enter a valid API key.");
        Directory.CreateDirectory(root);
        var temp = FileName + ".tmp";
        File.WriteAllBytes(temp, Transform(Encoding.UTF8.GetBytes(key), true)); File.Move(temp, FileName, true);
    }
    public void Delete() { if (File.Exists(FileName)) File.Delete(FileName); }
}
