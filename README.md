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

Your dev stack doesn't need to keep running while you play. Database services, dev servers, and a balanced power plan compete with your game for CPU, memory, and power. DevShift shows you what's running, stops the workloads you approve when you switch to **Gaming Mode**, and restores them when you switch back to **Development Mode**.

Every switch is previewed before anything changes and journaled to disk, so an interrupted switch can be resumed or closed the next time DevShift starts.

> [!WARNING]
> DevShift is an early alpha and manages a narrow set of workloads today. Expect rough edges.

## What it does today

- **Live dashboard.** System-wide CPU and memory sampled every second, plus the development tools running right now: editors, runtimes, databases, Docker, WSL, emulators, and build tools.
- **Database services.** Stops approved SQL Server, PostgreSQL, MySQL, MariaDB, MongoDB, Redis, and Memurai services in dependency order, and starts them again when you return. This needs start and stop permission on each service, which usually means running DevShift as administrator.
- **Node projects.** Stops and relaunches Node projects that you launch through DevShift and that register a shutdown handler. See [Node projects](#node-projects).
- **Power plans.** Optionally activates a gaming power plan and restores your original plan afterward.
- **Crash-safe recovery.** If a switch is interrupted, DevShift offers to resume it, restore your setup, or keep the current state on its next start.
- **Activity history, a tray menu, and a portable build.**

### Not yet

DevShift shows these on the dashboard, but doesn't stop or restart them yet:

- Docker Desktop and WSL
- Editors and IDEs, such as VS Code and JetBrains IDEs
- Android emulators
- Dev servers started from a terminal, such as `npm run dev`, `vite`, or `next dev`

Windows 11 power modes, a way to control services without running as administrator, and start at sign-in are also planned. See the [roadmap](#roadmap).

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

1. Open **Workloads** and approve the services you want DevShift to manage.
2. To manage a Node project, choose **Add Node workload**, select its `node.exe` and entry file, then **Launch** it. The project needs a [shutdown handler](#node-projects).
3. Optionally, choose a gaming power plan in **Settings**.
4. Choose **Gaming**, review what will stop and what stays running, and confirm.
5. Choose **Development** to restore. **Activity** shows which actions succeeded, failed, or were skipped.

You can also switch from the tray icon. Press <kbd>F5</kbd> to refresh, <kbd>Ctrl</kbd>+<kbd>1</kbd> through <kbd>Ctrl</kbd>+<kbd>3</kbd> to change views, and <kbd>Ctrl</kbd>+<kbd>,</kbd> to open Settings.

## Node projects

DevShift stops Node projects cooperatively. It asks the project to shut down over an authenticated local channel, and the project closes its own listeners and connections. Register the handler once the project is ready to serve requests:

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
- **Respect your changes.** If you change a service or power plan while gaming, restoring leaves your change in place.
- **No elevation, no telemetry.** DevShift never asks for administrator rights and sends nothing over the network. Raw command lines never reach the UI, journal, or history, and Node control keys are encrypted with Windows DPAPI.

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

- Broader switching: Docker Desktop, WSL, editors, emulators, and dev servers started outside DevShift
- Lower resource use, especially while DevShift waits in the tray
- Windows 11 power modes, and service control without running as administrator
- Setup Studio, for installing and configuring development tools
- Portable profiles that sync between your PCs, with an optional account. DevShift will never require an account.
- Automatic rules, such as switching when a game starts
- Opt-in performance history

## Contributing

Contributions are welcome, from bug reports to support for new workloads.

- New here? Start with an issue labeled [good first issue](https://github.com/haseebahmed248/devshift/labels/good%20first%20issue) or [help wanted](https://github.com/haseebahmed248/devshift/labels/help%20wanted).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and the pull request checklist.
- Ask questions and share ideas in [Discussions](https://github.com/haseebahmed248/devshift/discussions).
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Icons from [Lucide](https://lucide.dev) are used under the [ISC license](assets/lucide-LICENSE.txt).
