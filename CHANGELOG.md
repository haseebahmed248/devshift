# Changelog

Notable changes to DevShift are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and DevShift uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Setting to start DevShift automatically when Windows starts, minimized directly to the tray.

## 0.1.0 - 2026-11-24

First public version.

### Added

- Live dashboard with system-wide CPU and memory sampled every second, plus discovery of running editors, runtimes, databases, Docker, WSL, emulators, and build tools.
- Gaming Mode and Development Mode, which stop and restore approved database services in dependency order.
- Graceful shutdown and relaunch for Node projects launched through DevShift.
- Optional gaming power plan, restored when you switch back.
- Crash-safe recovery journal, so an interrupted switch can be resumed or closed on the next start.
- Activity history, a tray menu, keyboard shortcuts, and a portable Windows build.
