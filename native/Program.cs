using System.ComponentModel;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DevShift.Windows;

internal sealed class WindowsFault(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal static partial class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [GeneratedRegex("^[a-zA-Z0-9_$.-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex ServiceName();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Digest();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$", RegexOptions.CultureInvariant)]
    private static partial Regex StartTime();

    [GeneratedRegex("^[A-Za-z0-9+/]{4,60000}={0,2}$", RegexOptions.CultureInvariant)]
    private static partial Regex Base64();

    private static bool ProcessArguments(string pid, string started, out int id) =>
        int.TryParse(pid, out id) && id > 0 && StartTime().IsMatch(started);

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args is ["monitor"]) return SystemPerformance.Monitor(Json);
            object? value = args switch
            {
                ["scan"] => new
                {
                    processes = Inventory.Processes(),
                    services = Services.Scan(),
                    power = Power.Scan(),
                    powerMode = PowerMode.Scan(),
                    installed = Inventory.Installed(),
                    build = Environment.OSVersion.Version.Build
                },
                ["scan-live"] => new
                {
                    processes = Inventory.Processes(),
                    services = Services.Scan(),
                    power = Power.Scan(),
                    powerMode = PowerMode.Scan(),
                    installed = Array.Empty<InstalledTool>(),
                    build = Environment.OSVersion.Version.Build
                },
                ["process", var pid] when int.TryParse(pid, out int processId) && processId > 0
                    => Inventory.Processes(processId).FirstOrDefault(),
                ["service", var action, var name, var digest, var expectedPid]
                    when action is "start" or "stop" && ServiceName().IsMatch(name) && Digest().IsMatch(digest)
                    && int.TryParse(expectedPid, out var id) && id >= 0
                    => Services.Change(action, name, digest, id),
                ["power", var before, var after] when Guid.TryParseExact(before, "D", out var oldPlan)
                    && Guid.TryParseExact(after, "D", out var newPlan) => Power.Change(oldPlan, newPlan),
                ["power-mode", var expectedAc, var expectedDc, var nextAc, var nextDc]
                    when Guid.TryParseExact(expectedAc, "D", out var oldAc) && Guid.TryParseExact(expectedDc, "D", out var oldDc)
                    && Guid.TryParseExact(nextAc, "D", out var newAc) && Guid.TryParseExact(nextDc, "D", out var newDc)
                    => PowerMode.Change(oldAc, oldDc, newAc, newDc),
                ["close", var pid, var started] when ProcessArguments(pid, started, out var target)
                    => Control.Close(target, started),
                ["signal", var pid, var started, var kind] when ProcessArguments(pid, started, out var target)
                    && kind is "ctrl-c" or "ctrl-break" => Control.Signal(target, started, kind),
                ["terminate", var pid, var started] when ProcessArguments(pid, started, out var target)
                    => Control.Terminate(target, started),
                ["launch-console", var payload] when Base64().IsMatch(payload) => Control.LaunchConsole(payload, Json),
                _ => throw new WindowsFault("invalid-request", "Windows helper rejected the request.")
            };
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, value }, Json));
            return 0;
        }
        catch (IOException) when (args is ["monitor"])
        {
            return 0;
        }
        catch (WindowsFault fault)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ok = false, code = fault.Code, message = fault.Message }, Json));
            return 1;
        }
        catch (Exception exception)
        {
            var code = exception is Win32Exception win32 ? win32.NativeErrorCode : exception.HResult;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                code = "windows-error",
                message = $"Windows returned error {code}."
            }, Json));
            return 1;
        }
    }
}
