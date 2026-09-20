import type { Store } from './store.ts'
import type { Settings } from '../shared/types.ts'

export interface PriceQuote {
  price: number
  change24h: number
  /** True when the quote came from cache because the provider was unreachable. */
  stale: boolean
}

const MEMORY_TTL_MS = 60_000
const memory = new Map<string, { price: number; change24h: number; at: number; currency: string }>()

interface CoinGeckoResponse {
  [id: string]: Record<string, number>
}

/**
 * Prices for a set of provider ids. Never throws: if the provider is down or
 * the machine is offline, the last known price is returned marked `stale`, and
 * the UI says so rather than quietly showing a wrong total.
 */
export async function fetchPrices(
  ids: string[],
  settings: Settings,
  store: Store
): Promise<Record<string, PriceQuote>> {
  const currency = settings.currency.toLowerCase()
  const unique = [...new Set(ids)].filter(Boolean).sort()
  const out: Record<string, PriceQuote> = {}
  if (unique.length === 0) return out

  const now = Date.now()
  const missing = unique.filter((id) => {
    const hit = memory.get(id)
    if (hit && hit.currency === currency && now - hit.at < MEMORY_TTL_MS) {
      out[id] = { price: hit.price, change24h: hit.change24h, stale: false }
      return false
    }
    return true
  })

  if (missing.length === 0) return out

  try {
    const url = new URL(`${settings.priceProviderUrl.replace(/\/$/, '')}/simple/price`)
    url.searchParams.set('ids', missing.join(','))
    url.searchParams.set('vs_currencies', currency)
    url.searchParams.set('include_24hr_change', 'true')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    let payload: CoinGeckoResponse
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      payload = (await response.json()) as CoinGeckoResponse
    } finally {
      clearTimeout(timer)
    }

    const persist: Record<string, { price: number; change24h: number }> = {}
    for (const id of missing) {
      const entry = payload[id]
      const price = entry?.[currency]
      if (typeof price !== 'number') {
        applyCached(id, out, store)
        continue
      }
      const change24h = entry[`${currency}_24h_change`] ?? 0
      out[id] = { price, change24h, stale: false }
      memory.set(id, { price, change24h, at: now, currency })
      persist[id] = { price, change24h }
    }
    if (Object.keys(persist).length > 0) store.cachePrices(persist)
  } catch {
    for (const id of missing) applyCached(id, out, store)
  }

  return out
}

function applyCached(id: string, out: Record<string, PriceQuote>, store: Store): void {
  const cached = store.cachedPrices()[id]
  out[id] = cached
    ? { price: cached.price, change24h: cached.change24h, stale: true }
    : { price: 0, change24h: 0, stale: true }
}

export function clearPriceMemory(): void {
  memory.clear()
}
