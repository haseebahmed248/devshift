import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { test } from 'node:test'
import { devServerLabel, workloadRows } from '../dist/core/discovery.js'
import { Engine } from '../dist/core/engine.js'
import { Store } from '../dist/core/store.js'

const MB = 1024 ** 2
const balancedMode = '00000000-0000-0000-0000-000000000000'
const bestMode = 'ded574b5-45a0-4f42-8737-46345c09c238'
const balancedPlan = '381b4222-f694-41f0-9685-ff5bb260df2e'
const secret = 'fixture-token-not-for-journal'
const code = 'C:\\Apps\\Code\\Code.exe'
const devenv = 'C:\\VS\\Common7\\IDE\\devenv.exe'
const node = 'C:\\node\\node.exe'
const npmCli = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'

// Creation times increase with `order`, so every child starts after its parent.
const process = (pid, parentPid, name, path, args, megabytes, order, extra = {}) => ({
  name, pid, parentPid, path, args, started: `2026-01-01T10:${String(order).padStart(2, '0')}:00.0000000Z`,
  memoryBytes: megabytes === null ? null : megabytes * MB * 2, privateMemoryBytes: megabytes === null ? null : megabytes * MB,
  cpuTicks: 1_000, ...extra,
})

/** A developer PC: VS Code with `npm run dev` in its terminal, Visual Studio with a solution, build servers, and LocalDB. */
const developerPc = () => [
  process(10, 1, 'explorer.exe', null, null, null, 0),
  process(100, 10, 'Code.exe', code, [code], 500, 1),
  process(101, 100, 'Code.exe', code, [code, '--type=renderer'], 300, 2),
  process(102, 100, 'pwsh.exe', null, null, null, 3),
  process(103, 102, 'node.exe', node, [node, npmCli, 'run', 'dev', '--', '--token=' + secret], 50, 4, { cwd: 'C:\\work\\shop' }),
  process(104, 103, 'cmd.exe', null, null, null, 5),
  process(105, 104, 'node.exe', node, [node, 'C:\\work\\shop\\node_modules\\vite\\bin\\vite.js'], 200, 6, { cwd: 'C:\\work\\shop' }),
  process(200, 10, 'devenv.exe', devenv, [devenv, 'C:\\work\\Api.sln'], 900, 7),
  process(201, 200, 'ServiceHub.RoslynCodeAnalysisService.exe', null, null, 400, 8),
  process(300, 10, 'VBCSCompiler.exe', 'C:\\VS\\Roslyn\\VBCSCompiler.exe', ['VBCSCompiler.exe', '-pipename:abc'], 150, 9),
  process(301, 10, 'MSBuild.exe', 'C:\\VS\\MSBuild\\MSBuild.exe', ['MSBuild.exe', '/nodemode:1', '/nodeReuse:true'], 100, 10),
  process(400, 10, 'sqlservr.exe', 'C:\\Program Files\\Microsoft SQL Server\\170\\LocalDB\\Binn\\sqlservr.exe', ['sqlservr.exe', '-c'], 250, 11),
]

function setup(context, { selfPid, leaveOpen = [], extra = [] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'devshift-switch-'))
  const path = join(folder, 'test.sqlite')
  const store = new Store(path)
  context.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }) })
  const world = { processes: [...developerPc(), ...extra], modes: { ac: balancedMode, dc: balancedMode }, nextPid: 1000, calls: [] }
  const tree = root => {
    const members = [root]
    for (let index = 0; index < members.length; index++)
      for (const child of world.processes) if (child.parentPid === members[index]) members.push(child.pid)
    return members
  }
  const remove = pids => { world.processes = world.processes.filter(entry => !pids.includes(entry.pid)) }
  const spawned = (name, executable, args, extraFields) =>
    world.processes.push(process(world.nextPid++, 10, name, executable, [executable, ...args], 100, 30, extraFields))
  const unexpected = name => () => { throw new Error('Unexpected host call: ' + name) }

  const host = {
    async read() {
      const scan = {
        processes: world.processes.map(entry => ({ ...entry })), services: [], installed: [], build: 26300,
        power: { active: balancedPlan, plans: [{ id: balancedPlan, name: 'Balanced' }] },
        powerMode: { ...world.modes, pluggedIn: true, energySaver: false },
      }
      return { scan, nodes: [], workloads: workloadRows(scan, [], {}, () => null), scannedAt: new Date().toISOString(), selfPid }
    },
    async closeApp(identity) {
      world.calls.push('close:' + identity.pid)
      if (leaveOpen.includes(identity.pid)) return { changed: false, skipped: true, message: 'It is still open. It may be asking you to save your work.' }
      remove(tree(identity.pid))
      return { changed: true }
    },
    async openApp(launch) {
      world.calls.push('open:' + [launch.executable, ...launch.args].join(' '))
      spawned(win32.basename(launch.executable), launch.executable, launch.args)
      return { changed: true }
    },
    async stopDevServer(identity) {
      world.calls.push('ctrl-c:' + identity.pid)
      remove(tree(identity.pid))
      return { changed: true }
    },
    async startDevServer(launch) {
      world.calls.push('terminal:' + launch.cwd + ' ' + launch.args.join(' '))
      spawned('node.exe', launch.executable, launch.args, { cwd: launch.cwd })
      return { changed: true }
    },
    async stopBuildServers(identities) {
      world.calls.push('build-servers:' + identities.map(identity => identity.pid).join(','))
      remove(identities.map(identity => identity.pid))
      return { changed: true }
    },
    async stopLocalDb(identities) {
      world.calls.push('localdb:' + identities.map(identity => identity.pid).join(','))
      remove(identities.map(identity => identity.pid))
      return { changed: true }
    },
    async changePowerMode(expected, next) {
      assert.deepEqual(expected, world.modes)
      world.calls.push('power-mode:' + next.ac + '/' + next.dc)
      world.modes = { ...next }
      return { changed: true }
    },
    async seal(value) { return 'sealed:' + Buffer.from(value).toString('base64') },
    async unseal(value) {
      assert.ok(value.startsWith('sealed:'))
      return Buffer.from(value.slice(7), 'base64').toString()
    },
    changeService: unexpected('changeService'), changePower: unexpected('changePower'),
    stopNode: unexpected('stopNode'), startNode: unexpected('startNode'),
  }
  return { store, path, world, engine: new Engine(store, host) }
}

test('closes editors, stops dev servers, build servers, and LocalDB, then restores everything in reverse', async context => {
  const { store, path, world, engine } = setup(context)
  const review = await engine.review('gaming')
  assert.deepEqual(review.items.map(item => item.label),
    ['npm run dev · shop', 'Visual Studio Code', 'Visual Studio · Api', 'Build servers', 'SQL Server LocalDB', 'Power mode'])
  assert.deepEqual(review.items.map(item => item.memoryBytes), [250 * MB, 800 * MB, 1300 * MB, 250 * MB, 250 * MB, null])
  assert.ok(review.items.every(item => item.selected))
  assert.ok(!JSON.stringify(review).includes(secret))
  assert.deepEqual(world.calls, [])

  const result = await engine.execute(review.token)
  assert.equal(result.phase, 'GAMING')
  assert.equal(result.summary, 'Gaming Mode is active. Windows state was verified.')
  assert.deepEqual(world.calls,
    ['ctrl-c:103', 'close:100', 'close:200', 'build-servers:300,301', 'localdb:400', 'power-mode:' + bestMode + '/' + bestMode])
  const journal = JSON.stringify(store.active())
  for (const plaintext of [secret, 'npm-cli.js', 'Api.sln']) assert.ok(!journal.includes(plaintext), plaintext + ' reached the journal')
  assert.ok(!readFileSync(path + '-wal').includes(secret))

  const restore = await engine.review('development')
  assert.deepEqual(restore.items.map(item => item.label),
    ['Power mode', 'SQL Server LocalDB', 'Build servers', 'Visual Studio · Api', 'Visual Studio Code', 'npm run dev · shop'])
  assert.equal((await engine.execute(restore.token)).phase, 'DEVELOPMENT')
  assert.deepEqual(world.calls.slice(6), [
    'power-mode:' + balancedMode + '/' + balancedMode,
    'open:' + devenv + ' C:\\work\\Api.sln',
    'open:' + code,
    'terminal:C:\\work\\shop ' + npmCli + ' run dev -- --token=' + secret,
  ])
  assert.equal(store.active(), null)
})

test('skips unticked actions, remembers them, and never reopens an editor that stayed open', async context => {
  const { store, world, engine } = setup(context, { leaveOpen: [100] })
  const review = await engine.review('gaming')
  await assert.rejects(engine.execute(review.token, ['app:999']), /preview changed/)

  const second = await engine.review('gaming')
  const result = await engine.execute(second.token, ['app:200'])
  assert.ok(!world.calls.includes('close:200'))
  assert.deepEqual(store.skips, ['app:devenv.exe'])
  assert.equal(result.phase, 'PARTIAL_SUCCESS')
  const steps = store.active().steps
  assert.ok(!steps.some(step => step.id === 'app:200'))
  const vscode = steps.find(step => step.id === 'app:100')
  assert.equal(vscode.gaming.status, 'skipped')
  assert.equal(vscode.gaming.effect, 'possible')

  const restore = await engine.review('development')
  assert.ok(restore.items.some(item => item.id === 'app:100'))
  assert.equal((await engine.execute(restore.token)).phase, 'DEVELOPMENT')
  assert.ok(!world.calls.some(call => call.startsWith('open:' + code)))

  const next = await engine.review('gaming')
  assert.equal(next.items.find(item => item.label === 'Visual Studio · Api').selected, false)
  assert.equal(next.items.find(item => item.label === 'Visual Studio Code').selected, true)
})

test('keeps open the editor that DevShift itself runs from', async context => {
  const devshift = process(106, 102, 'electron.exe', 'C:\\work\\devshift\\electron.exe', null, 120, 12)
  const { engine } = setup(context, { selfPid: 106, extra: [devshift] })
  const review = await engine.review('gaming')
  assert.ok(!review.items.some(item => item.label === 'Visual Studio Code'))
  assert.ok(review.notices.includes('Visual Studio Code stays open because DevShift is running from it.'))
  assert.ok(review.items.some(item => item.label === 'Visual Studio · Api'))
})

test('names dev servers without exposing their arguments', () => {
  const runtime = (args, cwd) => process(1, 0, 'node.exe', node, args, null, 1, { cwd })
  assert.equal(devServerLabel(runtime([node, npmCli, 'run', 'dev', '--token=' + secret], 'C:\\work\\shop')), 'npm run dev · shop')
  assert.equal(devServerLabel(runtime([node, npmCli, 'start'], 'C:\\work\\api')), 'npm start · api')
  assert.equal(devServerLabel(runtime([node, npmCli, 'run', 'dev --token=' + secret], null)), 'npm run')
  assert.equal(devServerLabel(runtime([node, 'C:\\work\\api\\node_modules\\nodemon\\bin\\nodemon.js', secret], 'C:\\work\\api')), 'node nodemon.js · api')
  const watch = { ...process(2, 0, 'dotnet.exe', 'C:\\dotnet\\dotnet.exe', ['dotnet.exe', 'watch', 'run'], null, 1), cwd: 'C:\\work\\Api' }
  assert.equal(devServerLabel(watch), 'dotnet watch · Api')
})
