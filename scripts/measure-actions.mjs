// Measures what throttling and pausing apps frees, using only throwaway processes this script starts (issue #12).
//   npm run measure:actions                    CPU and Pause checks, about three minutes
//   npm run measure:actions -- --low-memory    also simulates a low-memory PC, which can slow other apps for a moment
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { Agent, get } from 'node:http'
import { availableParallelism, cpus, release, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = name => join(root, 'tests', 'fixtures', 'measure', name)
const helperPath = join(root, 'dist', 'native', 'DevShift.Windows.exe')
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const exec = promisify(execFile)
const MB = 1024 ** 2
const GB = 1024 ** 3
const powerModes = {
  '961cc777-2547-4f9d-8174-7d86181b8a7a': 'Best power efficiency', '00000000-0000-0000-0000-000000000000': 'Balanced',
  '3af9b8d9-7c97-431d-ad78-34a8bfea439f': 'Better performance', 'ded574b5-45a0-4f42-8737-46345c09c238': 'Best performance',
}
const children = new Set()
const paused = new Map()

async function helper(...args) {
  const { stdout } = await exec(helperPath, args.map(String), { windowsHide: true }).catch(error => ({ stdout: error.stdout ?? '' }))
  let reply
  try { reply = JSON.parse(stdout) } catch { throw new Error(`The helper didn't answer "${args[0]}". Run npm run build:native first.`) }
  if (!reply.ok) throw new Error(`${args[0]}: ${reply.message}`)
  return reply.value
}

const parse = line => { try { return JSON.parse(line) } catch { return line } }

function launch(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const name = basename(args.find(arg => /\.(cjs|ps1)$/.test(arg)) ?? command)
  const listeners = new Set()
  children.add(child)
  child.once('exit', () => children.delete(child))
  createInterface({ input: child.stdout }).on('line', line => { const value = parse(line); for (const listener of listeners) listener(value) })
  child.listen = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  child.next = (match, timeout = 120_000) => new Promise((resolve, reject) => {
    const finish = (error, value) => { stop(); clearTimeout(timer); child.off('exit', exited); if (error) reject(error); else resolve(value) }
    const exited = () => finish(new Error(`${name} exited before it replied.`))
    const timer = setTimeout(() => finish(new Error(`${name} didn't reply in time.`)), timeout)
    const stop = child.listen(value => { if (match(value)) finish(null, value) })
    child.once('exit', exited)
  })
  return child
}

const node = (file, ...args) => launch(process.execPath, [fixture(file), ...args.map(String)])

function track(child) {
  child.samples = []
  child.listen(line => {
    const [units, ms] = String(line).split(' ').map(Number)
    if (ms > 0) child.samples.push({ at: performance.now(), units, ms })
  })
  return child
}

// Work per second summed over processes, from the reports each one sent between the two times.
const rate = (group, from, to) => group.reduce((total, child) => {
  const inside = child.samples.filter(sample => sample.at > from && sample.at <= to)
  const ms = inside.reduce((sum, sample) => sum + sample.ms, 0)
  return total + (ms > 0 ? inside.reduce((sum, sample) => sum + sample.units, 0) / ms * 1000 : 0)
}, 0)

async function identity(pid) {
  const info = await helper('process', pid)
  if (!info?.started) throw new Error(`Couldn't read the start time of process ${pid}.`)
  return { pid, started: info.started }
}

async function pause(target) {
  const result = await helper('pause', target.pid, target.started)
  paused.set(target.pid, target)
  return result
}

async function resume(target) {
  await helper('resume', target.pid, target.started)
  paused.delete(target.pid)
}

async function throttle(target) {
  target.previous = await helper('throttle', target.pid, target.started)
}

async function unthrottle(target) {
  const { priority, controlMask, stateMask } = target.previous
  await helper('unthrottle', target.pid, target.started, priority, controlMask, stateMask)
}

async function cleanup() {
  for (const target of paused.values()) await helper('resume', target.pid, target.started).catch(() => {})
  paused.clear()
  for (const child of children) child.kill()
}

const gb = bytes => (bytes / GB).toFixed(1) + ' GB'
const mb = bytes => Math.round(bytes / MB).toLocaleString('en-US') + ' MB'
const signedMb = bytes => (bytes >= 0 ? '+' : '−') + mb(Math.abs(bytes))
const time = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms >= 10 ? Math.round(ms) + ' ms' : ms.toFixed(1) + ' ms'
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const thousands = value => Math.round(value).toLocaleString('en-US')
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.join(' | ') + ' |').join('\n')

function describe(machine) {
  const classes = [...new Set(machine.cpuSets.map(set => set.efficiencyClass))]
  const fastest = Math.max(...classes)
  const fast = machine.cpuSets.filter(set => set.efficiencyClass === fastest).length
  const cores = classes.length > 1 ? `${fast} in the fastest class and ${machine.cpuSets.length - fast} efficiency` : 'no efficiency cores'
  const mode = machine.powerMode && (powerModes[machine.pluggedIn === false ? machine.powerMode.dc : machine.powerMode.ac] ?? 'a custom power mode')
  const power = machine.battery ? `Laptop ${machine.pluggedIn ? 'plugged in' : 'on battery'}` : 'Desktop'
  return [
    `- Windows ${release()}, ${cpus()[0].model.trim()}, ${availableParallelism()} logical processors (${cores})`,
    `- ${gb(machine.totalMemory)} RAM, ${gb(machine.availableMemory)} available, ${gb(machine.commitAvailable)} of ${gb(machine.commitLimit)} commit available`,
    `- ${power}${mode ? `, power mode ${mode}${machine.powerMode.energySaver ? ' with Energy Saver on' : ''}` : ''}`,
  ].join('\n')
}

async function coreLoad(seconds) {
  const before = await helper('processor-times')
  await sleep(seconds * 1000)
  const after = await helper('processor-times')
  return after.map((entry, index) => (entry.busy - before[index].busy) / Math.max(1, entry.total - before[index].total))
}

function byClass(load, machine) {
  const fastest = Math.max(...machine.cpuSets.map(set => set.efficiencyClass))
  const sums = { all: 0, efficiency: 0 }
  for (const set of machine.cpuSets.filter(set => set.group === 0)) {
    sums.all += load[set.index] ?? 0
    if (set.efficiencyClass < fastest) sums.efficiency += load[set.index] ?? 0
  }
  return sums
}

async function measureCpu(machine) {
  const logical = availableParallelism()
  const gameCount = Math.min(8, Math.max(2, Math.floor(logical / 2)))
  const backgroundCount = Math.min(4, Math.max(1, Math.floor(logical / 4)))
  const background = Array.from({ length: backgroundCount }, () => track(node('busy.cjs')))
  const targets = await Promise.all(background.map(child => identity(child.pid)))
  let state = 'normal'
  const enter = async next => {
    for (const target of targets) {
      if (state === 'paused') await resume(target)
      if (state === 'throttled') await unthrottle(target)
      if (next === 'paused') await pause(target)
      if (next === 'throttled') await throttle(target)
    }
    state = next
  }

  const placement = {}
  for (const next of ['paused', 'normal', 'throttled']) {
    await enter(next)
    await sleep(1500)
    placement[next] = byClass(await coreLoad(4), machine)
  }

  const game = Array.from({ length: gameCount }, () => track(node('busy.cjs')))
  await sleep(2000)
  const order = ['normal', 'throttled', 'paused']
  const results = { normal: [], throttled: [], paused: [] }
  for (let round = 0; round < 3; round++) {
    for (const next of [...order.slice(round), ...order.slice(0, round)]) {
      if (next !== state) await enter(next)
      await sleep(1500)
      const from = performance.now()
      await sleep(5000)
      const to = performance.now()
      results[next].push({ game: rate(game, from, to), background: rate(background, from, to) })
    }
  }
  await enter('normal')
  for (const child of [...game, ...background]) child.kill()

  const hybrid = new Set(machine.cpuSets.map(set => set.efficiencyClass)).size > 1
  const where = name => {
    const busy = placement[name].all - placement.paused.all
    const efficiency = placement[name].efficiency - placement.paused.efficiency
    return `${busy.toFixed(1)} cores busy` + (hybrid ? `, ${Math.round(Math.max(0, Math.min(1, efficiency / busy)) * 100)}% of it on efficiency cores` : '')
  }
  const baseline = median(results.paused.map(result => result.game))
  const row = (label, name) => {
    const gameRate = median(results[name].map(result => result.game))
    const change = (gameRate / baseline - 1) * 100
    return [label, thousands(gameRate), name === 'paused' ? 'baseline' : `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`,
      thousands(median(results[name].map(result => result.background)))]
  }
  return [
    '### Throttle: does background work slow a game down?',
    '',
    `${gameCount} busy processes stand in for a game, and ${backgroundCount} for background apps that keep working, such as dev servers and watchers. Work per second is the median of 3 rounds.`,
    '',
    table(['Background apps', 'Game work per second', 'Game compared with background paused', 'Background work per second'], [
      row('Running normally', 'normal'), row('Throttled', 'throttled'), row('Paused', 'paused'),
    ]),
    '',
    `Where the background work ran before the game started: normally ${where('normal')}; throttled ${where('throttled')}.`,
    '',
    `Game work with background paused, by round: ${results.paused.map(result => thousands(result.game)).join(', ')}. A steady drop suggests the PC was heating up.`,
  ].join('\n')
}

const answers = (port, timeout, agent = false) => new Promise(resolve => {
  const request = get({ host: '127.0.0.1', port, path: '/', agent, timeout }, response => {
    response.resume()
    response.on('end', () => resolve(true))
  })
  request.on('timeout', () => { request.destroy(); resolve(false) })
  request.on('error', () => resolve(false))
})

async function measurePause(fill) {
  const hog = node('hog.cjs', 2048, fill, 'idle')
  try {
    const { port } = await hog.next(value => value.ready)
    const target = await identity(hog.pid)
    hog.stdin.write('touch\n')
    const resident = (await hog.next(value => value.touched !== undefined)).touched
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    await answers(port, 3000, agent)
    const before = await helper('machine')
    const pausedAt = performance.now()
    const trimmed = await pause(target)
    const gained = []
    let whilePaused
    for (const at of [0.5, 2, 5, 10]) {
      await sleep(Math.max(0, pausedAt + at * 1000 - performance.now()))
      const now = await helper('machine')
      gained.push({ memory: now.availableMemory - before.availableMemory, commit: now.commitAvailable - before.commitAvailable })
      if (at === 2) whilePaused = await answers(port, 1500)
    }
    await resume(target)
    const resumedAt = performance.now()
    hog.stdin.write('ping\n')
    await hog.next(value => value.pong === true)
    const responded = performance.now() - resumedAt
    const fresh = await answers(port, 3000)
    const kept = await answers(port, 3000, agent)
    hog.stdin.write('touch\n')
    const pagedIn = (await hog.next(value => value.touched !== undefined)).touched
    agent.destroy()
    return { fill, trimmed, gained, whilePaused, responded, fresh, kept, resident, pagedIn }
  } finally {
    hog.kill()
  }
}

async function measureWindow() {
  const charmap = spawn(join(system32, 'charmap.exe'), [], { stdio: 'ignore' })
  children.add(charmap)
  charmap.once('exit', () => children.delete(charmap))
  try {
    await sleep(2000)
    const target = await identity(charmap.pid)
    const responding = async () => (await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${charmap.pid}).Responding`], { windowsHide: true })).stdout.trim() === 'True'
    const before = await responding()
    await pause(target)
    await sleep(6000)
    const whilePaused = await responding()
    await resume(target)
    await sleep(1000)
    return { before, whilePaused, after: await responding() }
  } finally {
    charmap.kill()
  }
}

function pauseReport(runs, window) {
  const yes = value => value ? 'yes' : 'no'
  return [
    '### Pause: how much memory comes back, and does the app recover?',
    '',
    'A throwaway process holds 2 GB and serves HTTP, like an idle dev server. "Random" memory doesn\'t compress at all; "mixed" compresses about 2:1, closer to real apps. Available-memory changes also include whatever other apps did at the same moment.',
    '',
    table(['App memory', 'Working set before → after', 'Available after 0.5 s', '2 s', '5 s', '10 s', 'Commit change after 10 s'],
      runs.map(run => [run.fill, `${mb(run.trimmed.workingSetBefore)} → ${mb(run.trimmed.workingSetAfter)}`,
        ...run.gained.map(gain => signedMb(gain.memory)), signedMb(run.gained.at(-1).commit)])),
    '',
    table(['App memory', 'First reply after resume', 'Reading all its memory before pause', 'Reading all its memory after resume', 'HTTP answered while paused', 'HTTP after resume (new, kept-alive connection)'],
      runs.map(run => [run.fill, time(run.responded), time(run.resident), time(run.pagedIn), yes(run.whilePaused), `${yes(run.fresh)}, ${yes(run.kept)}`])),
    '',
    window
      ? `Character Map, a window app: responding before ${yes(window.before)}, while paused ${yes(window.whilePaused)}, after resume ${yes(window.after)}.`
      : 'Character Map wasn\'t available, so the window check was skipped.',
  ].join('\n')
}

async function lowMemoryRun(hogMB, gameMB, activity, action) {
  const hog = node('hog.cjs', hogMB, 'mixed', activity)
  let filler
  let target
  try {
    await hog.next(value => value.ready)
    target = await identity(hog.pid)
    const fillerMB = Math.floor(((await helper('machine')).availableMemory - gameMB * MB - GB) / MB)
    if (fillerMB > 256) {
      const disk = statfsSync(tmpdir())
      if (disk.bavail * disk.bsize < fillerMB * MB + 5 * GB) return { activity, action, skipped: `It needs ${gb(fillerMB * MB + 5 * GB)} of free disk space.` }
      filler = launch(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', fixture('pressure.ps1'),
        join(tmpdir(), `devshift-pressure-${randomUUID()}.tmp`), String(fillerMB)])
      await filler.next(value => value === 'ready', 300_000)
    }
    await sleep(3000)
    if (action === 'pause') await pause(target)
    await sleep(3000)
    const free = (await helper('machine')).availableMemory

    const game = node('game.cjs', gameMB, 5)
    let lowest = Infinity
    let aborted = false
    let watching = true
    const watch = (async () => {
      while (watching) {
        const { availableMemory } = await helper('machine').catch(() => ({ availableMemory: Infinity }))
        lowest = Math.min(lowest, availableMemory)
        if (availableMemory < 512 * MB) { aborted = true; game.kill(); filler?.kill() }
        await sleep(500)
      }
    })()
    const result = await game.next(value => value.allocation !== undefined).catch(error => { if (aborted) return null; throw error })
    watching = false
    await watch
    const resident = (await helper('process', hog.pid))?.memoryBytes
    return { activity, action, free, lowest, result, aborted, resident }
  } finally {
    if (target && paused.has(target.pid)) await resume(target)
    filler?.kill()
    hog.kill()
  }
}

async function measureLowMemory(machine) {
  const hogMB = 2048
  const gameMB = 3072
  const reserve = Math.max(4 * GB, machine.commitLimit * 0.1)
  const intro = [
    '### Low memory: does pausing a background app help a game that needs memory?',
    '',
    `A background app holds ${gb(hogMB * MB)}. Another process takes physical memory, without using commit, until about ${gb(gameMB * MB + GB)} is available. Then a stand-in game allocates ${gb(gameMB * MB)} and touches every page for 5 seconds, like frames. "Active" apps keep writing to their memory; "idle" ones don't.`,
    '',
  ]
  if (machine.commitAvailable - (hogMB + gameMB) * MB < reserve)
    return [...intro, `Skipped: ${gb(machine.commitAvailable)} of commit is available, and this test needs ${gb((hogMB + gameMB) * MB)} plus a ${gb(reserve)} safety margin so other apps can't run out of memory.`].join('\n')
  const runs = []
  for (const activity of ['idle', 'active']) for (const action of ['none', 'pause']) {
    runs.push(await lowMemoryRun(hogMB, gameMB, activity, action))
    await sleep(5000)
  }
  return [...intro, table(
    ['Background app', 'Action', 'Available before the game', 'Lowest during the game', 'Allocating 3 GB', 'Slowest 128 MB step', 'Median frame', 'Slowest frame', 'App memory still in RAM'],
    runs.map(run => {
      const label = [run.activity, run.action === 'pause' ? 'paused' : 'left running']
      if (run.skipped) return [...label, `Skipped: ${run.skipped}`, '', '', '', '', '', '']
      if (run.aborted) return [...label, gb(run.free), gb(run.lowest), 'Stopped: available memory fell below 512 MB', '', '', '', '']
      return [...label, gb(run.free), gb(run.lowest), time(run.result.allocation), time(run.result.slowestChunk),
        time(run.result.medianPass), time(run.result.slowestPass), run.resident === undefined ? 'unknown' : mb(run.resident)]
    }),
  )].join('\n')
}

if (process.platform !== 'win32') throw new Error('This measurement needs Windows.')
const lowMemory = process.argv.includes('--low-memory')
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
const startedAt = Date.now()
try {
  const machine = await helper('machine')
  console.error('Measuring. This uses only processes it starts. Character Map opens for a few seconds.')
  if (lowMemory) console.error('The low-memory part takes about two minutes, and other apps may respond slowly for a moment afterwards.')
  const sections = ['## Throttle and Pause measurements', '', describe(machine)]
  console.error('Throttle...')
  sections.push('', await measureCpu(machine))
  console.error('Pause...')
  const runs = [await measurePause('random'), await measurePause('mixed')]
  const window = await measureWindow().catch(() => undefined)
  sections.push('', pauseReport(runs, window))
  if (lowMemory) {
    console.error('Low memory...')
    sections.push('', await measureLowMemory(machine))
  }
  sections.push('', `_Measured in ${Math.round((Date.now() - startedAt) / 1000)} s with \`npm run measure:actions${lowMemory ? ' -- --low-memory' : ''}\`._`)
  console.log(sections.join('\n'))
} finally {
  await cleanup()
}
