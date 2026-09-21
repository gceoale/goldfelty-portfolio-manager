import { app, BrowserWindow } from 'electron'
import { linkFromArgv, parseDeepLink, PROTOCOL, type DeepLink } from '../shared/deepLink.ts'

export { PROTOCOL, parseDeepLink, linkFromArgv, type DeepLink }

/**
 * Deep links into the desktop app.
 *
 * Two shapes, both ending up in the same place:
 *   goldfelty://wc?uri=wc:…      a wallet or page handing us a pairing URI
 *   https://goldfelty.com/wc?uri=…   the same thing, for clients that will
 *                                    only follow https
 *
 * Without this a user has to copy a WalletConnect URI by hand, which is the
 * kind of step people give up on.
 */

type Handler = (link: DeepLink) => void

let handler: Handler | null = null
/** Links that arrived before a window existed to show them. */
let queued: DeepLink[] = []

function deliver(link: DeepLink): void {
  if (handler) handler(link)
  else queued.push(link)
}

export function onDeepLink(fn: Handler): void {
  handler = fn
  for (const link of queued) fn(link)
  queued = []
}

/**
 * Register as the handler for goldfelty:// and start listening.
 * Call once, before the app is ready.
 */
export function registerDeepLinks(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // In development the executable is Electron itself, so the protocol has to
    // be registered against the script path for the OS to hand links back.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  // macOS delivers links as an event rather than on argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const link = parseDeepLink(url)
    if (link) deliver(link)
  })

  // Windows and Linux route them through the already-running instance.
  app.on('second-instance', (_event, argv) => {
    const link = linkFromArgv(argv)
    if (link) deliver(link)
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // A cold start from a link.
  const initial = linkFromArgv(process.argv)
  if (initial) deliver(initial)
}
