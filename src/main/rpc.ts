import { JsonRpcProvider, Network } from 'ethers'
import { getChain } from '../shared/chains.ts'
import type { Settings } from '../shared/types.ts'

interface RpcCall {
  method: string
  params: unknown[]
}

const REQUEST_TIMEOUT_MS = 12_000

/** Endpoints that have failed recently, with the time they may be retried. */
const cooldown = new Map<string, number>()
const COOLDOWN_MS = 60_000

function endpointsFor(chainId: number, settings: Settings): string[] {
  const chain = getChain(chainId)
  const custom = settings.customRpc?.[chainId]
  const all = custom ? [custom, ...chain.rpcUrls] : [...chain.rpcUrls]
  const now = Date.now()
  const healthy = all.filter((url) => (cooldown.get(url) ?? 0) <= now)
  // If every endpoint is cooling down, try them all anyway rather than failing
  // outright — a network blip should not brick the app for a whole minute.
  return healthy.length > 0 ? healthy : all
}

function markFailed(url: string): void {
  cooldown.set(url, Date.now() + COOLDOWN_MS)
}

function markHealthy(url: string): void {
  cooldown.delete(url)
}

async function post(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export class RpcUnavailableError extends Error {
  code = 'RPC_UNAVAILABLE'
  constructor(chainId: number, cause: string) {
    super(`No reachable RPC endpoint for chain ${chainId}: ${cause}`)
  }
}

/**
 * Run a batch of JSON-RPC calls against the first endpoint that answers.
 * Batching matters here: a 50-wallet portfolio across 5 chains and 8 tokens is
 * thousands of `balanceOf` reads, and one round trip per chain keeps it quick.
 */
export async function rpcBatch(chainId: number, calls: RpcCall[], settings: Settings): Promise<Array<string | null>> {
  if (calls.length === 0) return []
  const endpoints = endpointsFor(chainId, settings)
  let lastError = 'no endpoints configured'

  for (const url of endpoints) {
    try {
      const results: Array<string | null> = new Array(calls.length).fill(null)
      // Keep batches modest; public endpoints reject very large payloads.
      const CHUNK = 100
      for (let offset = 0; offset < calls.length; offset += CHUNK) {
        const slice = calls.slice(offset, offset + CHUNK)
        const payload = slice.map((call, i) => ({
          jsonrpc: '2.0',
          id: offset + i,
          method: call.method,
          params: call.params
        }))
        const raw = (await post(url, payload)) as Array<{ id: number; result?: string; error?: unknown }>
        if (!Array.isArray(raw)) throw new Error('malformed batch response')
        for (const entry of raw) {
          // A per-call error (e.g. a token that is not a contract here) is not
          // an endpoint failure — record null and carry on.
          results[entry.id] = entry.error ? null : (entry.result ?? null)
        }
      }
      markHealthy(url)
      return results
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      markFailed(url)
    }
  }
  throw new RpcUnavailableError(chainId, lastError)
}

const providers = new Map<string, JsonRpcProvider>()

/** A provider for signing and broadcasting. Cached per chain and endpoint. */
export function providerFor(chainId: number, settings: Settings): JsonRpcProvider {
  const url = endpointsFor(chainId, settings)[0]
  if (!url) throw new RpcUnavailableError(chainId, 'no endpoints configured')
  const cacheKey = `${chainId}|${url}`
  let provider = providers.get(cacheKey)
  if (!provider) {
    const chain = getChain(chainId)
    provider = new JsonRpcProvider(url, Network.from(chainId), {
      staticNetwork: Network.from(chainId),
      batchMaxCount: 20,
      pollingInterval: 8_000
    })
    provider.on('error', () => markFailed(url))
    void chain
    providers.set(cacheKey, provider)
  }
  return provider
}

export function disposeProviders(): void {
  for (const provider of providers.values()) provider.destroy()
  providers.clear()
}

/** Cheap reachability probe used by Settings → Networks. */
export async function probeChain(chainId: number, settings: Settings): Promise<{ ok: boolean; blockNumber?: number; latencyMs?: number; error?: string }> {
  const started = Date.now()
  try {
    const [result] = await rpcBatch(chainId, [{ method: 'eth_blockNumber', params: [] }], settings)
    if (!result) throw new Error('empty response')
    return { ok: true, blockNumber: Number(BigInt(result)), latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
