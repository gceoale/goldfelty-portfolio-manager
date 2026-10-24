import WebSocket from 'ws'

/**
 * Frame, the desktop wallet, reached over the JSON-RPC socket it serves on
 * loopback. No browser and no relay involved: Goldfelty talks to Frame on
 * this machine, and Frame talks to the user's keys, including any Ledger,
 * Trezor or GridPlus device plugged into it.
 *
 * Frame identifies callers by Origin and asks the user to approve each new
 * one, so the socket presents goldfelty.com, which is who this is.
 */

export const FRAME_URL = 'ws://127.0.0.1:1248'
const ORIGIN = 'https://goldfelty.com'
const CONNECT_MS = 1_500
const REQUEST_MS = 3 * 60_000

export class FrameUnavailableError extends Error {
  code = 'FRAME_UNAVAILABLE'
  constructor() {
    super('Frame isn’t running on this computer. Open Frame and try again.')
  }
}

export class FrameRequestError extends Error {
  readonly code: number | string
  constructor(message: string, code: number | string = 'FRAME_ERROR') {
    super(message)
    this.code = code
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class FrameConnector {
  private socket: WebSocket | null = null
  private opening: Promise<WebSocket> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly subscriptions = new Map<string, 'accountsChanged' | 'chainChanged'>()
  private readonly listeners = new Set<(type: 'accountsChanged' | 'chainChanged' | 'closed', data: unknown) => void>()

  private readonly url: string

  constructor(url = FRAME_URL) {
    this.url = url
  }

  get active(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  onEvent(fn: (type: 'accountsChanged' | 'chainChanged' | 'closed', data: unknown) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(type: 'accountsChanged' | 'chainChanged' | 'closed', data: unknown): void {
    for (const fn of this.listeners) fn(type, data)
  }

  /** Whether Frame is running. Opens the socket if it is. */
  async detect(): Promise<boolean> {
    try {
      await this.open()
      return true
    } catch {
      return false
    }
  }

  private open(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.opening) return this.opening

    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, { origin: ORIGIN, handshakeTimeout: CONNECT_MS })
      const fail = (): void => {
        this.opening = null
        reject(new FrameUnavailableError())
      }
      socket.once('error', fail)
      socket.once('open', () => {
        socket.off('error', fail)
        socket.on('error', () => undefined)
        socket.on('message', (raw) => this.receive(raw.toString()))
        socket.on('close', () => this.closed())
        this.socket = socket
        this.opening = null
        resolve(socket)
        void this.subscribe()
      })
    })
    return this.opening
  }

  private closed(): void {
    this.socket = null
    this.subscriptions.clear()
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new FrameRequestError('Frame closed the connection.', 'FRAME_CLOSED'))
      this.pending.delete(id)
    }
    this.emit('closed', null)
  }

  private receive(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string; params?: { subscription?: string; result?: unknown } }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }

    if (msg.method === 'eth_subscription' && msg.params?.subscription) {
      const type = this.subscriptions.get(msg.params.subscription)
      if (type) this.emit(type, msg.params.result)
      return
    }

    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new FrameRequestError(msg.error.message ?? 'Frame declined.', msg.error.code ?? 'FRAME_ERROR'))
    else p.resolve(msg.result)
  }

  private async subscribe(): Promise<void> {
    for (const type of ['accountsChanged', 'chainChanged'] as const) {
      try {
        const id = (await this.request('eth_subscribe', [type], 5_000)) as string
        if (typeof id === 'string') this.subscriptions.set(id, type)
      } catch {
        // Older Frame builds lack these; the app simply re-reads on refresh.
      }
    }
  }

  async request(method: string, params: unknown[] = [], timeoutMs = REQUEST_MS): Promise<unknown> {
    const socket = await this.open()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new FrameRequestError('Frame did not answer. Check Frame for a pending request.', 'TIMEOUT'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
