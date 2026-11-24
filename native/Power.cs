using System.Runtime.InteropServices;
using System.Text;

namespace DevShift.Windows;

internal sealed record PowerPlan(Guid Id, string Name);
internal sealed record PowerState(Guid Active, PowerPlan[] Plans);
internal sealed record PowerModeState(Guid Ac, Guid Dc, bool PluggedIn, bool EnergySaver);

// Windows keeps separate power mode settings for plugged in (AC) and battery (DC). These are the user settings,
// not the mode Energy Saver forces while it is on.
internal static class PowerMode
{
    internal static PowerModeState? Scan()
    {
        try
        {
            if (PowerGetUserConfiguredACPowerMode(out var ac) != 0 || PowerGetUserConfiguredDCPowerMode(out var dc) != 0) return null;
            var known = GetSystemPowerStatus(out var status);
            return new(ac, dc, known && status.AcLineStatus == 1, known && status.SystemStatusFlag == 1);
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }
    }

    internal static object Change(Guid expectedAc, Guid expectedDc, Guid nextAc, Guid nextDc)
    {
        var current = Scan() ?? throw new WindowsFault("power-mode-unavailable", "Windows power modes are unavailable on this PC.");
        if (current.Ac == nextAc && current.Dc == nextDc) return new { changed = false };
        if (current.Ac != expectedAc || current.Dc != expectedDc)
            throw new WindowsFault("state-changed", "The power mode changed in Windows.");
        if (current.Ac != nextAc) Check(PowerSetUserConfiguredACPowerMode(ref nextAc));
        if (current.Dc != nextDc) Check(PowerSetUserConfiguredDCPowerMode(ref nextDc));
        var updated = Scan();
        if (updated is null || updated.Ac != nextAc || updated.Dc != nextDc)
            throw new WindowsFault("verify-power-mode", "Windows did not report the requested power mode.");
        return new { changed = true };
    }

    private static void Check(uint result)
    {
        if (result != 0) throw new WindowsFault("power-mode-apply", $"Windows could not change the power mode (error {result}).");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte AcLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public uint BatteryLifeTime, BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerGetUserConfiguredACPowerMode(out Guid mode);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerGetUserConfiguredDCPowerMode(out Guid mode);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerSetUserConfiguredACPowerMode(ref Guid mode);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerSetUserConfiguredDCPowerMode(ref Guid mode);
}

internal static class Power
{
    private const uint AccessScheme = 16;
    private const uint NoMoreItems = 259;

    internal static PowerState Scan()
    {
        var active = Active();
        var plans = new List<PowerPlan>();
        for (uint index = 0; index < 256; index++)
        {
            uint size = 16;
            var result = PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, AccessScheme, index, out var plan, ref size);
            if (result == NoMoreItems) break;
            Check(result, "list");
            plans.Add(new(plan, Name(plan)));
        }

        return new(active, [.. plans]);
    }

    internal static object Change(Guid before, Guid after)
    {
        var current = Active();
        if (current == after) return new { changed = false };
        if (current != before)
            throw new WindowsFault("state-changed", "The active power plan changed in Windows.");
        if (!Scan().Plans.Any(plan => plan.Id == after))
            throw new WindowsFault("plan-missing", "The selected power plan is unavailable.");

        Check(PowerSetActiveScheme(IntPtr.Zero, ref after), "apply");
        if (Active() != after)
            throw new WindowsFault("verify-power", "Windows did not report the requested active power plan.");
        return new { changed = true };
    }

    private static Guid Active()
    {
        Check(PowerGetActiveScheme(IntPtr.Zero, out var address), "read");
        try { return Marshal.PtrToStructure<Guid>(address); }
        finally { Inventory.LocalFree(address); }
    }

    private static string Name(Guid plan)
    {
        uint size = 0;
        var result = PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, null, ref size);
        if ((result != 0 && result != 234) || size is 0 or > 8192) return plan.ToString();
        var bytes = new byte[size];
        return PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, bytes, ref size) == 0
            ? Encoding.Unicode.GetString(bytes).TrimEnd('\0')
            : plan.ToString();
    }

    private static void Check(uint result, string operation)
    {
        if (result != 0)
            throw new WindowsFault("power-" + operation, $"Windows could not {operation} the power plan (error {result}).");
    }

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr plan);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerSetActiveScheme(IntPtr root, ref Guid plan);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerEnumerate(
        IntPtr root, IntPtr plan, IntPtr subgroup, uint accessor, uint index, out Guid buffer, ref uint size);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerReadFriendlyName(
        IntPtr root, ref Guid plan, IntPtr subgroup, IntPtr settings, [Out] byte[]? buffer, ref uint size);
}
