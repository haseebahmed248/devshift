import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus, homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { pid as selfPid } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type {
  AppLaunch, ChangeResult, Device, DevServerLaunch, Host, Identity, NodeWorkload, PowerModes, RawProcess, WindowsScan,
} from '../core/model.js'
import { sameIdentity, UserError } from '../core/model.js'
import { workloadRows } from '../core/discovery.js'
import type { Store } from '../core/store.js'
import type { NodeRuntime, Secrets } from './node-runtime.js'

type Reply<T> = { ok: true; value: T } | { ok: false; message: string; code: string }

const run = promisify(execFile)

/** Helper error codes that guarantee Windows was left unchanged. */
const noChange = new Set([
  'invalid-request', 'unsupported-service', 'service-missing', 'service-changed', 'service-access',
  'state-changed', 'service-dependent', 'service-prerequisite', 'service-control', 'plan-missing', 'power-apply',
  'process-changed', 'process-access', 'no-console', 'signal-failed', 'folder-missing', 'launch-failed',
  'power-mode-unavailable', 'power-mode-apply',
])

/** Drops variables that would change how a launched Electron, VS Code, or Node program behaves. */
export function launchEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(ELECTRON_|VSCODE_|CHROME_|NODE_OPTIONS$|NODE_PATH$|NODE_CHANNEL_|DEVSHIFT_)/i.test(name)))
}

export class Windows {
  constructor(private readonly helper: string) {}

  private call<T>(args: string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      execFile(this.helper, args, { windowsHide: true, timeout: 32_000, maxBuffer: 8_000_000, env: launchEnvironment() }, (error, stdout) => {
        let reply: Reply<T> | null = null
        try { reply = JSON.parse(stdout.trim()) as Reply<T> } catch {}
        if (reply && 'ok' in reply && reply.ok === false) return reject(new UserError(reply.message, noChange.has(reply.code)))
        if (error || reply?.ok !== true) return reject(new UserError('Windows did not return a verified response. Check the workload state before retrying.'))
        resolve(reply.value)
      })
    })
  }

  scan(includeInstalled = false) { return this.call<WindowsScan>([includeInstalled ? 'scan' : 'scan-live']) }
  process(pid: number) { return this.call<RawProcess | null>(['process', String(pid)]) }
  service(name: string, fingerprint: string, action: 'start' | 'stop', pid: number) {
    return this.call<ChangeResult>(['service', action, name, fingerprint, String(pid)])
  }
  power(expected: string, next: string) { return this.call<ChangeResult>(['power', expected, next]) }
  powerMode(expected: PowerModes, next: PowerModes) {
    return this.call<ChangeResult>(['power-mode', expected.ac, expected.dc, next.ac, next.dc])
  }
  close(identity: Identity) { return this.call<{ changed: boolean; windows: number }>(['close', String(identity.pid), identity.started]) }
  signal(identity: Identity, kind: 'ctrl-c' | 'ctrl-break') {
    return this.call<ChangeResult>(['signal', String(identity.pid), identity.started, kind])
  }
  terminate(identity: Identity) { return this.call<ChangeResult>(['terminate', String(identity.pid), identity.started]) }
  launchConsole(launch: DevServerLaunch) {
    return this.call<{ changed: boolean; pid: number }>(['launch-console', Buffer.from(JSON.stringify(launch), 'utf8').toString('base64')])
  }
}

/** SqlLocalDB.exe sits in Tools\Binn next to the LocalDB\Binn folder of the same SQL Server version. */
function localDbTool(processes: Identity[]) {
  for (const { path } of processes) {
    const candidate = join(dirname(dirname(dirname(path))), 'Tools', 'Binn', 'SqlLocalDB.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'SqlLocalDB.exe'
}

export class WindowsHost implements Host {
  private installed: WindowsScan['installed'] = []
  private previous: { time: number; processes: Map<string, number> } | null = null

  constructor(
    private readonly windows: Windows,
    private readonly runtime: NodeRuntime,
    private readonly store: Store,
    private readonly secrets: Secrets,
  ) {}

  async read(includeInstalled = false): Promise<Device> {
    const scan = await this.windows.scan(includeInstalled)
    const time = performance.now()
    const scannedAt = new Date().toISOString()
    if (includeInstalled) this.installed = scan.installed
    else scan.installed = this.installed

    const nodes = await Promise.all(this.store.configurations.map(config => this.runtime.observe(config, scan.processes)))
    const processors = cpus().length
    const prior = this.previous
    const elapsed = prior ? time - prior.time : 0
    const percentages = new Map<number, number>()
    if (!prior || elapsed >= 750) {
      const times = new Map<string, number>()
      for (const process of scan.processes) {
        if (process.cpuTicks === null || !process.started) continue
        const key = process.pid + '@' + process.started
        times.set(key, process.cpuTicks)
        const previous = prior?.processes.get(key)
        if (previous !== undefined && process.cpuTicks >= previous && processors) {
          const percentage = (process.cpuTicks - previous) / (elapsed * 10_000 * processors) * 100
          percentages.set(process.pid, Math.min(100, percentage))
        }
      }
      this.previous = { time, processes: times }
    }

    return {
      scan, nodes, workloads: workloadRows(scan, nodes, this.store.approvals, process => percentages.get(process.pid) ?? null),
      scannedAt, selfPid,
    }
  }

  changeService(name: string, fingerprint: string, action: 'start' | 'stop', pid: number) {
    return this.windows.service(name, fingerprint, action, pid)
  }

  changePower(expected: string, next: string) { return this.windows.power(expected, next) }
  changePowerMode(expected: PowerModes, next: PowerModes) { return this.windows.powerMode(expected, next) }
  stopNode(config: NodeWorkload, sessionId: string, process: RawProcess) { return this.runtime.stop(config, sessionId, process) }
  startNode(config: NodeWorkload, scan: WindowsScan) { return this.runtime.start(config, scan) }
  seal(value: string) { return this.secrets.seal(value) }
  unseal(value: string) { return this.secrets.unseal(value) }

  private async alive(identity: Identity) {
    const current = await this.windows.process(identity.pid)
    return !!current && sameIdentity(identity, current)
  }

  private async exited(identity: Identity, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!await this.alive(identity)) return true
      await delay(500)
    }
    return !await this.alive(identity)
  }

  async closeApp(identity: Identity): Promise<ChangeResult> {
    const result = await this.windows.close(identity)
    if (!result.windows) throw new UserError('It has no open window to close, so DevShift left it running.', true)
    if (await this.exited(identity, 30_000)) return { changed: true }
    return { changed: false, skipped: true, message: 'It is still open. It may be asking you to save your work.' }
  }

  async openApp(launch: AppLaunch): Promise<ChangeResult> {
    if (!win32.isAbsolute(launch.executable) || !existsSync(launch.executable))
      throw new UserError('Its program file is no longer installed.', true)
    const child = spawn(launch.executable, launch.args, {
      cwd: homedir(), detached: true, stdio: 'ignore', windowsHide: false, env: launchEnvironment(),
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new UserError('Windows could not open it.', true)))
    })
    child.unref()
    return { changed: true }
  }

  async stopDevServer(identity: Identity): Promise<ChangeResult> {
    await this.windows.signal(identity, 'ctrl-c')
    if (await this.exited(identity, 8_000)) return { changed: true }
    await this.windows.signal(identity, 'ctrl-break').catch(() => undefined)
    if (await this.exited(identity, 5_000)) return { changed: true }
    return { changed: false, skipped: true, message: 'It kept running after Ctrl+C, so DevShift left it running.' }
  }

  async startDevServer(launch: DevServerLaunch): Promise<ChangeResult> {
    await this.windows.launchConsole(launch)
    return { changed: true }
  }

  async stopBuildServers(processes: Identity[]): Promise<ChangeResult> {
    // The .NET SDK shuts its own servers down gracefully. Whatever remains is stopped only when idle.
    await run('dotnet', ['build-server', 'shutdown'], { windowsHide: true, timeout: 60_000, env: launchEnvironment() }).catch(() => undefined)
    let busy = 0
    for (const identity of processes) {
      const first = await this.windows.process(identity.pid)
      if (!first || !sameIdentity(identity, first)) continue
      await delay(1_000)
      const second = await this.windows.process(identity.pid)
      if (!second || !sameIdentity(identity, second)) continue
      // More than about 20 ms of CPU time in the last second means a build is still using it.
      if (first.cpuTicks === null || second.cpuTicks === null || second.cpuTicks - first.cpuTicks > 200_000) { busy++; continue }
      try { await this.windows.terminate(identity) } catch { busy++ }
    }
    return busy ? { changed: true, skipped: true, message: 'Some build servers were busy, so DevShift left them running.' } : { changed: true }
  }

  async stopLocalDb(processes: Identity[]): Promise<ChangeResult> {
    const tool = localDbTool(processes)
    const options = { windowsHide: true, timeout: 60_000, env: launchEnvironment() }
    const { stdout } = await run(tool, ['info'], options).catch(() => {
      throw new UserError('DevShift could not find SqlLocalDB.exe, so LocalDB keeps running.', true)
    })
    const instances = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[\w.#\- ]{1,128}$/.test(line))
    for (const instance of instances) await run(tool, ['stop', instance], options).catch(() => undefined)
    let remaining = processes
    const deadline = Date.now() + 20_000
    while (remaining.length && Date.now() < deadline) {
      remaining = (await Promise.all(remaining.map(async identity => await this.alive(identity) ? [identity] : []))).flat()
      if (remaining.length) await delay(500)
    }
    return remaining.length
      ? { changed: true, skipped: true, message: 'LocalDB is still running. An app may still be using it.' }
      : { changed: true }
  }
}
