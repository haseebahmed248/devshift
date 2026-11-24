export type Mode = 'development' | 'gaming'
export type Phase =
  | 'DEVELOPMENT' | 'PREPARING_GAMING' | 'SWITCHING_TO_GAMING' | 'GAMING'
  | 'PREPARING_DEVELOPMENT' | 'RESTORING_DEVELOPMENT'
  | 'PARTIAL_SUCCESS' | 'FAILED' | 'RECOVERY_REQUIRED'
export type Category = 'Editor' | 'Runtime' | 'Database' | 'Infrastructure' | 'Build tool' | 'Emulator'
export type ItemState = 'running' | 'stopped' | 'pending' | 'unknown'
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'
export type ReviewTarget = Mode | 'resume' | 'keep'

export interface PowerPlan { id: string; name: string }
export interface InstalledTool { name: string; version: string | null; source: string }

export interface Workload {
  id: string
  label: string
  category: Category
  kind: 'process' | 'service' | 'node'
  path: string | null
  pid: number | null
  parentPid: number | null
  startedAt: string | null
  processRole?: string
  privateMemoryBytes: number | null
  memoryBytes: number | null
  cpu: number | null
  state: ItemState
  approved: boolean
  canApprove: boolean
  canLaunch: boolean
  canRemove: boolean
  /** Handled by Gaming Mode without an approval step. */
  managed?: boolean
  restoration: string
  detail: string
}

/** Windows 11 power modes. Balanced is the empty GUID. */
export const powerModes = [
  { id: '961cc777-2547-4f9d-8174-7d86181b8a7a', name: 'Best power efficiency' },
  { id: '00000000-0000-0000-0000-000000000000', name: 'Balanced' },
  { id: '3af9b8d9-7c97-431d-ad78-34a8bfea439f', name: 'Better performance' },
  { id: 'ded574b5-45a0-4f42-8737-46345c09c238', name: 'Best performance' },
] as const
export const betterPerformanceMode = '3af9b8d9-7c97-431d-ad78-34a8bfea439f'
export const bestPerformanceMode = 'ded574b5-45a0-4f42-8737-46345c09c238'
export const gamingPowerModes: readonly string[] = [betterPerformanceMode, bestPerformanceMode]
export const powerModeName = (id: string | null | undefined) =>
  powerModes.find(mode => mode.id === id)?.name ?? (id ? 'Custom power mode' : 'Unavailable')

export interface PowerModeState {
  ac: string
  dc: string
  pluggedIn: boolean
  /** While Energy Saver is on, Windows uses its power-saving mode whatever these settings say. */
  energySaver: boolean
}

export interface Settings {
  gamingPlan: string | null
  gamingPowerMode: string | null
  scanInterval: number
  minimizeToTray: boolean
}

export interface OperationItem {
  id: string
  label: string
  detail: string
  status: StepStatus
  message: string
  memoryBytes?: number | null
  selected?: boolean
}

export interface TimelineEntry {
  id: string
  time: string
  title: string
  message: string
  status: StepStatus
}

export interface SwitchState {
  mode: Mode
  phase: Phase
  direction: Mode | null
  busy: boolean
  hasSnapshot: boolean
  transactionId: string | null
  progress: OperationItem[]
  updatedAt: string | null
  summary: string
}

export const performanceWindowMs = 60_000
export const performanceGapMs = 2500

export interface PerformanceSample {
  sampledAt: number
  cpu: number | null
  usedMemory: number | null
  totalMemory: number | null
}

export interface Dashboard {
  state: SwitchState
  workloads: Workload[]
  installed: InstalledTool[]
  settings: Settings
  history: TimelineEntry[]
  power: { active: string | null; plans: PowerPlan[] }
  powerMode: PowerModeState | null
  build: number
  scannedAt: string
}

export interface SwitchPreview {
  token: string
  direction: Mode
  recovery: boolean
  keep: boolean
  items: OperationItem[]
  notices: string[]
}

export interface FileChoice { token: string; path: string }
export interface NodeRegistration {
  label: string
  executable: string
  entry: string
  dependencies: string[]
}

export interface DevShiftApi {
  dashboard: (refresh?: boolean) => Promise<Dashboard>
  review: (target: ReviewTarget) => Promise<SwitchPreview>
  execute: (token: string, skip?: string[]) => Promise<SwitchState>
  approve: (id: string, approved: boolean) => Promise<void>
  preferences: (settings: Settings) => Promise<void>
  pickFile: (kind: 'executable' | 'entry') => Promise<FileChoice | null>
  registerNode: (data: NodeRegistration) => Promise<void>
  launchNode: (id: string) => Promise<void>
  removeNode: (id: string) => Promise<void>
  quit: () => Promise<void>
  onScanDue: (listener: () => void) => () => void
  onPerformance: (listener: (samples: PerformanceSample[]) => void) => () => void
  onProgress: (listener: (state: SwitchState) => void) => () => void
  onReview: (listener: (target: ReviewTarget) => void) => () => void
}

export const channels = {
  dashboard: 'devshift:dashboard',
  review: 'devshift:review',
  execute: 'devshift:execute',
  approve: 'devshift:approve',
  preferences: 'devshift:preferences',
  pickFile: 'devshift:pick-file',
  registerNode: 'devshift:register-node',
  launchNode: 'devshift:launch-node',
  removeNode: 'devshift:remove-node',
  quit: 'devshift:quit',
  scanDue: 'devshift:scan-due',
  performance: 'devshift:performance',
  progress: 'devshift:progress',
  trayReview: 'devshift:tray-review',
} as const
