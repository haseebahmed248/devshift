# Contributing to DevShift

Thanks for helping. DevShift stops and starts real workloads on people's PCs, so changes are held to a high safety bar. This guide covers setup, the project layout, and what a pull request needs.

For anything bigger than a small fix, open an issue first so we can agree on the approach. To report a security problem, don't open a public issue; follow [SECURITY.md](SECURITY.md) instead. Questions and ideas are welcome in [Discussions](https://github.com/haseebahmed248/devshift/discussions).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Your first contribution

1. Pick an issue labeled [good first issue](https://github.com/haseebahmed248/devshift/labels/good%20first%20issue) or [help wanted](https://github.com/haseebahmed248/devshift/labels/help%20wanted), and comment that you'd like to work on it.
2. Fork the repository, clone your fork, and create a branch from `main`.
3. Make your change and run the tests that match it. See [Tests](#tests).
4. Push the branch to your fork and open a pull request against `main`.

## Set up

You need x64 Windows 11, Node.js 24.19 or later (or 26 LTS), and the .NET 10 SDK. A newer .NET SDK also works.

```powershell
npm.cmd ci
npm.cmd start
```

`npm.cmd start` builds the desktop app and the native helper, then opens DevShift. Your real profile lives in `%APPDATA%\DevShift`. To experiment without touching it, build once and start Electron with a separate profile folder:

```powershell
npx.cmd electron . --user-data-dir=C:\Temp\devshift-profile
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/core` | Discovery and classification, service ordering, the switching state machine, and the SQLite journal. Contains no Electron code and makes no direct Windows calls. |
| `src/main` | Electron main process: the window, tray, IPC handlers, the Windows host adapter, and the Node project runtime. |
| `src/shared` | The IPC contract shared by the main process and the renderer. |
| `src/renderer` | The React UI. It talks to the main process only through the preload API. |
| `native` | The self-contained .NET helper for process and service inventory, Service Control Manager actions, power plans, and performance sampling. |
| `runtime/shutdown.cjs` | The authenticated shutdown bridge loaded into managed Node projects. |
| `tests` | Unit tests in `core.test.mjs`, plus Windows integration tests and their fixtures. |

## Ground rules

- Add explicit IPC methods only. The main process checks the sender and validates every input.
- Keep Windows calls out of the renderer.
- Right before each change to Windows, check process identity (PID, start time, and path), service fingerprints, power-plan state, and dependencies again.
- Write each action's intent to the journal before changing Windows.
- Keep raw command lines, tokens, and secrets out of snapshots, logs, history, and the UI.
- Work within the Windows permissions the user already has. Don't add silent elevation.

## Tests

Run the tests that match your change before opening a pull request:

| Change | Command |
| --- | --- |
| Any change | `npm.cmd test` |
| Engine, IPC, renderer, or Node runtime | `npm.cmd run test:windows` |
| Power plans | `npm.cmd run test:windows:power` |
| Native service control | `npm.cmd run test:windows:service`, from an administrator terminal |

The desktop tests use a disposable profile and loopback Node servers, and they don't touch your services. The power test switches to a temporary copy of your current plan, restores the original, and deletes the copy. The service test creates two temporary services and removes them afterward.

### Measure on your PC

Gaming Mode's defaults depend on numbers from many different PCs. `npm.cmd run measure:actions` measures how much throttling and pausing background apps helps on yours, using only processes it starts. Add `-- --low-memory` to also simulate a PC that's short on memory; other apps may respond slowly for a moment afterwards. Post the output on [#11](https://github.com/haseebahmed248/devshift/issues/11).

## Pull requests

- Keep each pull request focused on one change.
- Explain what changed, why, and how you verified it. The pull request template has a checklist.
- Pull requests are squash-merged, so the title becomes the commit message on `main`. Write it as a short command, such as "Add WSL shutdown to Gaming Mode".
- For changes that users will notice, add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- The maintainer merges a pull request once the **Test and build** check passes and review conversations are resolved.
- CI type-checks, runs the unit tests, and builds the app on Windows. The Windows integration tests need a desktop session, so run them locally.
