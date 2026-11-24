using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace DevShift.Windows;

internal sealed record ConsoleLaunch(string Executable, string[] Args, string Cwd, string Title);

internal static partial class Control
{
    private const uint QueryLimited = 0x1000;
    private const uint VmRead = 0x0010;
    private const uint TerminateAccess = 0x0001;
    private const uint WmClose = 0x0010;
    private const uint GwOwner = 4;
    private const uint CreateNewConsole = 0x0010;

    [GeneratedRegex(@"[^\p{L}\p{N} ._·:@/-]", RegexOptions.CultureInvariant)]
    private static partial Regex UnsafeTitle();

    // Holding the handle while checking the creation time means a reused PID can never be acted on.
    private static SafeProcessHandle Open(int pid, string started, uint access)
    {
        var handle = OpenProcess(access | QueryLimited, false, pid);
        if (handle.IsInvalid)
        {
            handle.Dispose();
            throw new WindowsFault("process-access", "Windows did not let DevShift open the process. It may have exited.");
        }
        var expected = DateTime.ParseExact(started, "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal).Ticks;
        if (!GetProcessTimes(handle, out var creation, out _, out _, out _)
            || Math.Abs(DateTime.FromFileTimeUtc(creation).Ticks - expected) >= 10)
        {
            handle.Dispose();
            throw new WindowsFault("process-changed", "The process changed after DevShift checked it.");
        }
        return handle;
    }

    internal static object Close(int pid, string started)
    {
        using var process = Open(pid, started, 0);
        var windows = new List<nint>();
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out var owner);
            if (owner == (uint)pid && IsWindowVisible(window) && GetWindow(window, GwOwner) == 0) windows.Add(window);
            return true;
        }, 0);
        foreach (var window in windows) PostMessageW(window, WmClose, 0, 0);
        return new { changed = windows.Count > 0, windows = windows.Count };
    }

    // The event reaches every process attached to the target's console, as pressing the keys there would.
    internal static object Signal(int pid, string started, string kind)
    {
        using var process = Open(pid, started, 0);
        // Bind the reply stream to the pipe from DevShift before switching consoles.
        Console.Out.Flush();
        FreeConsole();
        if (!AttachConsole((uint)pid))
            throw new WindowsFault("no-console", "It isn't running in a console window, so DevShift can't send Ctrl+C.");
        try
        {
            SetConsoleCtrlHandler(0, true);
            if (!GenerateConsoleCtrlEvent(kind == "ctrl-c" ? 0u : 1u, 0))
                throw new WindowsFault("signal-failed", "Windows could not send Ctrl+C to the console.");
            Thread.Sleep(250);
        }
        finally
        {
            FreeConsole();
        }
        return new { changed = true };
    }

    internal static object Terminate(int pid, string started)
    {
        using var process = Open(pid, started, TerminateAccess);
        if (!TerminateProcess(process, 1))
            throw new WindowsFault("process-access", "Windows denied DevShift permission to stop the process.");
        return new { changed = true };
    }

    // cmd /k keeps the window open after the command exits, so its output stays visible.
    internal static object LaunchConsole(string encoded, JsonSerializerOptions json)
    {
        ConsoleLaunch? launch;
        try { launch = JsonSerializer.Deserialize<ConsoleLaunch>(Convert.FromBase64String(encoded), json); }
        catch (Exception error) when (error is FormatException or JsonException) { launch = null; }
        if (launch is null || launch.Args is null || launch.Args.Length > 256 || launch.Title is null || launch.Title.Length > 200
            || !Path.IsPathFullyQualified(launch.Executable ?? "") || !Path.IsPathFullyQualified(launch.Cwd ?? ""))
            throw new WindowsFault("invalid-request", "Windows helper rejected the request.");
        if (!File.Exists(launch.Executable))
            throw new WindowsFault("launch-failed", "The program the command uses is no longer installed.");
        if (!Directory.Exists(launch.Cwd))
            throw new WindowsFault("folder-missing", "The project folder no longer exists.");

        var command = string.Join(' ', new[] { launch.Executable }.Concat(launch.Args).Select(Quote));
        var title = UnsafeTitle().Replace(launch.Title, "").Trim();
        var shell = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var line = new StringBuilder($"\"{shell}\" /d /s /k \"title {(title.Length > 0 ? title : "DevShift")} & {command}\"");
        var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>() };
        // The "ignore Ctrl+C" flag is inherited. Clear it so the new terminal and the command in it respond to Ctrl+C.
        SetConsoleCtrlHandler(0, false);
        if (!CreateProcessW(null, line, 0, 0, false, CreateNewConsole, 0, launch.Cwd, ref startup, out var created))
            throw new WindowsFault("launch-failed", $"Windows could not open a terminal (error {Marshal.GetLastWin32Error()}).");
        CloseHandle(created.Process);
        CloseHandle(created.Thread);
        return new { changed = true, pid = created.ProcessId };
    }

    // Quotes the way CommandLineToArgvW parses, and also quotes cmd metacharacters.
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny([' ', '\t', '"', '&', '|', '<', '>', '^', '(', ')', '%', '!']) < 0) return value;
        var builder = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') builder.Append('\\', backslashes * 2 + 1);
            else builder.Append('\\', backslashes);
            builder.Append(character);
            backslashes = 0;
        }
        return builder.Append('\\', backslashes * 2).Append('"').ToString();
    }

    // x64 layout: PEB.ProcessParameters is at 0x20, and RTL_USER_PROCESS_PARAMETERS.CurrentDirectory is at 0x38.
    internal static string? CurrentDirectory(int pid)
    {
        using var handle = OpenProcess(QueryLimited | VmRead, false, pid);
        if (handle.IsInvalid || !IsWow64Process(handle, out var wow32) || wow32) return null;
        if (NtQueryInformationProcess(handle, 0, out var basic, Marshal.SizeOf<ProcessBasicInformation>(), out _) != 0
            || basic.PebBaseAddress == 0) return null;
        var pointer = new byte[8];
        if (!ReadProcessMemory(handle, basic.PebBaseAddress + 0x20, pointer, 8, out _)) return null;
        var parameters = (nint)BitConverter.ToInt64(pointer);
        var directory = new byte[16];
        if (parameters == 0 || !ReadProcessMemory(handle, parameters + 0x38, directory, 16, out _)) return null;
        var length = BitConverter.ToUInt16(directory, 0);
        var buffer = (nint)BitConverter.ToInt64(directory, 8);
        if (length is 0 or > 32766 || buffer == 0) return null;
        var text = new byte[length];
        if (!ReadProcessMemory(handle, buffer, text, length, out _)) return null;
        var path = Encoding.Unicode.GetString(text);
        if (path.Length > 3) path = path.TrimEnd('\\');
        return Path.IsPathFullyQualified(path) ? path : null;
    }

    private delegate bool EnumWindowsProc(nint window, nint parameter);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string? Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow, Reserved2Size;
        public nint Reserved2, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public nint Process, Thread;
        public int ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public nint ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWow64Process(SafeProcessHandle process, [MarshalAs(UnmanagedType.Bool)] out bool wow64);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(SafeProcessHandle process, nint address, byte[] buffer, nint size, out nint read);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtQueryInformationProcess(SafeProcessHandle process, int informationClass,
        out ProcessBasicInformation information, int length, out int returned);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(uint pid);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleCtrlHandler(nint handler, [MarshalAs(UnmanagedType.Bool)] bool add);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroup);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string? application, StringBuilder commandLine, nint processAttributes,
        nint threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, nint environment,
        string? directory, ref StartupInfo startup, out ProcessInformation information);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern uint GetWindowThreadProcessId(nint window, out uint pid);

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern nint GetWindow(nint window, uint command);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(nint window, uint message, nint wParam, nint lParam);
}
