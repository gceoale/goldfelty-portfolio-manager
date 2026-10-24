import { getAddress, isAddress } from 'ethers'
import { DEFAULT_FEE_BPS, FEE_CHAIN_IDS, clampFeeBps, feeUnits } from '../shared/fees.ts'
import type { TokenDef } from '../shared/types.ts'

/**
 * Where the send fee goes, and at what rate.
 *
 * The recipient is fixed when the app is built (the GOLDFELTY_FEE_ADDRESS
 * repository variable). It is deliberately not fetched at runtime: if
 * goldfelty.com were ever compromised, the worst an attacker could do is
 * change the rate, within 0% to 10%, and every user would see the new rate
 * before sending. They could not redirect anyone's money.
 *
 * The rate comes from https://goldfelty.com/fees.json so the owner can
 * change it without a release.
 */

const BUILT_IN_RECIPIENT: string = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.MAIN_VITE_GOLDFELTY_FEE_ADDRESS ||
  process.env.GOLDFELTY_FEE_ADDRESS ||
  ''
).trim()

export const FEE_CONFIG_URL = process.env.GOLDFELTY_FEE_CONFIG_URL ?? 'https://goldfelty.com/fees.json'
const CACHE_MS = 60 * 60_000
const TIMEOUT_MS = 4_000

let recipientOverride: string | null | undefined
let cached: { bps: number; at: number } | null = null

/** The fee address, or null when this build has none (fees off). */
export function feeRecipient(): string | null {
  const raw = recipientOverride !== undefined ? recipientOverride : BUILT_IN_RECIPIENT
  return raw && isAddress(raw) ? getAddress(raw) : null
}

/** For tests only. */
export function setFeeRecipientForTests(address: string | null | undefined): void {
  recipientOverride = address
  cached = null
}

/** The current rate in basis points. Never throws; falls back to the last known or default rate. */
export async function currentFeeBps(now = Date.now()): Promise<number> {
  // No fee address in this build: no fee, and no reason to ask the site.
  if (!feeRecipient()) return 0
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
  const recipient = feeRecipient()
  if (!recipient || bps <= 0) return null
  if (!FEE_CHAIN_IDS.has(token.chainId)) return null
  if (from.toLowerCase() === recipient.toLowerCase()) return null
  const fee = feeUnits(units, bps)
  if (fee <= 0n) return null
  return { bps, recipient, units: fee }
}
