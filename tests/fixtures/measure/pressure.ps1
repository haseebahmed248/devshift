# Takes physical memory without using commit, so a low-memory PC can be simulated without risking out-of-memory errors in other apps.
# It maps a temporary file and keeps reading every page. Pages past the file's written data read as zeros, so nothing touches the disk.
# Windows deletes the file when this process exits for any reason.
param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][long]$Megabytes)

Add-Type -ReferencedAssemblies System.Core -TypeDefinition @'
using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Threading;

public static class Pressure
{
    public static void Hold(string path, long bytes)
    {
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose))
        {
            file.SetLength(bytes);
            using (var map = MemoryMappedFile.CreateFromFile(file, null, 0, MemoryMappedFileAccess.Read, null, HandleInheritability.None, true))
            using (var view = map.CreateViewAccessor(0, bytes, MemoryMappedFileAccess.Read))
            {
                long sum = 0;
                var ready = false;
                for (;;)
                {
                    for (long offset = 0; offset < bytes; offset += 4096) sum += view.ReadByte(offset);
                    if (!ready)
                    {
                        Console.WriteLine("ready");
                        Console.Out.Flush();
                        ready = true;
                    }
                    Thread.Sleep(50);
                }
            }
        }
    }
}
'@

[Pressure]::Hold($Path, $Megabytes * 1MB)
