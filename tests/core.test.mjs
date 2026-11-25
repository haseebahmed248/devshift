import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classify, stopOrder, workloadRows } from '../dist/core/discovery.js'
import { groupWorkloads } from '../dist/shared/workload-groups.js'
import { Engine } from '../dist/core/engine.js'
import { defaultSettings, UserError } from '../dist/core/model.js'
import { Store } from '../dist/core/store.js'

const balanced = '381b4222-f694-41f0-9685-ff5bb260df2e'
const gaming = '1576cada-8dd7-4e36-a4d0-67dc65346c2b'
const other = 'c6ffd790-9551-4973-b1ff-54d1be1de411'
const stamp = '2026-01-01T10:00:00.000Z'
const fakeSecret = 'fixture-password-not-for-snapshot'
const fingerprint = 'a'.repeat(64)

const processRow = (name, args, extra = {}) => ({
  name, args, pid: 200, parentPid: 100, started: stamp, path: 'C:\\tools\\' + name,
  memoryBytes: 40_000, cpuTicks: 1_000, ...extra,
})

const serviceRow = (name, extra = {}) => ({
  name, label: name, state: 'running', pid: 302, path: 'C:\\Database\\server.exe',
  fingerprint, supported: true, canControl: true, acceptStop: true, limitation: null,
  requires: [], dependents: [], ...extra,
})

const project = {
  id: 'node:api', label: 'Test project', executable: 'C:\\node\\node.exe', entry: 'C:\\project\\index.cjs',
  executableHash: 'b'.repeat(64), entryHash: 'c'.repeat(64), dependencies: ['postgresql-x64-18'],
}
const nodeProcess = processRow('node.exe', ['node.exe', project.entry, fakeSecret], {
  path: project.executable,
})

test('groups verified editor trees once and totals only complete process measurements', () => {
  const code = (pid, parentPid, extra = {}) => processRow('Code.exe', ['Code.exe'], {
    pid, parentPid, privateMemoryBytes: pid * 1024, ...extra,
  })
  const gpu = code(11, 10, { args: ['Code.exe', '--type=gpu-process'], path: 'c:\\TOOLS\\code.EXE' })
  const nested = code(12, 11, { args: ['Code.exe', '--type=renderer', fakeSecret] })
  const root = code(10, 1)
  const independent = code(20, 1)
  const otherInstall = code(21, 10, { path: 'D:\\Apps\\Code.exe' })
  const reusedParent = code(31, 10, { started: '2025-12-01T00:00:00.000Z' })
  const inaccessible = code(40, 10, { path: null })
  const cycle = [code(50, 51), code(51, 50)]
  const processes = [gpu, nested, root, independent, otherInstall, reusedParent, inaccessible, ...cycle]
  const rows = workloadRows({ processes, services: [] }, [], {}, p => p.pid / 10)
  const groups = groupWorkloads(rows)
  const family = groups.find(group => group.root.pid === 10)
  assert.deepEqual(family.members.map(row => row.pid), [10, 11, 12])
  assert.equal(family.members[1].processRole, 'GPU process')
  assert.equal(family.members[2].processRole, 'Renderer')
  assert.equal(family.privateMemoryBytes, 33 * 1024)
  assert.ok(Math.abs(family.cpu - 3.3) < 0.000001)
  assert.equal(groups.length, 7)
  assert.equal(JSON.stringify(groups).includes(fakeSecret), false)

  const incomplete = groupWorkloads(rows.map(row => row.pid === 12 ? { ...row, privateMemoryBytes: null, cpu: null } : row))
  assert.equal(incomplete.find(group => group.root.pid === 10).cpu, null)
  assert.equal(incomplete.find(group => group.root.pid === 10).privateMemoryBytes, null)
  const separate = groupWorkloads([family.root, { ...family.members[1], kind: 'node', approved: true }])
  assert.equal(separate.length, 2)
})

function setup(context) {
  const folder = mkdtempSync(join(tmpdir(), 'devshift-core-'))
  const path = join(folder, 'test.sqlite')
  const databases = []
  context.after(() => {
    for (const db of databases) db.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const open = () => {
    const store = new Store(path)
    databases.push(store)
    return store
  }
  const store = open()
  const services = [
    serviceRow('postgresql-x64-18', { dependents: [{ name: 'MySQL', state: 'running' }] }),
    serviceRow('MySQL', { pid: 303, requires: [{ name: 'postgresql-x64-18', state: 'running' }] }),
    serviceRow('MongoDB', { pid: 304 }),
  ]
  const plans = [{ id: balanced, name: 'Balanced' }, { id: gaming, name: 'Gaming' }, { id: other, name: 'User plan' }]
  const calls = []
  const runtime = { running: true, pid: nodeProcess.pid, failService: '', failNextScan: false, power: balanced, includeNode: true }
  store.settings = { ...defaultSettings, gamingPlan: gaming }

  const host = {
    async read() {
      if (runtime.failNextScan) { runtime.failNextScan = false; throw new UserError('Scan temporarily unavailable.') }
      const rows = services.map(service => ({
        ...service,
        requires: service.requires.map(link => ({ ...link, state: services.find(candidate => candidate.name === link.name)?.state })),
        dependents: service.dependents.map(link => ({ ...link, state: services.find(candidate => candidate.name === link.name)?.state })),
      }))
      const liveProcess = { ...nodeProcess, pid: runtime.pid }
      const scan = { processes: runtime.running ? [liveProcess] : [], power: { active: runtime.power, plans },
        services: rows, installed: [], build: 26300 }
      const nodes = runtime.includeNode ? [{
        configuration: project, ready: runtime.running, state: runtime.running ? 'running' : 'stopped',
        process: runtime.running ? liveProcess : null, sessionId: 'fixture-session', detail: 'Cooperative test project',
      }] : []
      return { scan, nodes, workloads: workloadRows(scan, nodes, store.approvals, () => null),
        scannedAt: new Date().toISOString() }
    },
    async changeService(name, identity, action, pid) {
      calls.push(action + ':' + name)
      const service = services.find(candidate => candidate.name === name)
      assert.equal(service.fingerprint, identity)
      if (runtime.failService === name) throw new UserError('Service temporarily refused control.')
      if (action === 'stop') {
        assert.equal(service.pid, pid)
        assert.ok(service.dependents.every(link => services.find(child => child.name === link.name)?.state === 'stopped'))
      } else {
        assert.ok(service.requires.every(link => services.find(parent => parent.name === link.name)?.state === 'running'))
      }
      service.state = action === 'stop' ? 'stopped' : 'running'
      return { changed: true }
    },
    async changePower(expected, next) {
      assert.equal(runtime.power, expected)
      calls.push('power:' + next)
      runtime.power = next
      return { changed: true }
    },
    async stopNode(config, session, raw) {
      assert.equal(config.id, project.id)
      assert.equal(session, 'fixture-session')
      assert.equal(raw.pid, runtime.pid)
      calls.push('stop:node')
      runtime.running = false
      return { changed: true }
    },
    async startNode() {
      assert.equal(runtime.running, false)
      calls.push('start:node')
      runtime.running = true
      runtime.pid++
      return { changed: true }
    },
  }
  return { store, open, path, services, engine: new Engine(store, host), host, calls, runtime }
}

test('classifies supported development tools without treating an arbitrary runtime process as development', () => {
  assert.equal(classify(processRow('node.exe', ['node.exe', 'sync.cjs']), new Map()), null)
  assert.equal(classify(processRow('node.exe', ['node.exe', 'C:\\project\\node_modules\\vite\\bin\\vite.js']), new Map()), 'Runtime')
  assert.equal(classify(processRow('python.exe', ['python.exe', '-m', 'uvicorn']), new Map()), 'Runtime')
  assert.equal(classify(processRow('python.exe', ['python.exe', 'maintenance.py']), new Map()), null)
  assert.equal(classify(processRow('java.exe', ['java.exe', '-jar', 'launcher.jar']), new Map()), null)
  const parent = processRow('devenv.exe', null, { pid: 100 })
  assert.equal(classify(processRow('dotnet.exe', ['dotnet.exe', 'Project.dll']), new Map([[100, parent]])), 'Runtime')
  assert.equal(classify(processRow('dotnet.exe', ['dotnet.exe', 'Project.dll'], { started: null }), new Map([[100, parent]])), null)
  assert.equal(classify(processRow('studio64.exe', null), new Map()), 'Editor')
})

test('orders managed dependents first and leaves unmanaged active dependents and cycles blocked', () => {
  const parent = serviceRow('Postgres', { dependents: [{ name: 'Worker', state: 'running' }] })
  const child = serviceRow('Worker')
  assert.deepEqual(stopOrder([parent, child]).ordered.map(item => item.name), ['Worker', 'Postgres'])
  assert.deepEqual(stopOrder([parent]).blocked.map(item => item.name), ['Postgres'])
  child.dependents = [{ name: 'Postgres', state: 'running' }]
  assert.equal(stopOrder([parent, child]).ordered.length, 0)
})

test('previews before writing, stops only approved workloads, persists a private snapshot and restores in order', async context => {
  const { store, open, path, engine, host, calls, runtime, services } = setup(context)
  await engine.approve('service:postgresql-x64-18', true)
  await engine.approve('service:mysql', true)
  const review = await engine.review('gaming')
  assert.deepEqual(review.items.map(step => step.label), ['Test project', 'MySQL', 'postgresql-x64-18', 'Power plan'])
  assert.deepEqual(calls, [])
  assert.equal(store.active(), null)

  const result = await engine.execute(review.token)
  assert.equal(result.phase, 'GAMING')
  assert.deepEqual(calls, ['stop:node', 'stop:MySQL', 'stop:postgresql-x64-18', 'power:' + gaming])
  assert.equal(services[2].state, 'running')
  assert.equal(store.active().originalPower, balanced)
  assert.ok(store.active().history.length >= 6)
  assert.ok(!JSON.stringify(store.active()).includes(fakeSecret))
  assert.ok(!readFileSync(path + '-wal').includes(fakeSecret))
  await assert.rejects(engine.execute(review.token), /preview expired/)
  await assert.rejects(engine.review('gaming'), /unavailable/)

  const recovered = new Engine(open(), host)
  const restore = await recovered.review('development')
  assert.deepEqual(restore.items.map(step => step.label), ['Power plan', 'postgresql-x64-18', 'MySQL', 'Test project'])
  assert.equal((await recovered.execute(restore.token)).phase, 'DEVELOPMENT')
  assert.deepEqual(calls.slice(4), ['power:' + balanced, 'start:postgresql-x64-18', 'start:MySQL', 'start:node'])
  assert.equal(runtime.running, true)
  assert.equal(store.active(), null)
  await assert.rejects(recovered.review('development'), /unavailable/)
})

test('rejects stale confirmations and changed service approvals', async context => {
  const { store, engine, services, calls } = setup(context)
  await engine.approve('service:mysql', true)
  const review = await engine.review('gaming')
  services[1].fingerprint = 'd'.repeat(64)
  await assert.rejects(engine.execute(review.token), /changed after review/)
  assert.equal(store.active(), null)
  assert.equal((await engine.dashboard(true)).workloads.find(row => row.id === 'service:mysql').approved, false)
  assert.deepEqual(calls, [])
})

test('retains a failed restoration for retry and does not start an unrelated dependency or duplicate the project', async context => {
  const { store, engine, calls, runtime } = setup(context)
  await engine.approve('service:mysql', true)
  await engine.execute((await engine.review('gaming')).token)
  runtime.failService = 'MySQL'
  runtime.power = other
  const result = await engine.execute((await engine.review('development')).token)
  assert.equal(result.hasSnapshot, true)
  assert.equal(result.phase, 'PARTIAL_SUCCESS')
  assert.equal(runtime.power, other)
  assert.equal(store.active().steps.find(step => step.id === 'service:mysql').development.status, 'failed')
  assert.equal(calls.filter(call => call === 'start:node').length, 1)
  runtime.failService = ''
  const retry = await engine.review('resume')
  assert.deepEqual(retry.items.map(step => step.label), ['MySQL'])
  assert.equal((await engine.execute(retry.token)).hasSnapshot, false)
  assert.equal(calls.filter(call => call === 'start:node').length, 1)
  assert.ok(!calls.includes('start:postgresql-x64-18'))
})

test('detects an interrupted intent and restores a completed stop after reopening SQLite', async context => {
  const { store, open, engine, host, runtime, calls } = setup(context)
  await engine.execute((await engine.review('gaming')).token)
  const journal = store.active()
  journal.phase = 'SWITCHING_TO_GAMING'
  journal.steps[0].gaming.status = 'running'
  journal.steps[0].gaming.effect = 'possible'
  store.save(journal, true)

  const afterCrash = new Engine(open(), host)
  assert.equal(afterCrash.state().phase, 'RECOVERY_REQUIRED')
  assert.equal(runtime.running, false)
  const recovery = await afterCrash.review('development')
  assert.equal(recovery.recovery, true)
  assert.equal((await afterCrash.execute(recovery.token)).phase, 'DEVELOPMENT')
  assert.equal(runtime.running, true)
  assert.equal(runtime.power, balanced)
  assert.equal(calls.filter(call => call === 'stop:node').length, 1)
})

test('serializes transitions and preserves external changes when closing recovery', async context => {
  const { store, engine, host, runtime, calls } = setup(context)
  const running = engine.review('gaming')
  await assert.rejects(engine.review('gaming'), /already working/)
  const review = await running
  await engine.execute(review.token)
  const journal = store.active()
  journal.phase = 'RECOVERY_REQUIRED'
  store.save(journal, true)
  const recovery = new Engine(store, host)
  const keep = await recovery.review('keep')
  assert.equal(keep.keep, true)
  const before = calls.length
  await recovery.execute(keep.token)
  assert.equal(runtime.power, gaming)
  assert.equal(store.active(), null)
  assert.equal(calls.length, before)
})

test('saves the start at login setting', context => {
  const { store } = setup(context)
  assert.equal(store.settings.startAtLogin, false)
  store.settings = { ...store.settings, startAtLogin: true }
  assert.equal(store.settings.startAtLogin, true)
})
