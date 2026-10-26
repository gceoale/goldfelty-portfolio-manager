import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { BRIDGE_PAGE } from './bridgePage.ts'
import { providerIdFor } from '../../shared/walletRegistry.ts'
import type { BridgeStatus, ChainFamily, DetectedWallet } from '../../shared/types.ts'

/**
 * Which chain family a provider key belongs to. EVM wallets are keyed by
 * their EIP-6963 rdns; the page keys the rest with a family prefix. The
 * family comes from the key, never from anything else the page claims.
 */
export function familyOfKey(key: string): ChainFamily {
  if (key.startsWith('sol:')) return 'solana'
  if (key.startsWith('btc:')) return 'utxo'
  if (key.startsWith('tron:')) return 'tron'
  return 'evm'
}

/**
 * Goldfelty's own connection to browser-extension wallets.
 *
 * Extensions live inside the browser and a desktop app cannot reach them, so
 * the app serves a page on loopback and the user opens it in their browser.
 * That page discovers every wallet installed there through EIP-6963, tells
 * the app what it found, and then relays requests to whichever wallet they
 * are addressed to. One tab carries all of them: MetaMask, Rabby and Phantom
 * side by side, with no relay service and no SDK in between.
 *
 * Security:
 * - Bound to 127.0.0.1 only. Never a reachable interface.
 * - The app opens a one-time link (/open?t=...). Opening it swaps the ticket
 *   for a random session secret in an HttpOnly, SameSite=Strict cookie and
 *   redirects to a clean URL. Browser history therefore only ever holds a
 *   used ticket, which grants nothing. Tickets expire after ten minutes.
 * - Every other request needs that cookie, compared in constant time.
 * - The Host header must be 127.0.0.1:<port>, which defeats DNS rebinding,
 *   and any Origin other than the bridge's own is refused.
 * - POSTs must be application/json, which a cross-site form cannot send.
 * - The page's script and style are pinned by SHA-256 in its CSP, it may not
 *   be framed, and bodies over 1 MB are refused.
 */

interface Provider {
  uuid: string
  rdns: string
  name: string
  icon: string | null
}

interface Page {
  id: string
  lastSeen: number
  providers: Map<string, Provider>
  queue: Job[]
  waiting: ((job: Job | null) => void) | null
}

interface Job {
  id: string
  rdns: string
  method: string
  params: unknown[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  pageId: string
}

export interface WalletEvent {
  rdns: string
  type: 'accountsChanged' | 'chainChanged' | 'disconnect'
  data: unknown
}

export class BridgeClosedError extends Error {
  code = 'BRIDGE_CLOSED'
  constructor(name: string) {
    super(`Open the Goldfelty tab in your browser to use ${name}.`)
  }
}

export class WalletRequestError extends Error {
  readonly code: string | number
  constructor(message: string, code: string | number = 'WALLET_ERROR') {
    super(message)
    this.code = code
  }
}

/** Long-poll length. Short enough that proxies and browsers keep the socket. */
const POLL_MS = 25_000
/** A page that has not polled for this long is treated as closed. */
const PAGE_TTL_MS = 40_000
/** The wallet has this long to answer a prompt before we give up on it. */
const REQUEST_MS = 3 * 60_000
const MAX_BODY = 1_048_576
const TICKET_MS = 10 * 60_000
const MAX_TICKETS = 32

function cspHash(page: string, tag: 'script' | 'style'): string {
  const open = page.indexOf(`<${tag}>`)
  const close = page.indexOf(`</${tag}>`, open)
  const body = page.slice(open + tag.length + 2, close)
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

/** Pinned once at startup from the page string itself. */
// Only scripts are locked to this page's own, by hash: that is what keeps
// anything else from running here. (Extensions' own scripts aren't bound by a
// page's CSP.) The rest is loose on purpose. Wallet extensions run their
// in-page code in this tab, and it needs to reach its own servers and draw its
// own UI: Coinbase Wallet, for one, opens wss://www.walletlink.org and adds
// inline styles, and couldn't connect while those were blocked. The page holds
// no secret a script could read (the session is an HttpOnly cookie), so these
// cost nothing.
const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${cspHash(BRIDGE_PAGE, 'script')}`,
  "style-src 'unsafe-inline'",
  // Wallet icons arrive as data: URIs through EIP-6963; wallets' own UI may load more.
  'img-src data: https:',
  'font-src data: https:',
  "connect-src 'self' https: wss:",
  'frame-src https:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
}

export interface WantedWallet {
  rdns: string[]
  name: string
  homepage: string | null
}

export class BrowserBridge {
  private server: Server | null = null
  /** Session secret, held by the browser only as an HttpOnly cookie. */
  private secret = ''
  private readonly tickets = new Map<string, number>()
  private wanted: WantedWallet | null = null
  private port = 0
  private readonly pages = new Map<string, Page>()
  private readonly jobs = new Map<string, Job>()
  private sweeper: NodeJS.Timeout | null = null
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: WalletEvent) => void>()

  /** Called whenever the set of open pages or detected wallets changes. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onWalletEvent(fn: (event: WalletEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  get origin(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}` : null
  }

  /**
   * A fresh one-time link to the bridge page. Each link works once, in one
   * browser, within ten minutes. Never log or persist these.
   */
  issueLink(): string | null {
    if (!this.server) return null
    const now = Date.now()
    for (const [t, expires] of this.tickets) if (expires <= now) this.tickets.delete(t)
    // Bounded, so a renderer asking in a loop cannot grow this without limit.
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!)
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, now + TICKET_MS)
    return `${this.origin}/open?t=${ticket}`
  }

  /** Tell open tabs which wallet the user just picked, so they can say if it is missing. */
  setWanted(want: WantedWallet | null): void {
    this.wanted = want
    for (const page of this.pages.values()) {
      if (!page.waiting) continue
      const waiting = page.waiting
      page.waiting = null
      waiting(null)
    }
  }

  private get cookieName(): string {
    // Cookies ignore ports, so the name carries it to keep two runs apart.
    return `gf_bridge_${this.port}`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.secret = randomBytes(32).toString('base64url')
    this.tickets.clear()
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Loopback only. 0.0.0.0 would put a signing bridge on the local network.
      server.listen(0, '127.0.0.1', () => resolve())
    })
    // A slow or idle client must not hold sockets forever.
    server.headersTimeout = 10_000
    server.requestTimeout = POLL_MS + 10_000
    server.maxHeadersCount = 50
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
    this.sweeper = setInterval(() => this.sweep(), 5_000)
    this.sweeper.unref?.()
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer)
      job.reject(new WalletRequestError('The wallet bridge was closed.', 'BRIDGE_STOPPED'))
    }
    this.jobs.clear()
    for (const page of this.pages.values()) page.waiting?.(null)
    this.pages.clear()
    this.tickets.clear()
    this.secret = ''
    this.wanted = null
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
    }
    this.changed()
  }

  status(): BridgeStatus {
    return {
      running: !!this.server,
      url: this.origin,
      pages: this.pages.size,
      detected: this.detected()
    }
  }

  /** Every wallet announced in any open tab, once each. */
  detected(): DetectedWallet[] {
    const seen = new Map<string, DetectedWallet>()
    for (const page of this.pages.values()) {
      for (const p of page.providers.values()) {
        if (seen.has(p.rdns)) continue
        seen.set(p.rdns, { rdns: p.rdns, name: p.name, icon: p.icon, providerId: providerIdFor(p.rdns, p.name), family: familyOfKey(p.rdns) })
      }
    }
    return [...seen.values()]
  }

  hasProvider(rdns: string): boolean {
    for (const page of this.pages.values()) if (page.providers.has(rdns)) return true
    return false
  }

  /** Resolve once a tab announces `rdns`, or null if a tab opens without it. */
  waitForProvider(rdns: string[], timeoutMs: number): Promise<DetectedWallet | 'missing' | null> {
    const find = (): DetectedWallet | undefined => this.detected().find((d) => rdns.includes(d.rdns))
    const hit = find()
    if (hit) return Promise.resolve(hit)

    return new Promise((resolve) => {
      let missingTimer: NodeJS.Timeout | null = null
      const done = (value: DetectedWallet | 'missing' | null): void => {
        off()
        clearTimeout(overall)
        if (missingTimer) clearTimeout(missingTimer)
        resolve(value)
      }
      const off = this.onChange(() => {
        const found = find()
        if (found) return done(found)
        // A tab is open and has finished announcing, but not this wallet:
        // give stragglers a moment, then say it is not installed there.
        if (this.pages.size > 0 && !missingTimer) {
          missingTimer = setTimeout(() => (find() ? done(find()!) : done('missing')), 2_500)
        }
      })
      const overall = setTimeout(() => done(null), timeoutMs)
    })
  }

  /** Send a request to whichever open tab has the wallet `rdns`. */
  request(rdns: string, name: string, method: string, params: unknown[], timeoutMs = REQUEST_MS): Promise<unknown> {
    const page = [...this.pages.values()]
      .filter((p) => p.providers.has(rdns))
      .sort((a, b) => b.lastSeen - a.lastSeen)[0]
    if (!page) return Promise.reject(new BridgeClosedError(name))

    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        reject(new WalletRequestError(`${name} did not answer. Check the browser for a pending prompt.`, 'TIMEOUT'))
      }, timeoutMs)
      const job: Job = { id, rdns, method, params, resolve, reject, timer, pageId: page.id }
      this.jobs.set(id, job)
      if (page.waiting) {
        const waiting = page.waiting
        page.waiting = null
        waiting(job)
      } else {
        page.queue.push(job)
      }
    })
  }

  private sweep(): void {
    const now = Date.now()
    let removed = false
    for (const page of this.pages.values()) {
      if (now - page.lastSeen <= PAGE_TTL_MS) continue
      this.dropPage(page.id)
      removed = true
    }
    if (removed) this.changed()
  }

  private dropPage(pageId: string): void {
    const page = this.pages.get(pageId)
    if (!page) return
    page.waiting?.(null)
    this.pages.delete(pageId)
    // Anything addressed to that tab and not yet answered cannot be any more.
    for (const job of [...this.jobs.values()]) {
      if (job.pageId !== pageId) continue
      clearTimeout(job.timer)
      this.jobs.delete(job.id)
      job.reject(new WalletRequestError('The browser tab was closed before the wallet answered.', 'PAGE_CLOSED'))
    }
  }

  /** Host and Origin checks, which every request must pass. */
  private sameOrigin(req: IncomingMessage): boolean {
    if (req.headers.host !== `127.0.0.1:${this.port}`) return false
    const origin = req.headers.origin
    if (origin !== undefined && origin !== this.origin) return false
    // Browsers that send Fetch Metadata say outright when a request is cross-site.
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  private hasSession(req: IncomingMessage): boolean {
    if (!this.secret) return false
    const supplied = readCookie(req.headers.cookie, this.cookieName) ?? ''
    const a = Buffer.from(supplied)
    const b = Buffer.from(this.secret)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...SECURITY_HEADERS })
      res.end(JSON.stringify(body))
    }
    const sendText = (code: number, text: string): void => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end(text)
    }

    if (!this.sameOrigin(req)) return send(403, { error: 'Forbidden' })
    const url = new URL(req.url ?? '/', this.origin ?? 'http://127.0.0.1')

    // The one-time link: swap the ticket for the session cookie, then
    // redirect so the ticket does not stay in the address bar.
    if (url.pathname === '/open' && req.method === 'GET') {
      const ticket = url.searchParams.get('t') ?? ''
      const expires = this.tickets.get(ticket)
      this.tickets.delete(ticket)
      if (!expires || expires <= Date.now()) {
        return sendText(403, 'This link has already been used or has expired. Open a new one from the Goldfelty app.')
      }
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        location: '/',
        'set-cookie': `${this.cookieName}=${this.secret}; HttpOnly; SameSite=Strict; Path=/`
      })
      res.end()
      return
    }

    if (!this.hasSession(req)) {
      return url.pathname === '/'
        ? sendText(403, 'Open this page from the Goldfelty app.')
        : send(403, { error: 'Forbidden' })
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, 'content-security-policy': PAGE_CSP })
      res.end(BRIDGE_PAGE)
      return
    }

    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(415, { error: 'JSON only' })
    }

    let body: Record<string, unknown> = {}
    if (req.method === 'POST') {
      try {
        body = await readJson(req)
      } catch {
        return send(413, { error: 'Too large' })
      }
    }

    const pageId = String(body.pageId ?? url.searchParams.get('pageId') ?? '')
    if (!/^[\w-]{8,64}$/.test(pageId)) return send(400, { error: 'Missing pageId' })

    if (url.pathname === '/api/hello' && req.method === 'POST') {
      if (!this.pages.has(pageId) && this.pages.size >= 16) return send(429, { error: 'Too many tabs' })
      const providers = new Map<string, Provider>()
      for (const raw of Array.isArray(body.providers) ? body.providers.slice(0, 50) : []) {
        const p = raw as Partial<Provider>
        if (typeof p.rdns !== 'string' || typeof p.name !== 'string') continue
        const icon = typeof p.icon === 'string' && p.icon.startsWith('data:image/') && p.icon.length < 200_000 ? p.icon : null
        providers.set(p.rdns.slice(0, 120), {
          uuid: String(p.uuid ?? '').slice(0, 64),
          rdns: p.rdns.slice(0, 120),
          name: p.name.slice(0, 60),
          icon
        })
      }
      const page = this.pages.get(pageId) ?? { id: pageId, lastSeen: 0, providers, queue: [], waiting: null }
      page.providers = providers
      page.lastSeen = Date.now()
      this.pages.set(pageId, page)
      this.changed()
      return send(200, { ok: true })
    }

    const page = this.pages.get(pageId)
    if (!page) return send(410, { error: 'Unknown page; say hello again' })
    page.lastSeen = Date.now()

    if (url.pathname === '/api/want' && req.method === 'GET') {
      return send(200, this.wanted ?? {})
    }

    if (url.pathname === '/api/poll' && req.method === 'GET') {
      const job = page.queue.shift()
      if (job) return send(200, { id: job.id, rdns: job.rdns, method: job.method, params: job.params })
      // Only one outstanding poll per page; a newer one replaces the older.
      page.waiting?.(null)
      const timer = setTimeout(() => {
        if (page.waiting === answer) page.waiting = null
        answer(null)
      }, POLL_MS)
      const answer = (next: Job | null): void => {
        clearTimeout(timer)
        if (res.writableEnded) {
          if (next) page.queue.unshift(next)
          return
        }
        send(200, next ? { id: next.id, rdns: next.rdns, method: next.method, params: next.params } : { want: this.wanted })
      }
      page.waiting = answer
      req.on('close', () => {
        if (page.waiting === answer) page.waiting = null
      })
      return
    }

    if (url.pathname === '/api/result' && req.method === 'POST') {
      const job = this.jobs.get(String(body.id ?? ''))
      if (job && job.pageId === pageId) {
        this.jobs.delete(job.id)
        clearTimeout(job.timer)
        if (body.error) {
          const err = body.error as { message?: string; code?: number | string }
          job.reject(new WalletRequestError(String(err.message ?? err), err.code ?? 'WALLET_ERROR'))
        } else {
          job.resolve(body.result)
        }
      }
      return send(200, { ok: true })
    }

    if (url.pathname === '/api/event' && req.method === 'POST') {
      const type = body.type
      if (typeof body.rdns === 'string' && (type === 'accountsChanged' || type === 'chainChanged' || type === 'disconnect')) {
        for (const fn of this.eventListeners) fn({ rdns: body.rdns, type, data: body.data })
      }
      return send(200, { ok: true })
    }

    if (url.pathname === '/api/bye' && req.method === 'POST') {
      this.dropPage(pageId)
      this.changed()
      return send(200, { ok: true })
    }

    send(404, { error: 'Not found' })
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
