import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { powerModeName } from '../shared/contracts.js'
import type { Mode, Settings } from '../shared/contracts.js'
import {
  buildServers, devServerLabel, devServers, editorApps, isBuildServer, localDbProcesses, privateMemoryOf, processTree, sameArgs,
  sameFile, stopOrder,
} from './discovery.js'
import { identityOf, sameIdentity, serviceKey, UserError } from './model.js'
import type { AppLaunch, Captured, ChangeResult, Device, DevServerLaunch, Host, RawProcess } from './model.js'

export type Decision =
  | { type: 'present'; message: string }
  | { type: 'skip'; message: string }
  | { type: 'act'; run: () => Promise<ChangeResult>; success: string }

export interface PlannedStep {
  id: string
  key: string
  label: string
  forward: string
  backward: string
  captured: Captured
  memoryBytes: number | null
  /** Plaintext. The engine seals it before anything is journaled. */
  secret?: string
}

export interface Plan { steps: PlannedStep[]; blocked: string[]; notices: string[] }

type Of<K extends Captured['kind']> = Extract<Captured, { kind: K }>

interface PlanContext {
  device: Device
  settings: Settings
  approvals: Record<string, string>
  plan: Plan
  /** Processes covered by an earlier step, so memory is counted once. */
  claimed: Set<number>
}

interface Handler<K extends Captured['kind']> {
  plan: (context: PlanContext) => void
  decide: (capture: Of<K>, device: Device, direction: Mode, host: Host) => Decision | Promise<Decision>
  verify: (capture: Of<K>, device: Device, direction: Mode) => boolean
}

const present = (message: string): Decision => ({ type: 'present', message })
const skip = (message: string): Decision => ({ type: 'skip', message })
const act = (run: () => Promise<ChangeResult>, success: string): Decision => ({ type: 'act', run, success })
const alive = (identity: Pick<RawProcess, 'pid' | 'started' | 'path'>, device: Device) =>
  device.scan.processes.some(process => sameIdentity(identity, process))
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const runningFrom = (path: string, device: Device) => device.scan.processes.some(process => process.path && sameFile(process.path, path))

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'string' && item.length <= 8192)
const isAppLaunch = (value: unknown): value is AppLaunch => typeof value === 'object' && value !== null
  && typeof (value as AppLaunch).executable === 'string' && isStrings((value as AppLaunch).args)
const isDevServerLaunch = (value: unknown): value is DevServerLaunch => isAppLaunch(value)
  && typeof (value as DevServerLaunch).cwd === 'string' && typeof (value as DevServerLaunch).title === 'string'

async function unsealLaunch<T>(sealed: string | undefined, host: Host, valid: (value: unknown) => value is T): Promise<T> {
  if (!sealed) throw new UserError('DevShift has no saved launch details for it.', true)
  let value: unknown
  try { value = JSON.parse(await host.unseal(sealed)) }
  catch { throw new UserError('DevShift could not read the saved launch details on this Windows account.', true) }
  if (!valid(value)) throw new UserError('The saved launch details are invalid.', true)
  return value
}

/** Never overwrites a power plan the user changed in Windows. */
function swap(active: string | null, capture: { before: string; after: string }, direction: Mode, noun: string,
  change: (expected: string, next: string) => Promise<ChangeResult>): Decision {
  const before = direction === 'gaming' ? capture.before : capture.after
  const after = direction === 'gaming' ? capture.after : capture.before
  if (active === after) return present('The requested ' + noun + ' is already active.')
  if (active !== before) return skip('Preserved the ' + noun + ' selected in Windows.')
  return act(() => change(before, after), 'Verified the active ' + noun + '.')
}

const power: Handler<'power'> = {
  plan({ device, settings, plan }) {
    const target = settings.gamingPlan
    const next = device.scan.power.plans.find(item => item.id === target)
    if (target && !next) plan.blocked.push('The preferred gaming power plan is unavailable.')
    const original = device.scan.power.active
    if (!next || next.id === original) return
    const name = device.scan.power.plans.find(item => item.id === original)?.name ?? 'original plan'
    plan.steps.push({
      id: 'power', key: 'power', label: 'Power plan', captured: { kind: 'power', before: original, after: next.id },
      forward: name + ' to ' + next.name, backward: next.name + ' to ' + name, memoryBytes: null,
    })
  },
  decide: (capture, device, direction, host) => swap(device.scan.power.active, capture, direction, 'power plan',
    (expected, next) => host.changePower(expected, next)),
  verify: (capture, device, direction) => device.scan.power.active === (direction === 'gaming' ? capture.after : capture.before),
}

const sources = ['ac', 'dc'] as const

// Gaming sets both the plugged-in (ac) and battery (dc) settings.
const powerMode: Handler<'powermode'> = {
  plan({ device, settings, plan }) {
    const target = settings.gamingPowerMode
    const state = device.scan.powerMode
    if (!target || !state || (state.ac === target && state.dc === target)) return
    if (state.energySaver)
      plan.notices.push('Energy Saver is on, so Windows keeps saving power until you plug in or turn Energy Saver off.')
    const current = state.pluggedIn ? state.ac : state.dc
    plan.steps.push({
      id: 'powermode', key: 'powermode', label: 'Power mode',
      captured: { kind: 'powermode', before: { ac: state.ac, dc: state.dc }, after: target },
      forward: powerModeName(current) + ' to ' + powerModeName(target), backward: powerModeName(target) + ' to ' + powerModeName(current),
      memoryBytes: null,
    })
  },
  decide(capture, device, direction, host) {
    const state = device.scan.powerMode
    if (!state) return skip('Windows power modes are unavailable right now.')
    const gaming = { ac: capture.after, dc: capture.after }
    const expected = direction === 'gaming' ? capture.before : gaming
    const next = direction === 'gaming' ? gaming : capture.before
    const current = { ac: state.ac, dc: state.dc }
    if (sources.every(source => current[source] === next[source])) return present('The requested power mode is already set.')
    // A setting changed in Windows since the switch keeps its new value.
    const target = {
      ac: current.ac === expected.ac ? next.ac : current.ac,
      dc: current.dc === expected.dc ? next.dc : current.dc,
    }
    if (sources.every(source => target[source] === current[source])) return skip('Preserved the power mode selected in Windows.')
    return act(() => host.changePowerMode(current, target), 'Verified the power mode settings.')
  },
  verify(capture, device, direction) {
    const state = device.scan.powerMode
    if (!state) return false
    return direction === 'gaming'
      ? state.ac === capture.after && state.dc === capture.after
      : sources.every(source => state[source] !== capture.after || capture.before[source] === capture.after)
  },
}

const service: Handler<'service'> = {
  plan({ device, approvals, plan, claimed }) {
    const approved = device.scan.services.filter(entry => approvals[serviceKey(entry.name)] === entry.fingerprint)
    const candidates = approved.filter(entry => {
      if (entry.state === 'stopped') return false
      if (entry.state === 'running' && entry.supported && entry.canControl && entry.acceptStop && entry.pid > 0) return true
      plan.blocked.push(entry.label + ' stays active. ' + (entry.limitation ?? 'Windows cannot confirm a graceful stop.'))
      return false
    })
    const { ordered, blocked } = stopOrder(candidates)
    for (const entry of blocked) plan.blocked.push(entry.label + ' stays active because it has an active dependent service.')
    for (const entry of ordered) {
      const process = device.scan.processes.find(candidate => candidate.pid === entry.pid)
      if (process) claimed.add(process.pid)
      plan.steps.push({
        id: serviceKey(entry.name), key: serviceKey(entry.name), label: entry.label,
        captured: {
          kind: 'service', name: entry.name, fingerprint: entry.fingerprint, pid: entry.pid,
          requires: entry.requires.map(link => link.name), dependents: entry.dependents.map(link => link.name),
        },
        forward: 'Stop this approved Windows service.', backward: 'Start this Windows service and check its reported state.',
        memoryBytes: process?.privateMemoryBytes ?? null,
      })
    }
  },
  decide(capture, device, direction, host) {
    const gaming = direction === 'gaming'
    const current = device.scan.services.find(candidate => candidate.name.toLowerCase() === capture.name.toLowerCase())
    if (!current || current.fingerprint !== capture.fingerprint) return skip('Preserved service changes made since the snapshot.')
    if (current.state === (gaming ? 'stopped' : 'running')) return present('Windows already reports the requested service state.')
    if (gaming) {
      if (current.state !== 'running' || current.pid !== capture.pid)
        return skip('The original service instance changed. The new state was preserved.')
      const needed = device.nodes.some(node => node.state !== 'stopped'
        && node.configuration.dependencies.includes(current.name.toLowerCase()))
      if (needed) return skip('A running approved project still needs this service.')
    }
    return act(
      () => host.changeService(current.name, current.fingerprint, gaming ? 'stop' : 'start', gaming ? capture.pid : 0),
      gaming ? 'Windows confirmed the service stopped.' : 'Windows confirmed the service is running.',
    )
  },
  verify: (capture, device, direction) => device.scan.services.some(entry => entry.name.toLowerCase() === capture.name.toLowerCase()
    && entry.fingerprint === capture.fingerprint && entry.state === (direction === 'gaming' ? 'stopped' : 'running')),
}

const node: Handler<'node'> = {
  plan({ device, plan, claimed }) {
    for (const observation of device.nodes) {
      const { configuration, process, ready, sessionId } = observation
      if (observation.state === 'stopped') continue
      if (!ready || !process || !sessionId || !process.started || !process.path) {
        plan.blocked.push(configuration.label + ' stays open. ' + observation.detail)
        continue
      }
      const tree = processTree(process, device.scan.processes).filter(member => !claimed.has(member.pid))
      for (const member of tree) claimed.add(member.pid)
      plan.steps.push({
        id: configuration.id, key: configuration.id, label: configuration.label,
        captured: { kind: 'node', configuration, sessionId, identity: { pid: process.pid, started: process.started, path: process.path } },
        forward: 'Request the project’s graceful shutdown.', backward: 'Relaunch the project and wait for readiness.',
        memoryBytes: privateMemoryOf(tree),
      })
    }
  },
  decide(capture, device, direction, host) {
    const observation = device.nodes.find(candidate => candidate.configuration.id === capture.configuration.id)
    if (!observation) return skip('The approved project configuration is unavailable.')
    if (direction === 'gaming') {
      if (observation.state === 'stopped') return present('The captured process is no longer running.')
      if (observation.state === 'unknown') throw new UserError('Windows could not verify the captured process.')
      if (!observation.process || !sameIdentity(capture.identity, observation.process) || observation.sessionId !== capture.sessionId)
        return skip('A different process now matches the project. It was left running.')
      if (!observation.ready) throw new UserError('The process is running without a verified shutdown handler.')
      const process = observation.process
      return act(() => host.stopNode(capture.configuration, capture.sessionId, process),
        'The project confirmed graceful shutdown and its process exited.')
    }
    if (observation.state === 'running' && observation.ready) return present('The project is running and confirmed readiness.')
    if (observation.state === 'running' && !observation.ready && !observation.sessionId)
      return skip('A matching project is already running. DevShift left it in place.')
    const current = observation.configuration
    if (current.entryHash !== capture.configuration.entryHash || current.executableHash !== capture.configuration.executableHash
      || !sameFile(current.entry, capture.configuration.entry) || !sameFile(current.executable, capture.configuration.executable))
      return skip('Preserved changes to the approved project configuration.')
    return act(() => host.startNode(capture.configuration, device.scan), 'Relaunched the project and confirmed readiness.')
  },
  verify: (capture, device, direction) => device.nodes.some(observation => observation.configuration.id === capture.configuration.id
    && (direction === 'gaming' ? observation.state === 'stopped' : observation.state === 'running' && observation.ready)),
}

function closeDescription(program: string) {
  return /^code( - insiders)?\.exe$/.test(program)
    ? 'Close it. VS Code keeps unsaved files and reopens your windows.'
    : 'Close it as if you closed its windows. If it asks to save, DevShift leaves it open.'
}

const app: Handler<'app'> = {
  plan({ device, plan, claimed }) {
    for (const instance of editorApps(device.scan.processes)) {
      const { root, label } = instance
      const identity = identityOf(root)
      if (!identity || !root.args) continue
      if (device.selfPid !== undefined && instance.members.some(member => member.pid === device.selfPid)) {
        plan.notices.push(label + ' stays open because DevShift is running from it.')
        continue
      }
      const members = instance.members.filter(member => !claimed.has(member.pid))
      for (const member of members) claimed.add(member.pid)
      const program = win32.basename(identity.path).toLowerCase()
      const launch: AppLaunch = { executable: identity.path, args: root.args.slice(1) }
      plan.steps.push({
        id: 'app:' + root.pid, key: 'app:' + program, label, captured: { kind: 'app', label, identity },
        forward: closeDescription(program), backward: 'Reopen it.', memoryBytes: privateMemoryOf(members),
        secret: JSON.stringify(launch),
      })
    }
  },
  async decide(capture, device, direction, host) {
    if (direction === 'gaming') {
      if (!alive(capture.identity, device)) return present('It was already closed.')
      return act(() => host.closeApp(capture.identity), 'It closed.')
    }
    if (runningFrom(capture.identity.path, device)) return present('It is already open.')
    const launch = await unsealLaunch(capture.sealed, host, isAppLaunch)
    return act(() => host.openApp(launch), 'Reopened it.')
  },
  verify: (capture, device, direction) =>
    direction === 'gaming' ? !alive(capture.identity, device) : runningFrom(capture.identity.path, device),
}

const devserver: Handler<'devserver'> = {
  plan({ device, plan, claimed }) {
    const managed = device.nodes.flatMap(observation => observation.process
      ? processTree(observation.process, device.scan.processes).map(member => member.pid) : [])
    for (const server of devServers(device.scan.processes, new Set([...claimed, ...managed]))) {
      const { root } = server
      const identity = identityOf(root)
      if (!identity || !root.args) continue
      if (device.selfPid !== undefined && server.members.some(member => member.pid === device.selfPid)) continue
      const label = devServerLabel(root)
      if (!root.cwd) {
        plan.blocked.push(label + ' stays running. DevShift could not read its folder, so it could not restart it.')
        continue
      }
      // Build servers outlive the command that started them, so the build-server step stops them instead.
      const members = server.members.filter(member => !isBuildServer(member))
      for (const member of members) claimed.add(member.pid)
      const launch: DevServerLaunch = { executable: identity.path, args: root.args.slice(1), cwd: root.cwd, title: label }
      plan.steps.push({
        id: 'devserver:' + root.pid,
        key: 'devserver:' + shortHash([identity.path.toLowerCase(), ...launch.args, root.cwd.toLowerCase()].join('\0')),
        label, captured: { kind: 'devserver', label, identity },
        forward: 'Stop it with Ctrl+C.', backward: 'Run it again in a terminal window, in the same folder.',
        memoryBytes: privateMemoryOf(members), secret: JSON.stringify(launch),
      })
    }
  },
  async decide(capture, device, direction, host) {
    if (direction === 'gaming') {
      if (!alive(capture.identity, device)) return present('It had already stopped.')
      return act(() => host.stopDevServer(capture.identity), 'It stopped after Ctrl+C.')
    }
    const launch = await unsealLaunch(capture.sealed, host, isDevServerLaunch)
    const running = device.scan.processes.some(process => process.path && sameFile(process.path, launch.executable)
      && sameArgs(process.args?.slice(1), launch.args))
    if (running) return present('It is already running.')
    return act(() => host.startDevServer(launch), 'Restarted it in a terminal window.')
  },
  // A restarted command can take a few seconds to appear, so restoration is judged by the launch itself.
  verify: (capture, device, direction) => direction === 'development' || !alive(capture.identity, device),
}

const buildservers: Handler<'buildservers'> = {
  plan({ device, plan, claimed }) {
    const running = buildServers(device.scan.processes).filter(process => !claimed.has(process.pid))
    if (!running.length) return
    for (const process of running) claimed.add(process.pid)
    plan.steps.push({
      id: 'buildservers', key: 'buildservers', label: 'Build servers', captured: { kind: 'buildservers' },
      forward: 'Stop idle .NET build and compiler servers. The next build starts them again.',
      backward: 'The next build starts them again.', memoryBytes: privateMemoryOf(running),
    })
  },
  decide(_capture, device, direction, host) {
    if (direction === 'development') return present('The next build starts them again.')
    const running = buildServers(device.scan.processes).flatMap(process => identityOf(process) ?? [])
    if (!running.length) return present('No build servers were running.')
    return act(() => host.stopBuildServers(running), 'Stopped the idle build servers.')
  },
  verify: (_capture, device, direction) => direction === 'development' || buildServers(device.scan.processes).length === 0,
}

const localdb: Handler<'localdb'> = {
  plan({ device, plan, claimed }) {
    const running = localDbProcesses(device.scan.processes)
    if (!running.length) return
    for (const process of running) claimed.add(process.pid)
    plan.steps.push({
      id: 'localdb', key: 'localdb', label: 'SQL Server LocalDB', captured: { kind: 'localdb' },
      forward: 'Stop it. It starts again when an app connects.', backward: 'It starts again automatically when an app connects.',
      memoryBytes: privateMemoryOf(running),
    })
  },
  decide(_capture, device, direction, host) {
    if (direction === 'development') return present('It starts again automatically when an app connects.')
    const running = localDbProcesses(device.scan.processes).flatMap(process => identityOf(process) ?? [])
    if (!running.length) return present('LocalDB had already stopped.')
    return act(() => host.stopLocalDb(running), 'Stopped LocalDB.')
  },
  verify: (_capture, device, direction) => direction === 'development' || localDbProcesses(device.scan.processes).length === 0,
}

const handlers: { [K in Captured['kind']]: Handler<K> } = {
  power, powermode: powerMode, service, node, app, devserver, buildservers, localdb,
}

/**
 * Gaming order: dev servers stop before the editors whose terminals host them, editors close before
 * build servers and LocalDB lose their clients, then services, then power. Restoration runs in reverse.
 */
const gamingOrder: Captured['kind'][] = ['devserver', 'node', 'app', 'buildservers', 'localdb', 'service', 'power', 'powermode']

export function planGaming(device: Device, settings: Settings, approvals: Record<string, string>): Plan {
  const plan: Plan = { steps: [], blocked: [], notices: [] }
  const context: PlanContext = { device, settings, approvals, plan, claimed: new Set() }
  for (const kind of gamingOrder) (handlers[kind] as Handler<Captured['kind']>).plan(context)

  const kinds = new Set(plan.steps.map(step => step.captured.kind))
  const observed = [...new Set(device.workloads
    .filter(row => row.state === 'running' && !row.approved && !row.managed && (row.pid === null || !context.claimed.has(row.pid)))
    .map(row => row.label))]
  if (observed.length) plan.notices.push('Left running: ' + observed.join(', ') + '.')
  if (kinds.has('app'))
    plan.notices.push('Editors close as if you closed their windows. VS Code keeps unsaved files. If another editor asks you to save, DevShift leaves it open.')
  if (kinds.has('devserver'))
    plan.notices.push('Dev servers restart in a new terminal window with your default environment variables.')
  if (kinds.has('node')) plan.notices.push('Restored projects start as fresh processes. In-memory state is unavailable.')
  if (kinds.has('service'))
    plan.notices.push('Confirm that other applications and clients can tolerate the selected service interruption.')
  return plan
}

export function decide(capture: Captured, device: Device, direction: Mode, host: Host) {
  return (handlers[capture.kind] as Handler<Captured['kind']>).decide(capture as never, device, direction, host)
}

export function verify(capture: Captured, device: Device, direction: Mode) {
  return (handlers[capture.kind] as Handler<Captured['kind']>).verify(capture as never, device, direction)
}
