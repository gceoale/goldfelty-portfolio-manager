import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { getAddress } from 'ethers'
import type { WalletConnection } from '../shared/types.ts'
import { BRIDGE_PAGE } from './extensionBridgePage.ts'

/**
 * A bridge to browser-extension wallets (MetaMask, Phantom, Rabby).
 *
 * Extensions live inside the browser's sandbox and are unreachable from
 * Electron's main process. The only route is to become a web page the
 * extension will talk to: this serves one from loopback, opens it in the
 * user's default browser, and relays requests to it.
 *
 * The page holds the connection, so it has to stay open while the wallet is in
 * use. The UI says so rather than letting it fail mysteriously.
 *
 * Security posture: bound to 127.0.0.1 only, never a public interface; every
 * endpoint requires a single-use token compared in constant time; requests
 * carrying a cross-origin `Origin` header are refused.
 */

interface PendingRequest {
  id: string
  method: string
  params: unknown[]
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** How long the wallet has to answer before we give up on a request. */
const REQUEST_TIMEOUT_MS = 180_000
/** How long a poll waits before returning empty, to keep the socket alive. */
const POLL_TIMEOUT_MS = 25_000

export class ExtensionBridge {
  private server: Server | null = null
  private token = ''
  private port = 0
  private connection: WalletConnection | null = null
  private readonly queue: PendingRequest[] = []
  private waiters: Array<(request: PendingRequest | null) => void> = []
  private onChange: (() => void) | null = null
  private connectResolve: ((connection: WalletConnection) => void) | null = null

  onConnectionsChanged(fn: () => void): void {
    this.onChange = fn
  }

  get current(): WalletConnection | null {
    return this.connection
  }

  private authorised(req: IncomingMessage, url: URL): boolean {
    // A browser page on another origin must never be able to drive this.
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) {
      return false
    }
    const supplied = url.searchParams.get('token') ?? (req.headers['x-goldfelty-token'] as string | undefined) ?? ''
    const a = Buffer.from(supplied)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Start the bridge and return the URL to open in the user's browser. */
  async start(chainIds: number[]): Promise<{ url: string; connected: Promise<WalletConnection> }> {
    await this.stop()
    this.token = randomBytes(32).toString('hex')

    const connected = new Promise<WalletConnection>((resolve) => {
      this.connectResolve = resolve
    })

    this.server = createServer((req, res) => void this.handle(req, res, chainIds))

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      // Loopback only. Binding 0.0.0.0 would expose a signing bridge to the
      // local network, which would be a genuinely dangerous mistake.
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0

    return { url: `http://127.0.0.1:${this.port}/?token=${this.token}`, connected }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, chainIds: number[]): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)

    const deny = (code: number, message: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }

    if (!this.authorised(req, url)) return deny(403, 'Forbidden')

    // The page itself.
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The page talks only to its own origin and the injected provider.
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
      })
      res.end(BRIDGE_PAGE.replace('__CHAIN_IDS__', JSON.stringify(chainIds)))
      return
    }

    if (url.pathname === '/api/connect' && req.method === 'POST') {
      const body = await readJson(req)
      const accounts: string[] = []
      for (const raw of (body.accounts as string[]) ?? []) {
        try {
          accounts.push(getAddress(raw))
        } catch {
          // ignore anything that is not an address
        }
      }
      if (accounts.length === 0) return deny(400, 'No accounts supplied')

      this.connection = {
        id: this.connection?.id ?? randomUUID(),
        kind: 'extension',
        name: (body.providerName as string) || 'Browser wallet',
        icon: null,
        accounts,
        chainIds: Array.isArray(body.chainIds) ? (body.chainIds as number[]) : chainIds,
        connectedAt: Date.now(),
        active: true,
        topic: null
      }
      this.connectResolve?.(this.connection)
      this.connectResolve = null
      this.onChange?.()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Long poll: the page asks for the next thing to sign.
    if (url.pathname === '/api/poll' && req.method === 'GET') {
      const pending = this.queue.shift()
      if (pending) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: pending.id, method: pending.method, params: pending.params }))
        return
      }
      const waiter = (request: PendingRequest | null): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(request ? { id: request.id, method: request.method, params: request.params } : {})
        )
      }
      this.waiters.push(waiter)
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) {
          this.waiters.splice(index, 1)
          waiter(null)
        }
      }, POLL_TIMEOUT_MS)
      return
    }

    if (url.pathname === '/api/result' && req.method === 'POST') {
      const body = await readJson(req)
      const entry = this.inFlight.get(body.id as string)
      if (entry) {
        this.inFlight.delete(body.id as string)
        clearTimeout(entry.timer)
        if (body.error) entry.reject(new Error(String(body.error)))
        else entry.resolve(String(body.result))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/api/disconnect' && req.method === 'POST') {
      if (this.connection) this.connection.active = false
      this.onChange?.()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    deny(404, 'Not found')
  }

  private readonly inFlight = new Map<string, PendingRequest>()

  /** Ask the browser page to run a request against the extension. */
  async request(method: string, params: unknown[]): Promise<string> {
    if (!this.connection?.active) {
      throw new Error('The browser wallet page is closed. Reconnect it from Settings → Wallets.')
    }

    return new Promise<string>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.inFlight.delete(id)
        reject(new Error('The wallet did not respond. Check the browser tab for a pending prompt.'))
      }, REQUEST_TIMEOUT_MS)

      const pending: PendingRequest = { id, method, params, resolve, reject, timer }
      this.inFlight.set(id, pending)

      const waiter = this.waiters.shift()
      if (waiter) waiter(pending)
      else this.queue.push(pending)
    })
  }

  async disconnect(): Promise<void> {
    this.connection = null
    await this.stop()
    this.onChange?.()
  }

  async stop(): Promise<void> {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('The wallet bridge was closed.'))
    }
    this.inFlight.clear()
    this.queue.length = 0
    this.waiters.forEach((waiter) => waiter(null))
    this.waiters = []
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Nothing legitimate here is large; refuse to buffer more than 1 MB.
    if (size > 1_048_576) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
