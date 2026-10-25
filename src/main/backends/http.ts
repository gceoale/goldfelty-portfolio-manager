import { endpointsFor, markFailed, markHealthy } from '../rpc.ts'
import type { Settings } from '../../shared/types.ts'

/**
 * HTTP for the chains that aren't EVM. Each chain lists API base URLs (and a
 * custom one may come first from Settings); a request tries them in order,
 * and an endpoint that fails sits out for a minute, as with EVM RPCs.
 */

const TIMEOUT_MS = 12_000
/** Larger than any balance, UTXO list or transaction a wallet here would need. */
const MAX_BYTES = 4_000_000

export class BackendError extends Error {
  code = 'BACKEND_UNAVAILABLE'
}

/** The endpoint answered, and the answer is a definite no (bad request, unknown account). */
export class BackendRefusal extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`Request refused (${status}).`)
    this.status = status
    this.body = body
  }
}

async function once(url: string, init: RequestInit): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new BackendError('Response too large.')
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new BackendRefusal(res.status, text.slice(0, 500))
    if (!res.ok) throw new BackendError(`${res.status} ${res.statusText}`)
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Try each endpoint for `chainId` until one answers. A 4xx refusal is returned to the caller, not retried. */
export async function request(chainId: number, settings: Settings, path: string, init: RequestInit = {}): Promise<string> {
  let last = 'no endpoints'
  for (const base of endpointsFor(chainId, settings)) {
    const url = base.replace(/\/$/, '') + path
    try {
      const text = await once(url, init)
      markHealthy(base)
      return text
    } catch (error) {
      if (error instanceof BackendRefusal) {
        markHealthy(base)
        throw error
      }
      last = (error as Error).message
      markFailed(base)
    }
  }
  throw new BackendError(`No endpoint answered: ${last}`)
}

export async function getJson<T>(chainId: number, settings: Settings, path: string): Promise<T> {
  return JSON.parse(await request(chainId, settings, path, { headers: { accept: 'application/json' } })) as T
}

export async function postJson<T>(chainId: number, settings: Settings, path: string, body: unknown): Promise<T> {
  return JSON.parse(
    await request(chainId, settings, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    })
  ) as T
}

let rpcId = 1
/** A JSON-RPC 2.0 call (Solana, and XRPL's similar dialect is handled in its own module). */
export async function jsonRpc<T>(chainId: number, settings: Settings, method: string, params: unknown[]): Promise<T> {
  const body = await postJson<{ result?: T; error?: { message?: string; code?: number } }>(chainId, settings, '', {
    jsonrpc: '2.0',
    id: rpcId++,
    method,
    params
  })
  if (body.error) throw new BackendRefusal(400, body.error.message ?? 'RPC error')
  return body.result as T
}
