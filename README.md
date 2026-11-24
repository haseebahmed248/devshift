<p align="center">
  <img src="assets/devshift.png" alt="DevShift logo" width="96">
</p>

<h1 align="center">DevShift</h1>

<p align="center">
  Switch your Windows PC from development to gaming and back, without losing track of what was running.
</p>

<p align="center">
  <a href="https://github.com/haseebahmed248/devshift/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/haseebahmed248/devshift/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Windows 11 x64" src="https://img.shields.io/badge/Windows%2011-x64-0078D4">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44f">
  <img alt="Early alpha" src="https://img.shields.io/badge/status-early%20alpha-orange">
</p>

<p align="center">
  <img src="docs/images/DevShift-window.png" alt="DevShift in Development Mode, showing live CPU and memory charts, running workloads, and the mode switch" width="900">
</p>

Your dev stack doesn't need to keep running while you play. Editors, dev servers, build servers, and databases hold gigabytes of memory, and a balanced power mode holds back your game. **Gaming Mode** closes and stops them, and **Development Mode** brings everything back the way it was.

Every switch is previewed before anything changes and journaled to disk, so an interrupted switch can be resumed or closed the next time DevShift starts.

> [!WARNING]
> DevShift is an early alpha. Expect rough edges.

## What it does today

- **Editors.** Closes VS Code, Visual Studio, SQL Server Management Studio, and JetBrains IDEs as if you closed their windows, then reopens them when you switch back. VS Code keeps your unsaved files. If an editor asks you to save, DevShift leaves it open.
- **Dev servers.** Stops commands such as `npm run dev`, `vite`, `next dev`, `dotnet watch`, or `manage.py runserver` with Ctrl+C, then runs each one again in a terminal window, in the same folder, when you return.
- **Build servers and LocalDB.** Stops idle .NET build and compiler servers and SQL Server LocalDB. Both start again on their own when something needs them.
- **Power.** Switches Windows 11 to the Best performance power mode while you play, and can also activate a gaming power plan. Both are restored afterward.
- **A preview you control.** The preview shows what each action frees in memory. Untick anything you want to keep running, and DevShift remembers your choice next time.
- **Database services.** Stops approved SQL Server, PostgreSQL, MySQL, MariaDB, MongoDB, Redis, and Memurai services in dependency order, and starts them again when you return. This needs start and stop permission on each service, which usually means running DevShift as administrator.
- **Crash-safe recovery.** If a switch is interrupted, DevShift offers to resume it, restore your setup, or keep the current state on its next start.
- **Live dashboard, activity history, a tray menu, and a portable build.**

### Not yet

- Docker Desktop and WSL
- Android emulators
- Controlling Windows services without running as administrator
- Starting DevShift when Windows starts

See the [roadmap](#roadmap).

## Install

There are no prebuilt releases yet. To build from source, you need:

- Windows 11 x64
- [Node.js](https://nodejs.org/) 24.19 or later, or 26 LTS
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)

```powershell
git clone https://github.com/haseebahmed248/devshift.git
cd devshift
npm.cmd ci
npm.cmd start
```

> [!TIP]
> These commands use `npm.cmd` because PowerShell's default execution policy can block `npm`. In Command Prompt or Git Bash, plain `npm` works too.

To build a portable copy, run `npm.cmd run package:windows`, then open `out\DevShift-win32-x64\DevShift.exe`. Keep the folder together. It includes Electron and the self-contained Windows helper.

## Use it

1. Choose **Gaming**. The preview lists what DevShift will close or stop and how much memory each frees. Untick anything you want to keep, then confirm.
2. When you're done playing, choose **Development**. DevShift reopens your editors, restarts your dev servers, and restores your power settings. **Activity** shows which actions succeeded, failed, or were skipped.

Optional setup:

- To include Windows database services, approve them in **Workloads**.
- To change the gaming power mode or add a gaming power plan, open **Settings**.
- For a Node project that needs a verified graceful shutdown, choose **Add Node workload**. See [Node projects](#node-projects).

You can also switch from the tray icon. Press <kbd>F5</kbd> to refresh, <kbd>Ctrl</kbd>+<kbd>1</kbd> through <kbd>Ctrl</kbd>+<kbd>3</kbd> to change views, and <kbd>Ctrl</kbd>+<kbd>,</kbd> to open Settings.

## Node projects

Dev servers you start from a terminal need no setup. For a project that must finish its own cleanup before stopping, register it with DevShift instead. DevShift then asks the project to shut down over an authenticated local channel, and the project closes its own listeners and connections. Register the handler once the project is ready to serve requests:

```javascript
const http = require('node:http')

const server = http.createServer((_request, response) => response.end('ready'))
server.listen(3000, '127.0.0.1', () => {
  const module = process.env.DEVSHIFT_SHUTDOWN_MODULE
  if (!module) return
  require(module).registerShutdown(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
})
```

DevShift launches the entry file directly with Node and uses the file's folder as the working directory. A relaunch starts a fresh process, so in-memory state doesn't survive. If the script or `node.exe` changes, DevShift asks you to approve it again before launching.

## How it stays safe

- **Preview first.** Nothing changes until you confirm the preview, and the preview expires if workloads change before you confirm.
- **Journal before acting.** Each action is written to a local SQLite journal before DevShift touches Windows, so an interrupted switch can be recovered.
- **Check identity every time.** Right before each action, DevShift matches processes by PID, start time, and path, and services by a fingerprint of their configuration.
- **Never force.** Editors get the same close request as clicking their close buttons, dev servers get Ctrl+C, and only idle build servers are stopped. Anything that doesn't stop is left running.
- **Respect your changes.** If you change a service, power plan, or power mode while gaming, or reopen an editor yourself, restoring leaves your change in place.
- **No elevation, no telemetry.** DevShift never asks for administrator rights and sends nothing over the network. The commands it needs to restart editors and dev servers are stored only encrypted with Windows DPAPI, and labels in the UI and history never include command arguments.

The journal lives in `%APPDATA%\DevShift`.

## Develop

```powershell
npm.cmd run build                 # type-check, bundle, and build the native helper
npm.cmd test                      # unit tests
npm.cmd run test:windows          # Electron desktop tests in a disposable profile
npm.cmd run test:windows:power    # switches to a temporary copy of your power plan, then restores it
npm.cmd run test:windows:service  # administrator terminal only; creates and removes two test services
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and pull request checklist, and [Windows validation](docs/windows-validation.md) for measured test results.

## Roadmap

- Broader switching: Docker Desktop, WSL, and Android emulators
- Lower resource use, especially while DevShift waits in the tray
- Service control without running as administrator
- Setup Studio, for installing and configuring development tools
- Portable profiles that sync between your PCs, with an optional account. DevShift will never require an account.
- Automatic rules, such as switching when a game starts
- Opt-in performance history

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Icons from [Lucide](https://lucide.dev) are used under the [ISC license](assets/lucide-LICENSE.txt).
