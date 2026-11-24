import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Engine } from '../core/engine.js'
import { errorMessage, UserError } from '../core/model.js'
import { Store } from '../core/store.js'
import { channels, gamingPowerModes } from '../shared/contracts.js'
import type { ReviewTarget, Settings, SwitchState } from '../shared/contracts.js'
import { createConfiguration, NodeRuntime } from './node-runtime.js'
import type { Secrets } from './node-runtime.js'
import { PerformanceMonitor } from './performance.js'
import { Windows, WindowsHost } from './windows.js'

app.setName('DevShift')
app.setAppUserModelId('org.devshift.desktop')
app.enableSandbox()

const profile = app.commandLine.getSwitchValue('user-data-dir')
if (profile && isAbsolute(profile)) app.setPath('userData', profile)

const root = app.getAppPath()
const unpacked = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : root
const entry = join(root, 'dist', 'renderer', 'index.html')
const trustedPage = pathToFileURL(entry).href
let window: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store | null = null
let engine: Engine | null = null
let quitting = false
let brandIcon: Electron.NativeImage

function trayIcon(gaming: boolean) {
  const size = 32
  const logo = brandIcon.resize({ width: size, height: size })
  if (logo.isEmpty()) return logo
  const pixels = logo.toBitmap()
  for (let y = 21; y < size; y++) {
    for (let x = 21; x < size; x++) {
      const distance = (x - 26) ** 2 + (y - 26) ** 2
      if (distance > 25) continue
      const color = distance <= 12 ? (gaming ? [255, 162, 183] : [182, 217, 109]) : [26, 23, 19]
      pixels.set([...color, 255], (y * size + x) * 4)
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size })
}

function showWindow() {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function refreshTray(state: SwitchState) {
  if (!tray || tray.isDestroyed()) return
  const mode = state.mode === 'gaming' ? 'Gaming' : 'Development'
  const label = state.phase === 'RECOVERY_REQUIRED' ? 'Recovery required' : state.busy ? 'Switch in progress' : mode + ' Mode'
  const review = (target: ReviewTarget) => {
    showWindow()
    window?.webContents.send(channels.trayReview, target)
  }
  tray.setImage(trayIcon(state.mode === 'gaming'))
  tray.setToolTip('DevShift · ' + label)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { label: 'Open dashboard', click: showWindow },
    { type: 'separator' },
    { label: 'Switch to Gaming Mode', enabled: !state.busy && !state.hasSnapshot, click: () => review('gaming') },
    { label: 'Switch to Development Mode', enabled: !state.busy && state.hasSnapshot, click: () => review('development') },
    { type: 'separator' },
    { label: 'Exit DevShift', enabled: !state.busy, click: () => app.quit() },
  ]))
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_$.:-]{1,120}$/.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const powerModeChoice = (value: unknown): value is string => typeof value === 'string' && gamingPowerModes.includes(value)
const invalid = () => new UserError('DevShift rejected an invalid request.')

function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function registerIpc(controller: Engine, resetScanTimer: () => void) {
  const choices = new Map<string, { path: string; kind: 'executable' | 'entry'; expires: number }>()
  const on = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || event.senderFrame?.url !== trustedPage) throw invalid()
      try { return await handler(...args) }
      catch (error) { throw new Error(errorMessage(error, 'DevShift could not complete this operation.')) }
    })
  }

  on(channels.dashboard, refresh => controller.dashboard(refresh === true))
  on(channels.review, target => {
    if (target !== 'gaming' && target !== 'development' && target !== 'resume' && target !== 'keep') throw invalid()
    return controller.review(target)
  })
  on(channels.execute, (token, skip) => {
    if (!uuid(token)) throw invalid()
    if (skip !== undefined && (!Array.isArray(skip) || skip.length > 64 || skip.some(id => !validId(id)))) throw invalid()
    return controller.execute(token, (skip as string[] | undefined) ?? [])
  })
  on(channels.approve, (id, approved) => {
    if (!validId(id) || !id.startsWith('service:') || typeof approved !== 'boolean') throw invalid()
    return controller.approve(id, approved)
  })
  on(channels.preferences, input => {
    const { gamingPlan, gamingPowerMode, scanInterval, minimizeToTray } = payload(input)
    if ((gamingPlan !== null && !uuid(gamingPlan)) || (gamingPowerMode !== null && !powerModeChoice(gamingPowerMode))
      || typeof scanInterval !== 'number' || ![5_000, 10_000, 30_000, 60_000].includes(scanInterval)
      || typeof minimizeToTray !== 'boolean') throw invalid()
    return controller.preferences({ gamingPlan, gamingPowerMode, scanInterval, minimizeToTray } satisfies Settings).then(resetScanTimer)
  })
  on(channels.pickFile, async kind => {
    if (!window || (kind !== 'executable' && kind !== 'entry')) throw invalid()
    const answer = await dialog.showOpenDialog(window, {
      title: kind === 'executable' ? 'Select node.exe' : 'Select the project entry file',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [kind === 'executable' ? { name: 'Node executable', extensions: ['exe'] }
        : { name: 'JavaScript entry files', extensions: ['js', 'cjs', 'mjs'] }],
    })
    const path = answer.filePaths[0]
    if (answer.canceled || !path) return null
    if (kind === 'executable' && basename(path).toLowerCase() !== 'node.exe') throw new UserError('Select a file named node.exe.')
    for (const [id, choice] of choices) if (choice.kind === kind || Date.now() > choice.expires) choices.delete(id)
    const token = randomUUID()
    choices.set(token, { path, kind, expires: Date.now() + 300_000 })
    return { token, path }
  })
  on(channels.registerNode, input => {
    const { label, executable, entry, dependencies } = payload(input)
    if (typeof label !== 'string' || !label.trim() || label.length > 70 || /[\u0000-\u001f\u007f]/.test(label)
      || !uuid(executable) || !uuid(entry) || !Array.isArray(dependencies) || dependencies.length > 32
      || dependencies.some(id => !validId(id) || !id.startsWith('service:'))) throw invalid()
    const exe = choices.get(executable)
    const script = choices.get(entry)
    if (exe?.kind !== 'executable' || script?.kind !== 'entry' || Date.now() > Math.min(exe.expires, script.expires))
      throw new UserError('Choose the project files again. Your selections expired.')
    return controller.registerNode(async () => {
      const config = await createConfiguration(label.trim(), exe.path, script.path, [...new Set<string>(dependencies.map(id => id.slice(8)))])
      return config
    }).then(() => { choices.delete(executable); choices.delete(entry) })
  })
  on(channels.launchNode, id => {
    if (!validId(id) || !id.startsWith('node:')) throw invalid()
    return controller.launchNode(id)
  })
  on(channels.removeNode, id => {
    if (!validId(id) || !id.startsWith('node:')) throw invalid()
    return controller.removeNode(id)
  })
  on(channels.quit, () => {
    if (controller.state().busy) throw new UserError('Wait for the current operation to finish before quitting.')
    setImmediate(() => app.quit())
  })
}

async function start() {
  if (process.platform !== 'win32') throw new UserError('DevShift requires Windows 11.')
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = 'dark'
  brandIcon = nativeImage.createFromPath(join(root, 'assets', 'devshift.png'))
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  const data = app.getPath('userData')
  mkdirSync(data, { recursive: true })
  const local = new Store(join(data, 'devshift.sqlite'))
  store = local

  const helper = join(unpacked, 'dist', 'native', 'DevShift.Windows.exe')
  const windows = new Windows(helper)
  const secrets: Secrets = {
    seal: async value => {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new UserError('Windows credential encryption is unavailable.')
      return (await safeStorage.encryptStringAsync(value)).toString('base64')
    },
    unseal: async value => (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result,
  }
  const runtime = new NodeRuntime(windows, local, join(unpacked, 'runtime', 'shutdown.cjs'), secrets)
  const controller = new Engine(local, new WindowsHost(windows, runtime, local, secrets), state => {
    window?.webContents.send(channels.progress, state)
    refreshTray(state)
  })
  engine = controller
  window = new BrowserWindow({
    width: 1344, height: 884, minWidth: 720, minHeight: 580,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171922', symbolColor: '#d3d6e5', height: 38 },
    backgroundColor: '#101117', icon: brandIcon, show: false,
    webPreferences: {
      preload: join(root, 'dist', 'main', 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true,
    },
  })
  const desktop = window
  const canPublish = () => !desktop.isDestroyed() && !desktop.webContents.isDestroyed() && desktop.webContents.getURL() === trustedPage
  const monitor = new PerformanceMonitor(helper, samples => {
    if (canPublish()) desktop.webContents.send(channels.performance, samples)
  })
  let scanTimer: NodeJS.Timeout | undefined
  const requestScan = () => { if (canPublish()) desktop.webContents.send(channels.scanDue) }
  const resetScanTimer = () => {
    clearInterval(scanTimer)
    if (!desktop.isDestroyed() && desktop.isVisible() && !desktop.isMinimized())
      scanTimer = setInterval(requestScan, local.settings.scanInterval)
  }
  const resume = () => {
    if (!desktop.isVisible() || desktop.isMinimized()) return
    monitor.start()
    resetScanTimer()
    requestScan()
  }
  const pause = () => { clearInterval(scanTimer); monitor.stop() }
  desktop.on('show', resume)
  desktop.on('restore', resume)
  desktop.on('hide', pause)
  desktop.on('minimize', pause)
  desktop.once('closed', pause)
  registerIpc(controller, resetScanTimer)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.once('ready-to-show', showWindow)
  window.on('close', event => {
    if (!quitting && (local.settings.minimizeToTray || controller.state().busy)) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('closed', () => { window = null })

  tray = new Tray(trayIcon(false))
  tray.on('click', showWindow)
  refreshTray(controller.state())
  await window.loadFile(entry)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (engine?.state().busy) { event.preventDefault(); return }
    quitting = true
  })
  app.on('will-quit', () => { tray?.destroy(); store?.close() })
  void app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('DevShift could not start', errorMessage(error, 'Check the local DevShift files and Windows permissions.'))
    app.quit()
  })
}
