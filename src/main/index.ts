import { app, BrowserWindow, Menu, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.ts'
import { Vault } from './vault.ts'
import { registerIpc, startAutoLock, type Runtime } from './ipc.ts'
import { disposeProviders } from './rpc.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isDev = !app.isPackaged

// One vault, one process. A second instance would race on the state file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.setName('Goldfelty Portfolio Manager')

let runtime: Runtime
let autoLockTimer: NodeJS.Timeout | undefined
let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0c0d11',
    title: 'Goldfelty Portfolio Manager',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'linux' ? join(__dirname, '../../resources/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev
    }
  })

  window.once('ready-to-show', () => window.show())

  // Nothing in this app should ever open a second window or navigate away; a
  // wallet that can be steered to an attacker's page is a wallet that leaks.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function applyContentSecurityPolicy(): void {
  const directives = [
    "default-src 'self'",
    // Vite injects styles at runtime; scripts stay locked to the bundle.
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    // The renderer never talks to the network itself — all RPC and price
    // traffic goes through the main process.
    `connect-src 'self'${isDev ? ' ws: http://localhost:*' : ''}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [directives.join('; ')]
      }
    })
  })

  // Deny every powerful web permission outright; the app needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Lock Vault',
                accelerator: 'CmdOrCtrl+L',
                click: () => {
                  runtime.vault.lock()
                  mainWindow?.webContents.send('app:locked')
                }
              },
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
    {
      label: 'File',
      submenu: [
        {
          label: 'Lock Vault',
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            runtime.vault.lock()
            mainWindow?.webContents.send('app:locked')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : [])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Goldfelty Support',
          click: () => void shell.openExternal('https://goldfelty.com/support')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const store = new Store(dataDir)
  const vault = new Vault(dataDir)

  runtime = {
    store,
    vault,
    lastBalances: [],
    lastPortfolioAt: 0,
    lastActivity: Date.now(),
    onboardingTicket: null,
    backupConfirmed: store.account?.backedUp ?? false
  }

  nativeTheme.themeSource = store.settings.theme
  applyContentSecurityPolicy()
  registerIpc(runtime)
  buildMenu()
  autoLockTimer = startAutoLock(runtime)

  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Lock on the way out so the seed never survives in a crash dump.
  runtime?.vault.lock()
  runtime?.store.flush()
  if (autoLockTimer) clearInterval(autoLockTimer)
  disposeProviders()
})

// A renderer crash must not leave an unlocked vault behind.
app.on('render-process-gone', () => runtime?.vault.lock())
app.on('child-process-gone', () => runtime?.vault.lock())
