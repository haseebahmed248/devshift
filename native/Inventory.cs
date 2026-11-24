using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace DevShift.Windows;

internal sealed record ProcessInfo(
    string Name, int Pid, int ParentPid, string? Path, string? Started, ulong? MemoryBytes, ulong? PrivateMemoryBytes, long? CpuTicks,
    string[]? Args, string? Cwd);
internal sealed record InstalledTool(string Name, string? Version, string Source);

internal static partial class Inventory
{
    [GeneratedRegex(@"^(node|node64|python(?:w|\d+(?:\.\d+)?)?|dotnet|javaw?|deno|bun)\.exe$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RuntimeExecutable();

    [GeneratedRegex(@"^(node|node64|python(?:w|\d+(?:\.\d+)?)?|dotnet|javaw?|deno|bun|devenv|ssms|code(?: - insiders)?|idea64|webstorm64|pycharm64|rider64|clion64|goland64|phpstorm64|rubymine64|datagrip64|rustrover64|studio64|fleet|sqlservr|postgres|pg_ctl|mysqld|mariadbd|mongod|redis-server|memurai|docker desktop|com\.docker\.backend|docker|wsl|wslhost|wslservice|vmmemwsl|msbuild|cmake|ninja|gradle|mvn|tsc|adb|emulator|qemu-system-.+|iisexpress|mspdbsrv|vbcscompiler)\.exe$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    internal static partial Regex DevelopmentExecutable();

    [GeneratedRegex(@"^(?:Microsoft\s+)?(?:Visual Studio (?:Code|Community|Professional|Enterprise|Build Tools)|JetBrains Toolbox|IntelliJ IDEA|WebStorm|PyCharm|Rider|CLion|GoLand|PhpStorm|RubyMine|DataGrip|RustRover|Android Studio|Node\.js|Python \d|\.NET SDK|OpenJDK|Java (?:SE|Development)|Eclipse Temurin|Microsoft SQL Server|SQL Server (?:\d|Management)|PostgreSQL|MySQL|MariaDB|MongoDB|Redis|Memurai|Docker Desktop|Windows Subsystem for Linux|CMake|Ninja|Git)(?:\b|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DevelopmentInstallation();

    internal static ManagementObjectCollection Query(ManagementObjectSearcher searcher) => searcher.Get();

    private static Dictionary<int, ulong> PrivateWorkingSets(int? processId)
    {
        var values = new Dictionary<int, ulong>();
        var query = "SELECT IDProcess, WorkingSetPrivate FROM Win32_PerfRawData_PerfProc_Process";
        if (processId is int id) query += $" WHERE IDProcess = {id}";
        try
        {
            using var searcher = new ManagementObjectSearcher(query);
            using var rows = Query(searcher);
            foreach (ManagementObject row in rows)
            {
                using (row)
                {
                    if (row["IDProcess"] is uint pid && pid is > 0 and <= int.MaxValue && row["WorkingSetPrivate"] is ulong bytes)
                        values[(int)pid] = bytes;
                }
            }
        }
        catch (Exception error) when (error is ManagementException or UnauthorizedAccessException or COMException)
        {
        }
        return values;
    }

    internal static ProcessInfo[] Processes(int? processId = null)
    {
        var query = "SELECT Name, ProcessId, ParentProcessId, ExecutablePath, CreationDate, CommandLine, WorkingSetSize FROM Win32_Process";
        if (processId is int id) query += $" WHERE ProcessId = {id}";
        using var searcher = new ManagementObjectSearcher(query);
        using var rows = Query(searcher);
        var privateMemory = PrivateWorkingSets(processId);
        var result = new List<ProcessInfo>();
        foreach (ManagementObject row in rows)
        {
            using (row)
            {
                var name = (string?)row["Name"] ?? "";
                var pid = Convert.ToInt32(row["ProcessId"]);
                // Memory is read for every process so an editor's helper processes count toward its total.
                var workingSet = row["WorkingSetSize"] as ulong?;
                ulong? privateBytes = privateMemory.TryGetValue(pid, out var bytes) ? bytes : null;
                if (!DevelopmentExecutable().IsMatch(name))
                {
                    result.Add(new(name, pid, Convert.ToInt32(row["ParentProcessId"]), null, Creation(row), workingSet, privateBytes, null, null, null));
                    continue;
                }

                long? cpu = null;
                try
                {
                    using var process = Process.GetProcessById(pid);
                    cpu = process.TotalProcessorTime.Ticks;
                }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                }

                result.Add(new(
                    name, pid, Convert.ToInt32(row["ParentProcessId"]),
                    row["ExecutablePath"] as string, Creation(row), workingSet, privateBytes, cpu,
                    Arguments(row["CommandLine"] as string),
                    RuntimeExecutable().IsMatch(name) ? Control.CurrentDirectory(pid) : null));
            }
        }

        return [.. result];
    }

    private static string? Creation(ManagementObject row) => row["CreationDate"] is string value
        ? ManagementDateTimeConverter.ToDateTime(value).ToUniversalTime().ToString("O")
        : null;

    internal static string[]? Arguments(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return null;
        var argv = CommandLineToArgvW(commandLine, out int count);
        if (argv == IntPtr.Zero) return null;
        try
        {
            var args = new string[count];
            for (var index = 0; index < count; index++)
                args[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size)) ?? "";
            return args;
        }
        finally { LocalFree(argv); }
    }

    internal static InstalledTool[] Installed()
    {
        var result = new Dictionary<string, InstalledTool>(StringComparer.OrdinalIgnoreCase);
        const string uninstall = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var baseKey = RegistryKey.OpenBaseKey(hive, view);
            using var root = baseKey.OpenSubKey(uninstall);
            foreach (var subkey in root?.GetSubKeyNames() ?? [])
            {
                try
                {
                    using var item = root!.OpenSubKey(subkey);
                    if (item?.GetValue("DisplayName") is string name && DevelopmentInstallation().IsMatch(name))
                        result.TryAdd(name, new(name, item.GetValue("DisplayVersion") as string, "Installed applications"));
                }
                catch (UnauthorizedAccessException) { }
            }
        }

        (string File, string Label)[] tools = [
            ("node.exe", "Node.js"), ("python.exe", "Python"), ("dotnet.exe", ".NET"),
            ("java.exe", "Java"), ("docker.exe", "Docker CLI"), ("git.exe", "Git"),
            ("redis-server.exe", "Redis"), ("adb.exe", "Android Debug Bridge"),
            ("cmake.exe", "CMake"), ("ninja.exe", "Ninja"), ("msbuild.exe", "MSBuild")
        ];
        var directories = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
        foreach (var (file, label) in tools)
        {
            if (result.Keys.Any(name => name.StartsWith(label, StringComparison.OrdinalIgnoreCase))) continue;
            if (directories.Any(directory =>
            {
                var normalized = directory.Trim().Trim('"');
                return Path.IsPathFullyQualified(normalized)
                    && !normalized.Contains(@"\Microsoft\WindowsApps", StringComparison.OrdinalIgnoreCase)
                    && File.Exists(Path.Combine(normalized, file));
            }))
                result.TryAdd(label, new(label, null, "Executable on PATH"));
        }

        using var wsl = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss");
        if (wsl?.GetSubKeyNames().Any(name => Guid.TryParse(name, out _)) == true)
            result.TryAdd("Windows Subsystem for Linux", new("Windows Subsystem for Linux", null, "Registered distributions"));

        return [.. result.Values.OrderBy(tool => tool.Name, StringComparer.OrdinalIgnoreCase)];
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    internal static extern IntPtr LocalFree(IntPtr memory);
}
