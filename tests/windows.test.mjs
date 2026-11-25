import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { availableParallelism, cpus, freemem, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { groupWorkloads } from '../dist/shared/workload-groups.js'
import { defaultSettings } from '../dist/core/model.js'
import { Store } from '../dist/core/store.js'
import { createConfiguration } from '../dist/main/node-runtime.js'
import { Windows } from '../dist/main/windows.js'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = new Windows(join(root, 'dist', 'native', 'DevShift.Windows.exe'))
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const artifact = join(root, 'artifacts')
const testBinary = process.env.DEVSHIFT_TEST_PACKAGED === '1' ? join(root, 'out', 'DevShift-win32-x64', 'DevShift.exe') : electronPath

async function until(read, accepts, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await read()
      if (accepts(last)) return last
    } catch (error) { last = error.message }
    await delay(100)
  }
  assert.fail(label + ' timed out. Last result: ' + String(JSON.stringify(last)).slice(0, 500))
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function connect(address) {
  const socket = new WebSocket(address)
  const requests = new Map()
  let next = 0
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data)
    const job = requests.get(value.id)
    if (!job) return
    requests.delete(value.id)
    clearTimeout(job.timer)
    if (value.error) job.reject(new Error(value.error.message))
    else job.resolve(value.result)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Cannot connect to the isolated Chromium session.')), { once: true })
  })

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(method + ' timed out.')) }, 5_000)
      requests.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) } catch (error) {
        clearTimeout(timer)
        requests.delete(id)
        reject(error)
      }
    })
  }

  return {
    send,
    close: () => socket.close(),
    evaluate: async (fn, ...args) => {
      const expression = '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')'
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
      return response.result.value
    },
  }
}

async function launch(profile, binary = testBinary, switches = []) {
  const port = await freePort()
  const args = ['--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', ...switches]
  if (binary === electronPath) args.push(root)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
  const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { output = (output + text).slice(-2500) })
  let launchError
  child.once('error', error => { launchError = error })
  try {
    const endpoint = 'http://127.0.0.1:' + port
    const target = await until(async () => {
      if (launchError) throw launchError
      const response = await fetch(endpoint + '/json/list')
      const pages = await response.json()
      return pages.find(page => page.type === 'page' && page.url.endsWith('/dist/renderer/index.html'))
    }, Boolean, 'DevShift renderer launch', 20_000)
    const browserState = await (await fetch(endpoint + '/json/version')).json()
    return { child, ui: await connect(target.webSocketDebuggerUrl), browser: await connect(browserState.webSocketDebuggerUrl) }
  } catch (error) {
    if (!exited(child) && child.pid) child.kill()
    throw new Error(error.message + '\n' + output)
  }
}

async function click(ui, name, scope = 'body') {
  const selected = await until(() => ui.evaluate((label, area) => {
    const element = [...(document.querySelector(area)?.querySelectorAll('button') ?? [])].find(item =>
      !item.disabled && (item.getAttribute('aria-label') === label || item.textContent.trim() === label))
    if (!element) return false
    element.click()
    return true
  }, name, scope), Boolean, 'Click ' + name)
  assert.ok(selected)
}

// The Gaming preview also lists the tester's real editors, dev servers, and power mode. Untick everything except
// the test's own workload, so a test run never closes or stops anything on the machine.
async function keepOnly(ui, label) {
  const ticked = await until(() => ui.evaluate(name => {
    const rows = [...(document.querySelector('dialog')?.querySelectorAll('.action-list li') ?? [])]
    if (!rows.length && !document.querySelector('dialog .empty')) return null
    if (name && !rows.some(row => row.textContent.includes(name))) return null
    for (const row of rows) {
      const box = row.querySelector('input[type=checkbox]')
      const keep = !!name && row.textContent.includes(name)
      if (box && box.checked !== keep) box.click()
    }
    return rows.filter(row => row.querySelector('input[type=checkbox]')?.checked).map(row => row.textContent)
  }, label), result => Array.isArray(result) && result.length === (label ? 1 : 0) && result.every(text => text.includes(label)),
  'Keep only ' + (label ?? 'nothing') + ' ticked')
  assert.equal(ticked.length, label ? 1 : 0)
}

function rendered(ui, text) {
  return until(() => ui.evaluate(needle => ({ found: document.body.innerText.includes(needle), view: document.body.innerText.slice(0, 400) }), text),
    value => value.found, 'Text ' + text)
}

const exited = child => child.exitCode !== null || child.signalCode !== null
const loadMarker = (folder) => readFile(join(folder, 'ready.json'), 'utf8').then(JSON.parse)
const http = async marker => {
  const response = await fetch('http://127.0.0.1:' + marker.port, { signal: AbortSignal.timeout(2_000) })
  return Number(await response.text())
}

async function configureFixture(base, name) {
  const folder = join(base, name)
  const entry = join(folder, 'server.cjs')
  await mkdir(folder)
  await copyFile(join(root, 'tests', 'fixtures', 'server.cjs'), entry)
  return { folder, entry }
}

function powershell(code) {
  return exec(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true })
}

async function exitWindow(instance) {
  await instance.ui.evaluate(() => {
    const button = document.querySelector('button[aria-label="Quit DevShift"]')
    if (!button || button.disabled) throw new Error('Quit DevShift is unavailable.')
    window.setTimeout(() => button.click(), 100)
  })
  await until(() => exited(instance.child), Boolean, 'Normal DevShift exit')
  assert.equal(instance.child.exitCode, 0)
}

async function captureSwitch(ui, direction, animation) {
  try {
    await until(() => ui.evaluate(name => window.switchAnimations.includes(name), animation), Boolean, direction + ' logo animation')
  } catch (error) {
    const dialog = await ui.evaluate(() => document.querySelector('dialog[open]')?.innerText ?? 'No dialog is open.')
    throw new Error(error.message + '\nOpen dialog:\n' + dialog)
  }
  const clip = await ui.evaluate(async target => {
    const scene = document.querySelector('dialog[open] .switch-' + target)
    if (!scene || !scene.querySelector('.switch-mark')?.naturalWidth) throw new Error('Missing switch logo')
    const mark = scene.querySelector(target === 'gaming' ? '.boost-mark' : '.dev-upper')
    const track = mark.getAnimations()[0]
    const duration = Number(track?.effect?.getComputedTiming().duration)
    if (!(duration >= 1400)) throw new Error('The logo switch finished too quickly: ' + duration + ' ms')
    const time = Number(track.currentTime ?? 0)
    const captureAt = duration * (target === 'gaming' ? 0.42 : 0.30)
    if (time < captureAt) await new Promise(resolve => setTimeout(resolve, captureAt - time))
    const action = scene.closest('dialog').querySelector('.action-list li')
    if (!action?.textContent.includes('Controlled Node server')) throw new Error('Missing reviewed workload')
    if (scene.textContent.includes('Checking the reviewed workloads') && !action.textContent.includes('Pending'))
      throw new Error('A previous switch status was displayed before current progress')
    const rect = scene.closest('dialog').getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
  }, direction)
  const frame = await ui.send('Page.captureScreenshot', { format: 'png', clip })
  await writeFile(join(artifact, 'DevShift-' + direction + '-switch.png'), Buffer.from(frame.data, 'base64'))
}

async function measure(instance) {
  const sample = async () => (await instance.browser.send('SystemInfo.getProcessInfo')).processInfo
  const first = await sample()
  const start = Date.now()
  await delay(6_000)
  const second = await sample()
  const time = (Date.now() - start) / 1000
  const previous = new Map(first.map(process => [process.id, process.cpuTime]))
  const ids = second.map(process => process.id).filter(id => Number.isSafeInteger(id) && id > 0)
  const cpu = second.reduce((total, process) => total + Math.max(0, process.cpuTime - (previous.get(process.id) ?? process.cpuTime)), 0)
  const { stdout } = await powershell('(Get-Process -Id ' + ids.join(',') + ' | Measure-Object -Property WorkingSet64 -Sum).Sum')
  const bytes = Number(stdout.trim())
  return { processCount: ids.length, sampledSeconds: Number(time.toFixed(2)), workingSetMiB: Number((bytes / 1024 ** 2).toFixed(1)),
    cpuMs: Math.round(cpu * 1000), systemCpuPercent: Number((cpu / time / availableParallelism() * 100).toFixed(3)) }
}

test('Windows helper reads the host and rejects a critical service before control', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const scan = await helper.scan(true)
  assert.ok(scan.build >= 22000)
  assert.ok(scan.processes.some(row => row.pid === process.pid && row.name.toLowerCase() === 'node.exe'))
  const active = scan.power.plans.find(plan => plan.id === scan.power.active)
  assert.ok(active)
  assert.deepEqual(await helper.power(active.id, active.id), { changed: false })
  await assert.rejects(helper.service('Spooler', 'a'.repeat(64), 'stop', 1), /outside the supported/)
  console.log(JSON.stringify({ build: scan.build, installedTools: scan.installed.length, serviceCandidates: scan.services.length, activePlan: active.name }))
})

test('desktop shows a startup splash, respects motion preferences, and expands actual editor processes',
  { skip: process.platform !== 'win32', timeout: 65_000 }, async context => {
    const profile = await mkdtemp(join(tmpdir(), 'devshift-workloads-'))
    const store = new Store(join(profile, 'devshift.sqlite'))
    store.settings = { ...defaultSettings, scanInterval: 60_000 }
    store.close()
    let instance
    context.after(async () => {
      if (instance) {
        instance.ui.close()
        instance.browser.close()
        if (!exited(instance.child)) instance.child.kill()
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
    })
    function observeStartup() {
      const trace = window.startupTrace = { seen: false, inert: false, logo: false, animation: null, animations: [] }
      document.addEventListener('animationstart', event => trace.animations.push({
        name: event.animationName, page: document.querySelector('h1')?.textContent,
        filter: document.querySelector('.filter-group [aria-pressed="true"]')?.textContent,
      }))
      return new Promise(resolve => {
        const inspect = () => {
          const splash = document.getElementById('startup-splash')
          const root = document.getElementById('root')
          if (splash) {
            trace.seen = true
            trace.inert ||= Boolean(root?.inert)
            trace.logo ||= Boolean(splash.querySelector('img')?.naturalWidth)
            trace.animation = getComputedStyle(splash.querySelector('.splash-lockup')).animationName
          } else if (root?.hasChildNodes() && !root.inert) {
            observer.disconnect()
            resolve(trace)
          }
        }
        const observer = new MutationObserver(inspect)
        observer.observe(document, { childList: true, subtree: true, attributes: true })
        inspect()
      })
    }
    instance = await launch(profile)
    let { ui } = instance
    const startup = await ui.evaluate(observeStartup)
    assert.ok(startup.seen && startup.inert, 'The splash is present before the workspace accepts input')
    const systemReduced = await ui.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
    assert.equal(startup.animation, systemReduced ? 'none' : 'splash-arrive')
    assert.ok(await ui.evaluate(() => document.querySelector('.brand img')?.naturalWidth > 0))
    await rendered(ui, 'Development Mode')
    const motion = value => ui.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] })
    await motion('no-preference')
    await click(ui, 'Workloads')
    const rail = await ui.evaluate(() => {
      const button = document.querySelector('.rail-active')
      const target = button.getBoundingClientRect()
      const tile = button.querySelector('.rail-glyph').getBoundingClientRect()
      return { target: target.height, tileHeight: tile.height, tileWidth: tile.width, background: getComputedStyle(button).backgroundColor }
    })
    assert.ok(rail.target >= 44)
    assert.deepEqual([rail.tileWidth, rail.tileHeight], [33, 28])
    const icons = await ui.evaluate(() => [...document.querySelectorAll('.rail nav svg[aria-hidden="true"], .command-refresh svg[aria-hidden="true"]')]
      .map(icon => [[...icon.classList].find(name => name.startsWith('lucide-')), icon.getBoundingClientRect().width]))
    assert.deepEqual(icons, [['lucide-layout-dashboard', 19], ['lucide-layers', 19], ['lucide-activity', 19], ['lucide-refresh-cw', 16]])
    assert.equal(rail.background, 'rgba(0, 0, 0, 0)')
    await until(() => ui.evaluate(() => window.startupTrace.animations.some(event =>
      event.name === 'view-enter' && event.page === 'Workloads')), Boolean, 'Workloads navigation animation')
    const scannedAt = () => ui.evaluate(async () => (await window.devshift.dashboard()).scannedAt)
    const beforeRefresh = await scannedAt()
    await click(ui, 'Refresh')
    await until(scannedAt, value => value && value !== beforeRefresh, 'Manual workload refresh')
    await click(ui, 'Running')
    await until(() => ui.evaluate(() => window.startupTrace.animations.some(event =>
      event.name === 'filter-enter' && event.filter === 'Running')), Boolean, 'Running filter animation')

    const dashboard = await ui.evaluate(() => window.devshift.dashboard())
    const family = groupWorkloads(dashboard.workloads).find(group => group.members.length > 1)
    if (family) {
      const label = family.root.label + ', ' + family.members.length + ' processes'
      await click(ui, 'Expand ' + label)
      const view = await ui.evaluate((label, total) => {
        const row = [...document.querySelectorAll('.workload-name')].find(button =>
          button.getAttribute('aria-label') === 'Collapse ' + label).closest('tr')
        const pids = []
        let next = row.nextElementSibling
        while (next?.classList.contains('process-member')) {
          pids.push(Number(next.cells[1].textContent))
          next = next.nextElementSibling
        }
        const expected = total === null ? '—' : new Intl.NumberFormat(undefined,
          { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(total / 1024 ** 2) + ' MB'
        return { pids, totalMatches: row.cells[3].textContent === expected }
      }, label, family.privateMemoryBytes)
      assert.deepEqual(view.pids, family.members.map(member => member.pid))
      assert.ok(view.totalMatches)
      await ui.evaluate(() => document.querySelector('.process-member .workload-name').click())
      await rendered(ui, 'Private working set')
      await click(ui, 'Collapse ' + label)
      assert.equal(await ui.evaluate(() => document.querySelectorAll('.process-member').length), 0)
      console.log(JSON.stringify({ application: family.root.label, groupedPids: view.pids, privateBytes: family.privateMemoryBytes }))
    }
    await motion('reduce')
    await click(ui, 'Activity')
    assert.equal(await ui.evaluate(() => getComputedStyle(document.querySelector('.main-pane')).animationName), 'none')
    const navClip = await ui.evaluate(() => {
      const { x, width } = document.querySelector('.rail').getBoundingClientRect()
      const { y, height } = document.querySelector('.rail nav').getBoundingClientRect()
      return { x, y: y - 4, width, height: height + 8, scale: 1 }
    })
    const navFrame = await ui.send('Page.captureScreenshot', { format: 'png', clip: navClip })
    await mkdir(artifact, { recursive: true })
    await writeFile(join(artifact, 'DevShift-activity-sidebar.png'), Buffer.from(navFrame.data, 'base64'))
    await exitWindow(instance)
    ui.close()
    instance.browser.close()
    const reducedStore = new Store(join(profile, 'devshift.sqlite'))
    reducedStore.settings = { ...defaultSettings, scanInterval: 5000 }
    reducedStore.close()
    instance = await launch(profile, testBinary, ['--force-prefers-reduced-motion'])
    ui = instance.ui
    const reduced = await ui.evaluate(observeStartup)
    assert.ok(reduced.seen && reduced.inert)
    assert.equal(reduced.animation, 'none')
    assert.ok(await ui.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))
    await rendered(ui, 'Development Mode')
    const scanClock = () => ui.evaluate(() => document.querySelector('.scan-clock')?.textContent)
    const firstScan = await scanClock()
    await until(scanClock, time => time && time !== firstScan, 'Next scheduled workload sample', 8500)
    await click(ui, 'Workloads')
    assert.equal(await ui.evaluate(() => document.activeElement?.id), 'nav-Workloads')
    await click(ui, 'Installed')
    assert.equal(await ui.evaluate(() => getComputedStyle(document.querySelector('.filter-results')).animationName), 'none')
    await click(ui, 'Dashboard')
    await click(ui, 'Gaming')
    assert.equal(await ui.evaluate(() => document.querySelector('.switch-scene') === null), true)
    await keepOnly(ui, null)
    await click(ui, 'Confirm switch', 'dialog')
    await rendered(ui, 'Gaming Mode is active.')
    assert.equal(await ui.evaluate(() => getComputedStyle(document.querySelector('.boost-mark')).animationName), 'none')
    await click(ui, 'Done', 'dialog')
    await click(ui, 'Development')
    await click(ui, 'Confirm restoration', 'dialog')
    await rendered(ui, 'Development Mode is active.')
    assert.equal(await ui.evaluate(() => getComputedStyle(document.querySelector('.dev-upper')).animationName), 'none')
    await click(ui, 'Done', 'dialog')
    await exitWindow(instance)
  })

test('System performance matches Windows and updates each second behind another window',
  { skip: process.platform !== 'win32', timeout: 75_000 }, async context => {
    const base = await mkdtemp(join(tmpdir(), 'devshift-performance-'))
    const store = new Store(join(base, 'devshift.sqlite'))
    store.settings = { ...defaultSettings, scanInterval: 60_000 }
    store.close()
    let instance, cover
    context.after(async () => {
      if (cover && !exited(cover)) cover.kill()
      if (instance) {
        instance.ui.close()
        instance.browser.close()
        if (!exited(instance.child)) instance.child.kill()
      }
      await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
    })

    instance = await launch(base)
    const { ui } = instance
    await rendered(ui, 'System performance')
    const scanTime = () => ui.evaluate(async () => (await window.devshift.dashboard()).scannedAt)
    const initialScan = await scanTime()
    const processes = (await instance.browser.send('SystemInfo.getProcessInfo')).processInfo
    const browserPid = processes.find(entry => entry.type === 'browser')?.id ?? instance.child.pid
    const windowArgs = action => ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File',
      join(root, 'tests', 'fixtures', 'performance-window.ps1'), String(browserPid), action]
    cover = spawn(shell, windowArgs('Cover'), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let coverStatus = ''
    cover.stdout.on('data', data => { coverStatus += data })
    cover.stderr.on('data', data => { coverStatus += data })
    await until(() => coverStatus, text => text.includes('Covered'), 'Cover the DevShift test window')

    const records = []
    let allocation
    for (let i = 0; i < 8; i++) {
      const sample = await ui.evaluate(() => new Promise(resolve => {
        const off = window.devshift.onPerformance(history => { off(); resolve(history.at(-1)) })
      }))
      const counters = cpus().reduce((sum, { times }) => ({
        idle: sum.idle + times.idle, total: sum.total + times.idle + times.sys + times.user,
      }), { idle: 0, total: 0 })
      const referenceUsed = totalmem() - freemem()
      assert.ok(sample && Number.isFinite(sample.cpu) && Number.isFinite(sample.usedMemory))
      assert.equal(sample.totalMemory, totalmem())
      assert.ok(Math.abs(Date.now() - sample.sampledAt) < 600, 'A background reading reached the renderer in time')
      records.push({ sample, counters, referenceUsed })
      if (i === 2) allocation = Buffer.alloc(128 * 1024 ** 2, 90)
    }
    assert.ok(!exited(cover) && !coverStatus.includes('Coverage lost'), 'The dashboard remained physically covered')
    assert.equal(allocation[0], 90)
    assert.equal(await scanTime(), initialScan, 'Live readings continued without another inventory scan')
    const gaps = records.slice(1).map(({ sample }, i) => sample.sampledAt - records[i].sample.sampledAt)
    const cpuErrors = records.slice(1).map(({ counters, sample }, i) => {
      const previous = records[i].counters
      const referenceCpu = 100 * (1 - (counters.idle - previous.idle) / (counters.total - previous.total))
      return Math.abs(sample.cpu - referenceCpu)
    })
    const meanCpuError = cpuErrors.reduce((sum, error) => sum + error, 0) / cpuErrors.length
    const memoryErrors = records.map(({ sample, referenceUsed }) => Math.abs(sample.usedMemory - referenceUsed) / 1024 ** 2)
    const maxMemoryError = Math.max(...memoryErrors)
    console.log(JSON.stringify({ backgroundSamples: records.length, intervalMs: [Math.min(...gaps), Math.max(...gaps)],
      meanCpuDifferencePoints: +meanCpuError.toFixed(2), maxCpuDifferencePoints: +Math.max(...cpuErrors).toFixed(2),
      maxMemoryDifferenceMiB: +maxMemoryError.toFixed(2) }))
    assert.ok(gaps.every(gap => gap >= 700 && gap <= 1500), 'Readings arrived about one second apart')
    assert.ok(meanCpuError < 2.5 && Math.max(...cpuErrors) < 8, 'CPU tracked independent Windows processor-time deltas')
    assert.ok(maxMemoryError < 96, 'Memory tracked independently queried Windows available bytes')
    const current = records.at(-1).sample
    const expectedCpu = String(Math.round(current.cpu))
    const expectedMemory = String(Math.round(current.usedMemory / current.totalMemory * 100))
    await until(() => ui.evaluate(() => [...document.querySelectorAll('.telemetry [role="meter"]')].map(el => el.getAttribute('aria-valuenow'))),
      meters => meters[0] === expectedCpu && meters[1] === expectedMemory, 'Rendered CPU and memory percentages', 950)
    const visibleMemory = await ui.evaluate(() => document.querySelectorAll('.readout-value')[1]?.textContent)
    assert.ok(visibleMemory?.includes((current.usedMemory / 1024 ** 3).toFixed(1) + ' GB'))
    assert.ok(visibleMemory?.includes('(' + expectedMemory + '%)'))
    await until(() => exited(cover), Boolean, 'Close the temporary covering window')

    await ui.evaluate(() => {
      window.performancePackets = []
      window.devshift.onPerformance(history => window.performancePackets.push(history))
    })
    await exec(shell, windowArgs('Minimize'), { windowsHide: true })
    await until(() => ui.evaluate(() => window.performancePackets.at(-1)?.length), length => length === 0, 'Sampling paused on minimize')
    const pausedCount = await ui.evaluate(() => window.performancePackets.length)
    await delay(2100)
    assert.equal(await ui.evaluate(() => window.performancePackets.length), pausedCount)
    await exec(shell, windowArgs('Restore'), { windowsHide: true })
    await until(() => ui.evaluate(() => window.performancePackets.at(-1)?.at(-1)?.cpu), value => Number.isFinite(value), 'Fresh CPU after restore')
    const first = await ui.evaluate(index => window.performancePackets[index], pausedCount)
    assert.equal(first.length, 1)
    assert.equal(first[0].cpu, null)
    assert.ok(first[0].totalMemory > 0)
    await exitWindow(instance)
  })

test('Windows desktop switches a real cooperative server, leaves an unrelated process alone, and recovers from interruption',
  { skip: process.platform !== 'win32', timeout: 180_000 }, async context => {
    const base = await mkdtemp(join(tmpdir(), 'devshift-windows-'))
    const profile = join(base, 'profile')
    const managed = await configureFixture(base, 'managed')
    const unrelated = await configureFixture(base, 'unrelated')
    const instances = []
    const other = spawn(process.execPath, [unrelated.entry], { cwd: unrelated.folder, windowsHide: true, stdio: 'ignore' })
    context.after(async () => {
      for (const item of instances) {
        item.ui.close()
        item.browser.close()
        if (!exited(item.child)) item.child.kill()
      }
      await Promise.all([managed, unrelated].map(fixture => writeFile(join(fixture.folder, 'cleanup.request'), '')))
      await until(async () => {
        const marker = await loadMarker(managed.folder).catch(() => null)
        const process = marker ? await helper.process(marker.pid) : null
        return exited(other) && !process?.args?.includes(managed.entry)
      }, Boolean, 'Fixture cleanup')
      await rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
    })

    await mkdir(profile)
    await mkdir(artifact, { recursive: true })
    const database = join(profile, 'devshift.sqlite')
    const store = new Store(database)
    store.settings = { ...defaultSettings, scanInterval: 5_000, minimizeToTray: false }
    store.configurations = [await createConfiguration('Controlled Node server', process.execPath, managed.entry, [])]
    store.close()
    const peer = await until(() => loadMarker(unrelated.folder), value => value.pid === other.pid, 'Unrelated Node listener')

    const initialPower = (await helper.scan()).power
    const initialPlan = initialPower.plans.find(plan => plan.id === initialPower.active)
    assert.ok(initialPlan)
    let instance = await launch(profile)
    instances.push(instance)
    let { ui } = instance
    await rendered(ui, 'Development Mode')
    await rendered(ui, initialPlan.name)
    await until(() => ui.evaluate(() => navigator.windowControlsOverlay?.visible === true), Boolean, 'Native Windows caption controls')
    assert.ok(await ui.evaluate(() => document.querySelector('.brand img')?.naturalWidth > 0))
    await until(() => ui.evaluate(() => document.querySelector('[aria-label="CPU usage"]')?.getAttribute('aria-valuenow')), value =>
      typeof value === 'string', 'Measured CPU activity')
    assert.equal(await ui.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await ui.evaluate(() => typeof window.devshift.dashboard), 'function')
    const screenshot = await ui.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(artifact, 'DevShift-dashboard.png'), Buffer.from(screenshot.data, 'base64'))
    const controls = await ui.evaluate(() => {
      const group = document.querySelector('.mode-switch')
      const { x, y, width, height } = group.getBoundingClientRect()
      const buttons = [...group.querySelectorAll('button')].map(button => {
        const icon = button.querySelector('svg[aria-hidden="true"]')
        return [button.textContent.trim(), [...icon.classList].find(name => name.startsWith('lucide-'))]
      })
      return { buttons, clip: { x, y, width, height, scale: 1 } }
    })
    assert.deepEqual(controls.buttons, [['Development', 'lucide-square-terminal'], ['Gaming', 'lucide-gamepad-2']])
    const modeFrame = await ui.send('Page.captureScreenshot', { format: 'png', clip: controls.clip })
    await writeFile(join(artifact, 'DevShift-mode-controls.png'), Buffer.from(modeFrame.data, 'base64'))
    const idle = await measure(instance)
    assert.ok(idle.workingSetMiB > 0, 'Windows process memory sample')
    console.log(JSON.stringify({ idle, initialPower: initialPlan.name, unrelatedPid: peer.pid }))

    await ui.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 680, deviceScaleFactor: 1, mobile: false })
    assert.ok(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await ui.send('Emulation.clearDeviceMetricsOverride')
    await click(ui, 'Workloads')
    await click(ui, 'Installed')
    await until(() => ui.evaluate(() => document.querySelectorAll('.installed-list li').length), count => count > 0, 'Installed tool rows')
    await click(ui, 'Approved')
    await until(() => ui.evaluate(() => {
      const row = document.querySelector('.workload-name')
      if (!row?.textContent.includes('Controlled Node server')) return false
      row.click()
      return true
    }), Boolean, 'Workload inspector selection')
    await rendered(ui, 'Workload details')
    await rendered(ui, 'Parent process ID')
    await click(ui, 'Launch')
    const first = await until(() => loadMarker(managed.folder), Boolean, 'Managed Node listener')
    assert.equal(await http(first), first.pid)
    assert.equal(await http(peer), peer.pid)

    await ui.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await ui.evaluate(() => {
      window.switchAnimations = []
      document.addEventListener('animationstart', event => window.switchAnimations.push(event.animationName))
    })
    await click(ui, 'Dashboard')
    await click(ui, 'Gaming')
    await rendered(ui, 'Review Gaming Mode')
    await rendered(ui, 'Request the project')
    await click(ui, 'Cancel', 'dialog')
    assert.equal(await ui.evaluate(() => window.switchAnimations.includes('boost-launch')), false)
    assert.equal(await http(first), first.pid)

    await click(ui, 'Gaming')
    await keepOnly(ui, 'Controlled Node server')
    await click(ui, 'Confirm switch', 'dialog')
    await captureSwitch(ui, 'gaming', 'boost-launch')
    await rendered(ui, 'Gaming Mode is active. Windows state was verified.')
    assert.equal(await ui.evaluate(() => document.querySelector('dialog[open] [role="status"]')?.textContent), '1 of 1 actions finished')
    await assert.rejects(http(first))
    assert.equal(await helper.process(first.pid), null)
    assert.equal(await http(peer), peer.pid)
    await click(ui, 'Done', 'dialog')
    await click(ui, 'Development')
    await click(ui, 'Confirm restoration', 'dialog')
    await captureSwitch(ui, 'development', 'dev-upper-fit')
    await rendered(ui, 'Relaunched the project and confirmed readiness.')
    await click(ui, 'Done', 'dialog')
    const second = await until(() => loadMarker(managed.folder), value => value.pid !== first.pid, 'Restored Node listener')
    assert.equal(await http(second), second.pid)

    await click(ui, 'Gaming')
    await keepOnly(ui, 'Controlled Node server')
    await click(ui, 'Confirm switch', 'dialog')
    await until(() => readFile(join(managed.folder, 'shutdown.requested'), 'utf8'), value => Number(value) === second.pid, 'Durable stop intent')
    assert.ok(instance.child.kill(), 'Stop only the isolated DevShift test instance')
    await until(() => exited(instance.child), Boolean, 'Interrupted DevShift exit')
    await until(() => helper.process(second.pid), value => value === null, 'Project graceful shutdown after interruption')

    instance = await launch(profile)
    instances.push(instance)
    ui = instance.ui
    await rendered(ui, 'Interrupted switch')
    await click(ui, 'Review restoration')
    await rendered(ui, 'A previous action may have changed Windows')
    await click(ui, 'Confirm restoration', 'dialog')
    await click(ui, 'Done', 'dialog')
    const third = await until(() => loadMarker(managed.folder), value => value.pid !== second.pid, 'Recovered Node listener')
    assert.equal(await http(third), third.pid)
    assert.equal((await helper.scan()).power.active, initialPower.active)
    await click(ui, 'Activity')
    await rendered(ui, 'Recovery required')
    await exitWindow(instance)
    assert.equal(await http(third), third.pid)
    assert.equal(await http(peer), peer.pid)
    console.log(JSON.stringify({ stoppedPid: first.pid, relaunchedPid: second.pid, recoveredPid: third.pid, unrelatedPid: peer.pid,
      originalPlanPreserved: true, verifiedNormalExit: true }))
  })
