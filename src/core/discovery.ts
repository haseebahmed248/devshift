import { basename, win32 } from 'node:path'
import type { Category, Workload } from '../shared/contracts.js'
import type { NodeObservation, RawProcess, Service, WindowsScan } from './model.js'
import { nodeCategory, serviceKey } from './model.js'

const editors = /^(devenv|ssms|code(?: - insiders)?|idea64|webstorm64|pycharm64|rider64|clion64|goland64|phpstorm64|rubymine64|datagrip64|rustrover64|studio64|fleet)\.exe$/i
const runtimes = /^(node|node64|python(?:w|\d+(?:\.\d+)?)?|dotnet|javaw?|deno|bun)\.exe$/i
const databases = /^(sqlservr|postgres|pg_ctl|mysqld|mariadbd|mongod|redis-server|memurai)\.exe$/i
const infra = /^(docker desktop|com\.docker\.backend|docker|wsl|wslhost|wslservice|vmmemwsl)\.exe$/i
const build = /^(msbuild|cmake|ninja|gradle|mvn|tsc|iisexpress|mspdbsrv|vbcscompiler)\.exe$/i
const emulators = /^(emulator|adb|qemu-system-.+)\.exe$/i
const devEntry = /(?:^|[\\/@.-])(vite|webpack-dev-server|react-scripts|nodemon|tsx|ts-node|next|nuxt|uvicorn|gunicorn|flask|django|gradlew|mvnw|spring-boot|msbuild)(?:[./\\-]|$)/i
const nodeMode = /^[-/]nodemode:/i
const localDbImage = /\\localdb\\binn\\sqlservr\.exe$/i

const labels: Record<string, string> = {
  'code.exe': 'Visual Studio Code', 'code - insiders.exe': 'VS Code Insiders', 'devenv.exe': 'Visual Studio',
  'ssms.exe': 'SQL Server Management Studio',
  'idea64.exe': 'IntelliJ IDEA', 'webstorm64.exe': 'WebStorm', 'pycharm64.exe': 'PyCharm',
  'rider64.exe': 'Rider', 'clion64.exe': 'CLion', 'goland64.exe': 'GoLand', 'phpstorm64.exe': 'PhpStorm',
  'rubymine64.exe': 'RubyMine', 'datagrip64.exe': 'DataGrip', 'rustrover64.exe': 'RustRover',
  'studio64.exe': 'Android Studio', 'fleet.exe': 'Fleet', 'sqlservr.exe': 'SQL Server', 'postgres.exe': 'PostgreSQL',
  'mysqld.exe': 'MySQL', 'mariadbd.exe': 'MariaDB', 'mongod.exe': 'MongoDB', 'redis-server.exe': 'Redis',
  'docker desktop.exe': 'Docker Desktop', 'com.docker.backend.exe': 'Docker Desktop backend',
  'vmmemwsl.exe': 'WSL virtual machine', 'wslhost.exe': 'WSL host', 'wsl.exe': 'WSL',
  'emulator.exe': 'Android Emulator', 'adb.exe': 'Android Debug Bridge',
  'vbcscompiler.exe': 'C# compiler server', 'msbuild.exe': 'MSBuild',
}

export function classify(process: RawProcess, processes: Map<number, RawProcess>): Category | null {
  const { name, args } = process
  if (editors.test(name)) return 'Editor'
  if (databases.test(name)) return 'Database'
  if (infra.test(name)) return 'Infrastructure'
  if (build.test(name)) return 'Build tool'
  if (emulators.test(name)) return 'Emulator'
  if (!runtimes.test(name) || !args) return null

  const target = args.slice(1).some(value => devEntry.test(value)
    || /(?:^|[\\/])manage\.py$/i.test(value)
    || (/^dotnet\.exe$/i.test(name) && ['watch', 'run', 'build', 'test'].includes(value)))
  if (target) return 'Runtime'

  const parent = processes.get(process.parentPid)
  const isParent = parent?.started && process.started && parent.started <= process.started
  return isParent && /^devenv\.exe$/i.test(parent.name) && /^dotnet\.exe$/i.test(name) && args.length > 1
    ? 'Runtime'
    : null
}

function editorRole(args: string[] | null) {
  if (!args) return undefined
  if (args.includes('--utility-sub-type=network.mojom.NetworkService')) return 'Network service'
  const type = args.find(arg => arg.startsWith('--type='))
  switch (type) {
    case '--type=renderer': return 'Renderer'
    case '--type=gpu-process': return 'GPU process'
    case '--type=utility': return 'Utility process'
    case '--type=crashpad-handler': return 'Crash handler'
    default: return undefined
  }
}

export function sameFile(first: string, second: string) {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase()
}

export function sameArgs(first: readonly string[] | null | undefined, second: readonly string[]) {
  return !!first && first.length === second.length && first.every((value, index) => value === second[index])
}

export function matchingNode(processes: RawProcess[], executable: string, entry: string) {
  return processes.filter(process => process.path && sameFile(process.path, executable)
    && process.args?.slice(1).some(arg => win32.isAbsolute(arg) && sameFile(arg, entry)))
}

/** A child must have started after its parent; otherwise the parent PID was reused. */
const bornAfter = (parent: RawProcess, child: RawProcess) => !!parent.started && !!child.started && parent.started <= child.started

function childrenOf(processes: RawProcess[]) {
  const children = new Map<number, RawProcess[]>()
  for (const process of processes) {
    const list = children.get(process.parentPid)
    if (list) list.push(process)
    else children.set(process.parentPid, [process])
  }
  return children
}

export function processTree(root: RawProcess, processes: RawProcess[], children = childrenOf(processes)) {
  const tree = [root]
  const seen = new Set([root.pid])
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index]!
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || !bornAfter(parent, child)) continue
      seen.add(child.pid)
      tree.push(child)
    }
  }
  return tree
}

export function privateMemoryOf(processes: RawProcess[]) {
  let total = 0
  let measured = false
  for (const process of processes) {
    if (process.privateMemoryBytes == null) continue
    total += process.privateMemoryBytes
    measured = true
  }
  return measured ? total : null
}

export interface AppInstance { root: RawProcess; members: RawProcess[]; label: string }

export function editorApps(processes: RawProcess[]): AppInstance[] {
  const byPid = new Map(processes.map(process => [process.pid, process]))
  const children = childrenOf(processes)
  const roots = processes.filter(process => {
    if (!editors.test(process.name) || !process.path) return false
    const parent = byPid.get(process.parentPid)
    return !(parent && parent.path && sameFile(parent.path, process.path) && bornAfter(parent, process))
  })
  const counts = new Map<string, number>()
  return roots.map(root => {
    const name = root.name.toLowerCase()
    const solution = /^(devenv|ssms)\.exe$/.test(name)
      ? root.args?.slice(1).find(arg => /\.(sln|slnx|slnf|ssmssln)$/i.test(arg)) : undefined
    let label = labels[name] ?? basename(root.name, '.exe')
    if (solution) label += ' · ' + win32.basename(solution).replace(/\.[^.]+$/, '')
    const seen = (counts.get(label) ?? 0) + 1
    counts.set(label, seen)
    return { root, members: processTree(root, processes, children), label: seen > 1 ? label + ' (' + seen + ')' : label }
  })
}

/**
 * Walks up from a dev process to the command the user started, such as `npm run dev` above `vite`.
 * It climbs through runtime parents and through the cmd.exe wrappers that npm and pnpm insert between them.
 */
function commandRoot(process: RawProcess, byPid: Map<number, RawProcess>) {
  let root = process
  let current = process
  const seen = new Set([process.pid])
  for (;;) {
    const parent = byPid.get(current.parentPid)
    if (!parent || seen.has(parent.pid) || !bornAfter(parent, current)) break
    seen.add(parent.pid)
    if (runtimes.test(parent.name) && parent.path && parent.args) {
      root = parent
      current = parent
      continue
    }
    const grandparent = /^cmd\.exe$/i.test(parent.name) ? byPid.get(parent.parentPid) : undefined
    if (grandparent && !seen.has(grandparent.pid) && runtimes.test(grandparent.name) && grandparent.path && grandparent.args
      && bornAfter(grandparent, parent)) {
      current = parent
      continue
    }
    break
  }
  return root
}

export interface DevServer { root: RawProcess; members: RawProcess[] }

export function devServers(processes: RawProcess[], excluded: ReadonlySet<number> = new Set()): DevServer[] {
  const byPid = new Map(processes.map(process => [process.pid, process]))
  const roots = new Map<number, RawProcess>()
  for (const process of processes) {
    if (excluded.has(process.pid) || classify(process, byPid) !== 'Runtime') continue
    const root = commandRoot(process, byPid)
    if (!excluded.has(root.pid)) roots.set(root.pid, root)
  }
  const children = childrenOf(processes)
  const covered = new Set<number>()
  const servers: DevServer[] = []
  for (const root of [...roots.values()].sort((a, b) => (a.started ?? '').localeCompare(b.started ?? ''))) {
    if (covered.has(root.pid)) continue
    const members = processTree(root, processes, children).filter(member => !excluded.has(member.pid))
    for (const member of members) covered.add(member.pid)
    servers.push({ root, members })
  }
  return servers
}

const scriptName = /^[\w:.@/-]{1,60}$/

// Labels are journaled in plaintext, so they never include arguments beyond an npm script name.
export function devServerLabel(root: RawProcess) {
  const args = root.args ?? []
  const script = args[1] ? win32.basename(args[1]).toLowerCase() : ''
  const tool = /^npm-cli\.js$/.test(script) ? 'npm' : /^pnpm\.c?js$/.test(script) ? 'pnpm'
    : /^yarn\.c?js$/.test(script) ? 'yarn' : /^npx-cli\.js$/.test(script) ? 'npx' : null
  let command: string
  if (tool) {
    const [verb, target] = args.slice(2)
    const words = verb === 'run' || verb === 'run-script' ? ['run', target] : [verb]
    command = [tool, ...words.filter((word): word is string => !!word && scriptName.test(word))].join(' ')
  } else {
    const program = basename(root.name, '.exe').toLowerCase()
    const first = args[1] && scriptName.test(win32.basename(args[1])) ? win32.basename(args[1]) : ''
    command = first ? program + ' ' + first : program
  }
  const folder = root.cwd ? win32.basename(root.cwd) : ''
  return folder ? command + ' · ' + folder : command
}

export function isBuildServer(process: RawProcess) {
  const name = process.name.toLowerCase()
  const args = (process.args ?? []).map(arg => arg.toLowerCase())
  if (name === 'vbcscompiler.exe') return true
  if (name === 'msbuild.exe') return args.some(arg => nodeMode.test(arg))
  if (name !== 'dotnet.exe') return false
  return args.some(arg => arg.endsWith('vbcscompiler.dll') || arg.endsWith('rzc.dll'))
    || (args.some(arg => arg.endsWith('msbuild.dll')) && args.some(arg => nodeMode.test(arg)))
}

export function buildServers(processes: RawProcess[]) {
  return processes.filter(process => process.path && process.started && isBuildServer(process))
}

export const isLocalDb = (process: RawProcess) => /^sqlservr\.exe$/i.test(process.name) && localDbImage.test(process.path ?? '')

export function localDbProcesses(processes: RawProcess[]) {
  return processes.filter(process => process.started && isLocalDb(process))
}

function managedRestoration(process: RawProcess, category: Category) {
  if (category === 'Editor') return {
    restoration: 'Closed in Gaming Mode and reopened afterward',
    detail: 'DevShift asks the editor to close, as if you closed its windows, and never forces it. If it asks to save, it stays open.',
  }
  if (category === 'Runtime') return {
    restoration: 'Stopped with Ctrl+C and restarted in a terminal afterward',
    detail: 'DevShift restarts the command in the same folder with your default environment variables.',
  }
  if (category === 'Build tool' && isBuildServer(process)) return {
    restoration: 'Stopped in Gaming Mode and started again by the next build',
    detail: 'Idle build servers stop. Busy ones keep running.',
  }
  if (category === 'Database' && isLocalDb(process)) return {
    restoration: 'Stopped in Gaming Mode and started again when an app connects',
    detail: 'LocalDB starts automatically the next time an app connects to it.',
  }
  return null
}

export function workloadRows(
  scan: WindowsScan, nodes: NodeObservation[], approvals: Record<string, string>, cpu: (process: RawProcess) => number | null,
): Workload[] {
  const processes = new Map(scan.processes.map(process => [process.pid, process]))
  const associated = new Set<number>()
  const measures = (process?: RawProcess | null) => ({
    pid: process?.pid ?? null,
    parentPid: process?.parentPid ?? null,
    startedAt: process?.started ?? null,
    privateMemoryBytes: process?.privateMemoryBytes ?? null,
    memoryBytes: process?.memoryBytes ?? null,
    cpu: process ? cpu(process) : null,
  })

  const managed: Workload[] = nodes.map(node => {
    if (node.process) associated.add(node.process.pid)
    return {
      ...measures(node.process), id: node.configuration.id, label: node.configuration.label,
      category: nodeCategory, kind: 'node', path: node.configuration.entry, state: node.state,
      approved: true, canApprove: false, canLaunch: node.state === 'stopped', canRemove: node.state === 'stopped',
      restoration: 'Relaunch and check project readiness', detail: node.detail,
    }
  })

  const services: Workload[] = scan.services.map(service => {
    const id = serviceKey(service.name)
    const process = processes.get(service.pid)
    if (service.pid) associated.add(service.pid)
    const approved = approvals[id] === service.fingerprint
    const state = service.state === 'running' || service.state === 'stopped' ? service.state : 'pending'
    return {
      ...measures(process), pid: service.pid || null, id, label: service.label,
      category: service.supported || !/wsl|docker|lxss/i.test(service.name) ? 'Database' : 'Infrastructure',
      kind: 'service', path: service.path, state, approved,
      canApprove: service.supported && service.canControl, canLaunch: false, canRemove: false,
      restoration: service.supported ? 'Restart through Windows Service Control Manager' : 'Observation only',
      detail: service.limitation ?? (approved
        ? 'Approved Windows service'
        : approvals[id] ? 'Service configuration changed. Review and approve it again.' : 'Approval required for switching'),
    }
  })

  const discovered: Workload[] = scan.processes.flatMap(process => {
    if (associated.has(process.pid)) return []
    const category = classify(process, processes)
    if (!category) return []
    const label = category === 'Runtime' ? devServerLabel(process) : labels[process.name.toLowerCase()] ?? basename(process.name, '.exe')
    const handled = managedRestoration(process, category)
    return [{
      ...measures(process), id: 'process:' + process.pid + ':' + (process.started ?? ''), label, category, kind: 'process' as const,
      processRole: category === 'Editor' ? editorRole(process.args) : undefined,
      path: process.path, state: 'running' as const, approved: false, canApprove: false, canLaunch: false, canRemove: false,
      managed: !!handled,
      restoration: handled?.restoration ?? 'Observation only',
      detail: handled?.detail ?? 'A supported, verified shutdown and restore method is unavailable.',
    }]
  })

  return [...managed, ...services, ...discovered]
}

export function stopOrder(candidates: Service[]) {
  const byName = new Map(candidates.map(service => [service.name.toLowerCase(), service]))
  const remaining = new Set(byName.keys())
  const ordered: Service[] = []
  while (remaining.size) {
    const next = [...remaining].find(name => byName.get(name)?.dependents.every(link => {
      const dependent = link.name.toLowerCase()
      return link.state === 'stopped' || (byName.has(dependent) && !remaining.has(dependent))
    }))
    if (!next) break
    remaining.delete(next)
    ordered.push(byName.get(next)!)
  }
  return { ordered, blocked: [...remaining].map(name => byName.get(name)!) }
}
