import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, session, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Store } from './store.ts'
import { Vault } from './vault.ts'
import { Prefs } from './prefs.ts'
import { registerIpc, startAutoLock, lockApp, type Runtime } from './ipc.ts'
import { registerDeepLinks, onDeepLink } from './deepLinks.ts'
import { ConnectionManager } from './connections/index.ts'
import { disposeProviders } from './rpc.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isDev = !app.isPackaged
const devServer = isDev ? process.env.ELECTRON_RENDERER_URL : undefined

// Every renderer sandboxed, whatever a window's own options say. Skipped only
// when Chromium's own sandbox is switched off on the command line (CI and
// containers running as root), which would otherwise stop child processes
// starting at all; each window still sets sandbox: true regardless.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox()

// One store, one process. A second instance would race on the encrypted file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.setName('Goldfelty Portfolio Manager')
registerDeepLinks()

const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = devServer ?? pathToFileURL(rendererFile).href

let runtime: Runtime | undefined
let autoLockTimer: NodeJS.Timeout | undefined
let mainWindow: BrowserWindow | null = null

function isAppUrl(url: string): boolean {
  return url.startsWith(rendererUrl)
}

/** Open a link in the user's browser, if it is an https page. */
function openOutside(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) void shell.openExternal(parsed.toString())
  } catch {
    // not a URL; ignore
  }
}

/**
 * Applies to every web contents the app ever creates, not just the main
 * window: no new windows, no navigation away, no webviews, no redirects.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openOutside(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    title: 'Goldfelty',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: !isMac,
    icon: process.platform === 'linux' ? join(__dirname, '../../resources/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: isDev,
      safeDialogs: true
    }
  })

  window.once('ready-to-show', () => window.show())
  if (devServer) void window.loadURL(devServer)
  else void window.loadFile(rendererFile)
  return window
}

function lockSession(): void {
  const ses = session.defaultSession

  // The renderer never needs the network: prices, balances and wallets all
  // go through the main process. Any request it makes elsewhere is refused,
  // which backs up the page's own CSP.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const allowed =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('data:') ||
      (devServer !== undefined && (url.startsWith(devServer) || url.startsWith(devServer.replace(/^http/, 'ws'))))
    callback({ cancel: !allowed })
  })

  // No camera, microphone, notifications, clipboard reads, HID, serial...
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const lockItem: Electron.MenuItemConstructorOptions = {
    label: 'Lock Goldfelty',
    accelerator: 'CmdOrCtrl+L',
    click: () => runtime && lockApp(runtime)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              lockItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    { label: 'File', submenu: [...(isMac ? [] : [lockItem, { type: 'separator' } as const]), isMac ? { role: 'close' } : { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : [])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'goldfelty.com', click: () => openOutside('https://goldfelty.com') }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const prefs = new Prefs(dataDir)
  const store = new Store(dataDir)
  const vault = new Vault(dataDir)
  const connections = new ConnectionManager(dataDir, (url) => shell.openExternal(url))

  runtime = {
    store,
    vault,
    prefs,
    connections,
    window: () => mainWindow,
    rendererUrl,
    lastBalances: [],
    lastActivity: Date.now()
  }
  const rt = runtime

  // A wallet appearing or dropping must show at once: the user needs to know
  // whether they can still send.
  connections.onChange(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('connections:changed')
  })

  nativeTheme.themeSource = prefs.theme
  lockSession()
  registerIpc(rt)
  buildMenu()
  autoLockTimer = startAutoLock(rt)

  // Walking away from the computer locks Goldfelty too.
  powerMonitor.on('lock-screen', () => lockApp(rt))
  powerMonitor.on('suspend', () => lockApp(rt))

  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  onDeepLink(() => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      mainWindow.on('closed', () => {
        mainWindow = null
      })
    }
  })
})

app.on('window-all-closed', () => {
  // With no window there is nothing to approve sends in; lock regardless.
  if (runtime) lockApp(runtime)
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (autoLockTimer) clearInterval(autoLockTimer)
  if (runtime) {
    lockApp(runtime)
    // The bridge holds a listening socket; it must not outlive the app.
    void runtime.connections.shutdown()
  }
  disposeProviders()
})

// A crashed renderer must not leave Goldfelty unlocked behind it.
app.on('render-process-gone', () => runtime && lockApp(runtime))
