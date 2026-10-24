import { CHAIN_BY_ID, DEFAULT_CHAIN_IDS } from '../shared/chains.ts'
import type { Settings } from '../shared/types.ts'

/**
 * Settings, and the rules for changing them.
 *
 * Several settings decide where Goldfelty sends requests (RPC endpoints, the
 * price provider), so they are validated here in the main process rather
 * than trusted from the renderer, and they live in the encrypted store so
 * nothing on disk can quietly point the app somewhere else.
 */

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  currency: 'USD',
  autoLockMinutes: 10,
  hideBalances: false,
  refreshIntervalSeconds: 60,
  priceProviderUrl: 'https://api.coingecko.com/api/v3',
  customRpc: {},
  enabledChains: [...DEFAULT_CHAIN_IDS],
  walletConnectProjectId: '',
  shareTotals: false
}

const THEMES = new Set<Settings['theme']>(['dark', 'light', 'system'])
const CURRENCIES = new Set<Settings['currency']>(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'])

export const AUTO_LOCK_LIMITS = { min: 1, max: 120 } as const
export const REFRESH_LIMITS = { min: 15, max: 3600 } as const

export class SettingsError extends Error {
  code = 'BAD_SETTING'
}

/**
 * Whether a URL is acceptable as an endpoint Goldfelty will call: HTTPS
 * anywhere, or plain HTTP only to this machine (a local node). No embedded
 * credentials, which would otherwise end up in logs and error messages.
 */
export function isAllowedEndpoint(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  return false
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Apply a patch from the renderer. Unknown keys are dropped, every value is
 * type-checked, and anything that would point the app at a new server must
 * pass `isAllowedEndpoint`. Throws on a bad endpoint so the user sees why.
 */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  const next: Settings = { ...current, customRpc: { ...current.customRpc }, enabledChains: [...current.enabledChains] }

  if ('theme' in p && THEMES.has(p.theme as Settings['theme'])) next.theme = p.theme as Settings['theme']
  if ('currency' in p && CURRENCIES.has(p.currency as Settings['currency'])) next.currency = p.currency as Settings['currency']
  if ('autoLockMinutes' in p) next.autoLockMinutes = clampInt(p.autoLockMinutes, AUTO_LOCK_LIMITS.min, AUTO_LOCK_LIMITS.max, current.autoLockMinutes)
  if ('hideBalances' in p && typeof p.hideBalances === 'boolean') next.hideBalances = p.hideBalances
  if ('refreshIntervalSeconds' in p) {
    next.refreshIntervalSeconds = clampInt(p.refreshIntervalSeconds, REFRESH_LIMITS.min, REFRESH_LIMITS.max, current.refreshIntervalSeconds)
  }

  if ('priceProviderUrl' in p) {
    const url = String(p.priceProviderUrl ?? '').trim()
    if (!url) next.priceProviderUrl = DEFAULT_SETTINGS.priceProviderUrl
    else if (!isAllowedEndpoint(url)) throw new SettingsError('The price source must be an https:// address.')
    else next.priceProviderUrl = url
  }

  if ('customRpc' in p && p.customRpc && typeof p.customRpc === 'object') {
    for (const [key, value] of Object.entries(p.customRpc as Record<string, unknown>)) {
      const chainId = Number(key)
      if (!CHAIN_BY_ID.has(chainId)) continue
      const url = String(value ?? '').trim()
      if (!url) {
        delete next.customRpc[chainId]
        continue
      }
      if (!isAllowedEndpoint(url)) {
        throw new SettingsError(`The ${CHAIN_BY_ID.get(chainId)!.name} endpoint must be https://, or http:// on this computer.`)
      }
      next.customRpc[chainId] = url
    }
  }

  if ('enabledChains' in p && Array.isArray(p.enabledChains)) {
    const ids = [...new Set(p.enabledChains.map(Number).filter((id) => CHAIN_BY_ID.has(id)))]
    if (ids.length === 0) throw new SettingsError('Keep at least one network turned on.')
    next.enabledChains = ids
  }

  if ('shareTotals' in p && typeof p.shareTotals === 'boolean') next.shareTotals = p.shareTotals

  if ('walletConnectProjectId' in p) {
    const id = String(p.walletConnectProjectId ?? '').trim()
    if (id && !/^[0-9a-f]{32}$/i.test(id)) throw new SettingsError('A WalletConnect project ID is 32 hexadecimal characters.')
    next.walletConnectProjectId = id.toLowerCase()
  }

  return next
}

/** Bring settings read from disk back inside the rules, field by field. */
export function normaliseSettings(raw: unknown): Settings {
  const base = { ...DEFAULT_SETTINGS }
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  let result = base
  // Field by field, so one bad value from an old file resets only itself.
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (!(key in r)) continue
    try {
      result = applySettingsPatch(result, { [key]: r[key] })
    } catch {
      // keep the default for this field
    }
  }
  // Version 1 allowed 0 for "never lock". That is no longer offered.
  if (Number(r.autoLockMinutes) === 0) result.autoLockMinutes = DEFAULT_SETTINGS.autoLockMinutes
  return result
}
