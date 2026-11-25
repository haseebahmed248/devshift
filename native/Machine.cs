using System.ComponentModel;
using System.Runtime.InteropServices;

namespace DevShift.Windows;

internal sealed record CpuSet(int Group, int Index, int EfficiencyClass);

internal static class Machine
{
    private const byte NoBattery = 128;
    private const byte UnknownBattery = 255;

    internal static object Describe()
    {
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref memory)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var known = GetSystemPowerStatus(out var power);
        return new
        {
            totalMemory = memory.TotalPhysical,
            availableMemory = memory.AvailablePhysical,
            commitLimit = memory.TotalPageFile,
            commitAvailable = memory.AvailablePageFile,
            battery = known && power.BatteryFlag != UnknownBattery ? power.BatteryFlag != NoBattery : (bool?)null,
            pluggedIn = known && power.AcLineStatus != 255 ? power.AcLineStatus == 1 : (bool?)null,
            cpuSets = CpuSets(),
            powerMode = PowerMode.Scan()
        };
    }

    // Busy and total time per logical processor in the helper's processor group, in 100 ns units.
    internal static object ProcessorTimes()
    {
        var entries = new ProcessorPerformance[64];
        var size = Marshal.SizeOf<ProcessorPerformance>();
        var status = NtQuerySystemInformation(8, entries, size * entries.Length, out var returned);
        if (status != 0) throw new WindowsFault("windows-error", $"Windows returned status {status:x8}.");
        return entries.Take(returned / size).Select(entry => new
        {
            busy = entry.Kernel + entry.User - entry.Idle,
            total = entry.Kernel + entry.User
        }).ToArray();
    }

    // The buffer is a run of variable-size SYSTEM_CPU_SET_INFORMATION records.
    private static CpuSet[] CpuSets()
    {
        GetSystemCpuSetInformation(null, 0, out var length, 0, 0);
        var buffer = new byte[length];
        if (length == 0 || !GetSystemCpuSetInformation(buffer, length, out length, 0, 0)) return [];
        var sets = new List<CpuSet>();
        for (var offset = 0; offset + 19 <= length;)
        {
            var size = BitConverter.ToInt32(buffer, offset);
            if (size <= 0) break;
            if (BitConverter.ToInt32(buffer, offset + 4) == 0)
                sets.Add(new(BitConverter.ToUInt16(buffer, offset + 12), buffer[offset + 14], buffer[offset + 18]));
            offset += size;
        }
        return [.. sets];
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile;
        public ulong TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte AcLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public uint BatteryLifeTime, BatteryFullLifeTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessorPerformance
    {
        public long Idle, Kernel, User, Dpc, Interrupt;
        public uint InterruptCount;
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemCpuSetInformation(byte[]? information, int length, out int returned, nint process, uint flags);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtQuerySystemInformation(int informationClass, [Out] ProcessorPerformance[] information, int length, out int returned);
}
