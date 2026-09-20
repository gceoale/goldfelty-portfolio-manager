/**
 * Parsing for links handed to the desktop app.
 *
 * Kept free of Electron so it can be tested directly: this is the boundary
 * where something outside the app hands us a URL, and it decides what is
 * allowed to reach the wallet layer.
 *
 *   goldfelty://wc?uri=wc:…            from a wallet or a local page
 *   https://goldfelty.com/wc?uri=wc:…  for clients that only follow https
 */

export const PROTOCOL = 'goldfelty'
export const WEB_ORIGIN = 'https://goldfelty.com'

export interface DeepLink {
  action: 'wc' | 'open'
  uri?: string
}

export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  const isOurs = url.protocol === `${PROTOCOL}:` || (url.protocol === 'https:' && url.origin === WEB_ORIGIN)
  if (!isOurs) return null

  // The custom scheme puts "wc" in the host, the https form puts it in the
  // path. Normalise the two.
  const action = (url.protocol === `${PROTOCOL}:` ? url.hostname : url.pathname.replace(/^\/+/, '')) || 'open'

  if (action === 'wc') {
    const uri = url.searchParams.get('uri')
    // Only a genuine pairing URI travels onward. Anything else arriving here
    // has no business being handed to the wallet layer.
    if (!uri || !uri.startsWith('wc:')) return null
    return { action: 'wc', uri }
  }

  return { action: 'open' }
}

/** Pull a link out of raw argv, which is how Windows and Linux deliver them. */
export function linkFromArgv(argv: string[]): DeepLink | null {
  for (const arg of argv) {
    const link = parseDeepLink(arg)
    if (link) return link
  }
  return null
}
