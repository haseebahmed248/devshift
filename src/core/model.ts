import { bestPerformanceMode } from '../shared/contracts.js'
import type {
  Category, InstalledTool, Mode, OperationItem, Phase, PowerModeState, PowerPlan, Settings, TimelineEntry, Workload,
} from '../shared/contracts.js'

export interface RawProcess {
  name: string
  pid: number
  parentPid: number
  path: string | null
  started: string | null
  memoryBytes: number | null
  privateMemoryBytes: number | null
  cpuTicks: number | null
  args: string[] | null
  cwd?: string | null
}

export interface ServiceLink { name: string; state: string }

export interface Service {
  name: string
  label: string
  state: string
  pid: number
  path: string | null
  fingerprint: string
  supported: boolean
  canControl: boolean
  acceptStop: boolean
  limitation: string | null
  requires: ServiceLink[]
  dependents: ServiceLink[]
}

export interface WindowsScan {
  processes: RawProcess[]
  services: Service[]
  power: { active: string; plans: PowerPlan[] }
  powerMode?: PowerModeState | null
  installed: InstalledTool[]
  build: number
}

export interface NodeWorkload {
  id: string
  label: string
  executable: string
  entry: string
  executableHash: string
  entryHash: string
  dependencies: string[]
}

export interface NodeSession {
  id: string
  key: string
  bootstrap: string
  pid: number | null
}

export interface NodeObservation {
  configuration: NodeWorkload
  state: 'stopped' | 'running' | 'unknown'
  ready: boolean
  process: RawProcess | null
  sessionId: string | null
  detail: string
}

export interface Device {
  scan: WindowsScan
  nodes: NodeObservation[]
  workloads: Workload[]
  scannedAt: string
  /** Lets a switch skip the editor or terminal that DevShift itself runs in. */
  selfPid?: number
}

export type PowerModes = { ac: string; dc: string }

/** PID, creation time, and path together survive PID reuse. */
export type Identity = { pid: number; started: string; path: string }

// Launch details can contain secrets, so they are only ever persisted DPAPI-sealed.
export interface AppLaunch { executable: string; args: string[] }

export interface DevServerLaunch { executable: string; args: string[]; cwd: string; title: string }

export interface ChangeResult {
  changed: boolean
  /** The action ran but Windows didn't reach the requested state, for example an editor waiting on a save prompt. */
  skipped?: boolean
  message?: string
}

export interface Host {
  read: (includeInstalled?: boolean) => Promise<Device>
  changeService: (name: string, fingerprint: string, action: 'start' | 'stop', expectedPid: number) => Promise<ChangeResult>
  changePower: (expected: string, next: string) => Promise<ChangeResult>
  changePowerMode: (expected: PowerModes, next: PowerModes) => Promise<ChangeResult>
  stopNode: (configuration: NodeWorkload, sessionId: string, process: RawProcess) => Promise<ChangeResult>
  startNode: (configuration: NodeWorkload, scan: WindowsScan) => Promise<ChangeResult>
  closeApp: (identity: Identity) => Promise<ChangeResult>
  openApp: (launch: AppLaunch) => Promise<ChangeResult>
  stopDevServer: (identity: Identity) => Promise<ChangeResult>
  startDevServer: (launch: DevServerLaunch) => Promise<ChangeResult>
  stopBuildServers: (processes: Identity[]) => Promise<ChangeResult>
  stopLocalDb: (processes: Identity[]) => Promise<ChangeResult>
  seal: (value: string) => Promise<string>
  unseal: (value: string) => Promise<string>
}

export type Captured =
  | { kind: 'power'; before: string; after: string }
  | { kind: 'powermode'; before: PowerModes; after: string }
  | { kind: 'service'; name: string; fingerprint: string; pid: number; requires: string[]; dependents: string[] }
  | { kind: 'node'; configuration: NodeWorkload; sessionId: string; identity: Pick<RawProcess, 'pid' | 'started' | 'path'> }
  | { kind: 'app'; label: string; identity: Identity; sealed?: string }
  | { kind: 'devserver'; label: string; identity: Identity; sealed?: string }
  | { kind: 'buildservers' }
  | { kind: 'localdb' }

export const capturedKinds: readonly Captured['kind'][] = ['power', 'powermode', 'service', 'node', 'app', 'devserver', 'buildservers', 'localdb']

export interface Outcome {
  status: OperationItem['status']
  message: string
  effect: 'none' | 'possible' | 'verified'
  time: string | null
}

export interface JournalStep {
  id: string
  /** Remembers unticked actions across previews. Journals from 0.1 don't have it. */
  key?: string
  label: string
  forward: string
  backward: string
  captured: Captured
  gaming: Outcome
  development: Outcome
}

export interface Cycle {
  schema: 1
  id: string
  originalMode: 'development'
  originalPower: string
  createdAt: string
  updatedAt: string
  direction: Mode
  phase: Phase
  notices: string[]
  blocked: string[]
  steps: JournalStep[]
  history: TimelineEntry[]
  summary: string
}

export const defaultSettings: Settings = { gamingPlan: null, gamingPowerMode: bestPerformanceMode, scanInterval: 10_000, minimizeToTray: true }
export const nodeCategory: Category = 'Runtime'
export const serviceKey = (name: string) => 'service:' + name.toLowerCase()
export const pending = (): Outcome => ({ status: 'pending', message: '', effect: 'none', time: null })
export const timestamp = () => new Date().toISOString()
export const ongoing = new Set<Phase>([
  'PREPARING_GAMING', 'SWITCHING_TO_GAMING', 'PREPARING_DEVELOPMENT', 'RESTORING_DEVELOPMENT',
])

export class UserError extends Error {
  constructor(message: string, readonly unchanged = false) { super(message) }
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof UserError ? error.message : fallback
}

export function sameIdentity(left: Pick<RawProcess, 'pid' | 'started' | 'path'>, right: RawProcess) {
  return !!left.started && !!left.path && left.pid === right.pid && left.started === right.started
    && left.path.toLowerCase() === right.path?.toLowerCase()
}

export function identityOf(process: RawProcess): Identity | null {
  return process.started && process.path ? { pid: process.pid, started: process.started, path: process.path } : null
}
