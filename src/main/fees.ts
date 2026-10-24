import { getAddress, isAddress } from 'ethers'
import { DEFAULT_FEE_BPS, FEE_CHAIN_IDS, clampFeeBps, feeUnits } from '../shared/fees.ts'
import { CHAIN_BY_ID, chainsOfFamily } from '../shared/chains.ts'
import { sameAddress, validateFor } from './addresses.ts'
import type { ChainFamily, TokenDef } from '../shared/types.ts'

/**
 * Where the send fee goes, and at what rate.
 *
 * The recipients are fixed when the app is built (the GOLDFELTY_FEE_ADDRESS
 * repository variables: one for EVM networks, and _BTC, _SOL and _TRX for
 * Bitcoin, Solana and Tron). It is deliberately not fetched at runtime: if
 * goldfelty.com were ever compromised, the worst an attacker could do is
 * change the rate, within 0% to 10%, and every user would see the new rate
 * before sending. They could not redirect anyone's money.
 *
 * The rate comes from https://goldfelty.com/fees.json so the owner can
 * change it without a release.
 */

type FeeFamily = 'evm' | 'utxo' | 'solana' | 'tron'

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env

/**
 * One address per chain family, all from the same Exodus wallet. Each is set
 * at build time; a family without one charges no fee.
 */
const BUILT_IN: Record<FeeFamily, string> = {
  evm: (env?.MAIN_VITE_GOLDFELTY_FEE_ADDRESS || process.env.GOLDFELTY_FEE_ADDRESS || '').trim(),
  utxo: (env?.MAIN_VITE_GOLDFELTY_FEE_ADDRESS_BTC || process.env.GOLDFELTY_FEE_ADDRESS_BTC || '').trim(),
  solana: (env?.MAIN_VITE_GOLDFELTY_FEE_ADDRESS_SOL || process.env.GOLDFELTY_FEE_ADDRESS_SOL || '').trim(),
  tron: (env?.MAIN_VITE_GOLDFELTY_FEE_ADDRESS_TRX || process.env.GOLDFELTY_FEE_ADDRESS_TRX || '').trim()
}

export const FEE_CONFIG_URL = process.env.GOLDFELTY_FEE_CONFIG_URL ?? 'https://goldfelty.com/fees.json'
const CACHE_MS = 60 * 60_000
const TIMEOUT_MS = 4_000

const overrides = new Map<ChainFamily, string | null>()
let cached: { bps: number; at: number } | null = null

/** The fee address for a chain family, or null when this build has none (no fee there). */
export function feeRecipient(family: ChainFamily = 'evm'): string | null {
  const raw = overrides.has(family) ? overrides.get(family) : (BUILT_IN as Record<string, string>)[family]
  if (!raw) return null
  try {
    if (family === 'evm') return isAddress(raw) ? getAddress(raw) : null
    const chain = chainsOfFamily(family)[0]
    return chain ? validateFor(family, chain.key, raw) : null
  } catch {
    return null
  }
}

/** Whether this build charges a fee anywhere. */
export function feesEnabled(): boolean {
  return (['evm', 'utxo', 'solana', 'tron'] as const).some((f) => feeRecipient(f) !== null)
}

/** For tests only. `undefined` restores the built-in address. */
export function setFeeRecipientForTests(address: string | null | undefined, family: ChainFamily = 'evm'): void {
  if (address === undefined) overrides.delete(family)
  else overrides.set(family, address)
  cached = null
}

/** The current rate in basis points. Never throws; falls back to the last known or default rate. */
export async function currentFeeBps(now = Date.now()): Promise<number> {
  // No fee address in this build: no fee, and no reason to ask the site.
  if (!feesEnabled()) return 0
  if (cached && now - cached.at < CACHE_MS) return cached.bps
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let text: string
    try {
      const res = await fetch(FEE_CONFIG_URL, { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      text = await res.text()
    } finally {
      clearTimeout(timer)
    }
    if (text.length > 4096) throw new Error('too large')
    const body = JSON.parse(text) as { feeBps?: unknown }
    if (typeof body.feeBps !== 'number') throw new Error('no feeBps')
    cached = { bps: clampFeeBps(body.feeBps), at: now }
  } catch {
    // Offline or a bad file: keep the last rate we had, or the default.
    cached = { bps: cached?.bps ?? DEFAULT_FEE_BPS, at: now - CACHE_MS + 5 * 60_000 }
  }
  return cached.bps
}

export interface FeePlan {
  bps: number
  recipient: string
  units: bigint
}

/**
 * The fee for sending `units` of `token` from `from`, or null when none is
 * charged: no fee address in this build, a 0% rate, a network the fee wallet
 * doesn't support, an amount too small to carry a fee, or the owner sending
 * from the fee address itself.
 */
export function planFee(token: TokenDef, units: bigint, from: string, bps: number): FeePlan | null {
  const chain = CHAIN_BY_ID.get(token.chainId)
  if (!chain || bps <= 0) return null
  if (!FEE_CHAIN_IDS.has(token.chainId)) return null
  const recipient = feeRecipient(chain.family)
  if (!recipient) return null
  if (sameAddress(chain.family, from, recipient)) return null
  const fee = feeUnits(units, bps)
  if (fee <= 0n) return null
  // A Bitcoin output this small is "dust" and the network won't relay it.
  if (chain.family === 'utxo' && fee < BTC_DUST) return null
  return { bps, recipient, units: fee }
}

/** The smallest Bitcoin output the network relays, in satoshis. */
export const BTC_DUST = 546n
