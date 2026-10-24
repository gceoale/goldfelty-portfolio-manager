/**
 * Parsing for links handed to the desktop app.
 *
 * Kept free of Electron so it can be tested directly. Since 1.1.1 a link can
 * only bring Goldfelty to the front: nothing that arrives this way reaches
 * the wallet layer, so a link on a web page cannot start a connection,
 * a signature or a transfer.
 *
 *   goldfelty://                  open the app
 *   https://goldfelty.com/open    the same, for clients that only follow https
 */

export const PROTOCOL = 'goldfelty'
export const WEB_ORIGIN = 'https://goldfelty.com'

export interface DeepLink {
  action: 'open'
}

export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const isOurs = url.protocol === `${PROTOCOL}:` || (url.protocol === 'https:' && url.origin === WEB_ORIGIN)
  return isOurs ? { action: 'open' } : null
}

/** Pull a link out of raw argv, which is how Windows and Linux deliver them. */
export function linkFromArgv(argv: string[]): DeepLink | null {
  for (const arg of argv) {
    const link = parseDeepLink(arg)
    if (link) return link
  }
  return null
}
