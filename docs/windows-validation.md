# Windows validation

## Host

Windows 11 Home x64 build 26300, Intel Core Ultra 9 185H with 22 logical processors, and 31.61 GiB of visible memory. The normal test shell used a standard-user token. Windows exposed one power plan, Balanced, before and after testing. The discovery helper reported eight installed tool entries and zero supported service candidates on the original system.

## Results

| Run | Result |
| --- | --- |
| `npm.cmd test` | 8 passed. Covers editor grouping, partial measurements, process classification, approval and identity checks, dependency order, snapshot serialization, restoration, and safe recovery. |
| `npm.cmd run test:windows` | 4 passed. Verified native Windows discovery, editor grouping, splash and navigation behavior, independent live CPU and RAM readings, renderer isolation, and confirmed switching. |
| `node.exe --test tests/windows-power.test.mjs` | 1 passed. Selected a temporary duplicate of Balanced, restored the original GUID, and deleted the duplicate. |
| `npm.cmd run package:windows` | Built the branded x64 portable package. |
| Packaged DevShift.exe desktop suite | 4 passed against the distributable, including both confirmed logo animations, compact rail selection, reduced motion, scheduled inventory refresh, the covered-window measurement, and normal exit. |
| Controlled administrator SCM test | 1 passed. Two temporary services verified dependent-first stop, prerequisite-first start, and cleanup. |

The original desktop suite launched a loopback Node server at PID 14196, verified that Gaming Mode stopped it, and verified Development Mode relaunched it at PID 6076. It then interrupted the isolated DevShift process during a second graceful stop and restored the server at PID 20400 from the durable SQLite journal. The unrelated fixture at PID 14112 stayed responsive throughout. Normal application exit left both fixture servers running. The packaged build repeated the sequence with managed PIDs 13708, 14056, and 22736 while the unrelated fixture at PID 5600 stayed responsive. The harness cleaned up the servers and profiles.

The native helper rejected a stop request for Print Spooler before reaching the Service Control Manager write path. The administrator integration test created two temporary demand-start services running as LocalService. With only the prerequisite approved, the preview blocked its stop. With both approved, DevShift stopped the dependent first and restored the prerequisite first. The harness verified both services were removed.

## Remaining verification

A real project's shutdown handler and any production database service require a planned session with the selected workload and its actual Windows permissions. Interactive tray actions can be checked in the installed Windows shell.

## Workload grouping and motion

Windows initially reported ten Code.exe PIDs, matching an independent process listing. PID 10692 was the common parent of the other nine. Their process-type switches identified three renderers, one GPU process, and five utilities. A subsequent scan found an eleventh Code.exe process. DevShift reads the PID, parent, creation time, working set, and CPU time from Windows. Built-in executable rules supply the supported tool labels.

The workload table groups an observed editor with descendants from the same executable path and a valid parent lifetime. The group includes each member once. Memory shows the Windows private working set, and each process inspector also exposes the full working set. Full working sets can include the same shared pages in multiple processes. An unavailable reading leaves the corresponding total blank. [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information)

An independent Windows Performance Monitor query matched all eleven native scan PIDs. The successive reads returned 1,474.1 MiB and 1,454.8 MiB of private working set, respectively. A further check queried the same eleven process handles throughout a packaged scan. DevShift returned 1,485.89 MiB. Fifteen direct Windows readings ranged from 1,480.89 to 1,486.10 MiB. The desktop test separately checked the rendered group total against the sum from the same scan and expanded the group to inspect its PIDs. [Windows process memory structure](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2)

The desktop test starts the app twice in an isolated profile. It checks the real splash before the workbench accepts input, navigation and filter animations, process expansion and collapse, and a cold launch with reduced motion enabled. The native caption controls stay available during the splash. The active navigation icon has a 33 × 28 logical-pixel tile inside a 44–46 pixel-high button. The test checks all three sidebar icons and the Refresh icon, then uses Refresh to request a new workload scan. Both the native splash and the finished workbench were opened in the normal profile. [Sidebar with Activity selected](images/DevShift-activity-sidebar.png)

The packaged test checks both Lucide icons in the mode selector. [Mode selector](images/DevShift-mode-controls.png) · [Gamepad](https://lucide.dev/icons/gamepad-2) · [Terminal](https://lucide.dev/icons/square-terminal)

During a disposable Node server's stop and restoration, the test measures the logo animation in each direction. It checks that cancelling a preview leaves the animation unplayed, both directions render statically with reduced motion, and the approved action stays pending until the engine publishes current progress. [Gaming switch](images/DevShift-gaming-switch.png) · [Development restoration](images/DevShift-development-switch.png)

## Live CPU and physical memory

On Windows 11 build 26300, the dashboard samples the Windows Processor Information total processor-time counter every second. The first CPU reading uses two counter collections. Each memory reading uses the total and available physical bytes returned together by GlobalMemoryStatusEx. The dashboard displays their difference in binary gigabytes to one decimal place, alongside the percentage. Windows Task Manager and DevShift have independent refresh clocks. [Windows counter sampling](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcountervalue) · [Windows physical memory definitions](https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information)

The regression test covered the entire DevShift test window, set its workload scan interval to 60 seconds, and briefly allocated 128 MiB inside the test process. It compared eight successive dashboard samples against independent Windows per-processor idle, kernel and user times and available physical memory queried through Node. The workload scan timestamp stayed fixed. The test also verified the displayed percentages, the used RAM text, and a fresh CPU baseline after minimize and restore.

| Covered-window measurement | Development build | Portable executable |
| --- | ---: | ---: |
| Time between samples | 1,000–1,009 ms | 1,000–1,015 ms |
| Mean absolute CPU difference | 1.33 percentage points | 1.22 percentage points |
| Largest absolute CPU difference | 2.79 percentage points | 2.07 percentage points |
| Largest absolute RAM difference | 0.95 MiB | 0.69 MiB |

A second check paired the packaged native sampler with Windows Performance Monitor through PowerShell Get-Counter. Across eight pairs collected 2–4 ms apart, the mean absolute CPU difference was 0.287 percentage points, the largest CPU difference was 1.003 points, and the largest RAM difference was 0.844 MiB. The normal portable application was then reopened with its existing profile and its live readouts were verified in the desktop window.

## Earlier runtime measurements

Before the one-second sampler was introduced, the redesigned desktop was sampled for 6.01 seconds with the dashboard visible and the test scan interval set to five seconds. Four persistent Electron processes used 488.0 MiB combined working set and 80 ms CPU time, about 0.060% normalized across 22 logical processors. Combined working sets can count shared pages more than once. The packaged desktop sample used 470.4 MiB combined working set and 18 ms CPU time over 6.01 seconds, about 0.014% of total logical CPU capacity. Both samples omit the transient .NET helper.

The [dashboard capture](images/DevShift-dashboard.png) shows live values from the test host. Native caption controls are verified through the window controls overlay API and are rendered by Windows outside the web-contents capture.

## Editors, dev servers, build servers, LocalDB, and power modes

Checked on November 24, 2026, on the same host, running on battery with Energy Saver on. Every check used disposable targets.

| Check | Result |
| --- | --- |
| Close by identity | The helper refused a close request with a wrong start time. With the correct identity, it posted WM_CLOSE to the target's one window, and the process exited. |
| Ctrl+C | A dev server in a terminal that DevShift opened stopped after Ctrl+C. The terminal opened in the requested folder, and the scan read that folder back. |
| Power mode | Both the plugged-in and battery settings switched to Best performance. A request with stale expectations was refused, and both settings were restored exactly. |
| Preview | The Gaming preview found 227 MB of idle .NET build servers and the throwaway dev server. It kept VS Code out because DevShift was running from it. |
| Desktop suite | The switching, recovery, and normal-exit test passed. The covered-window measurement timed out on this host on the original 0.1 code as well, so that failure predates this change. |

Two Windows behaviors shaped the design. A terminal inherits the "ignore Ctrl+C" flag from the process that creates it, so the helper clears that flag before opening one. While Energy Saver is on, Windows reports its power-saving mode as the effective power mode, so DevShift reads and writes the stored plugged-in and battery settings instead.
