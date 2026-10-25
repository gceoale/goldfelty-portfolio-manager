import { getAddress, isAddress } from 'ethers'
import { FEE_BPS, FEE_CHAIN_IDS, feeUnits } from '../shared/fees.ts'
import { CHAIN_BY_ID, chainsOfFamily } from '../shared/chains.ts'
import { sameAddress, validateFor } from './addresses.ts'
import type { ChainFamily, TokenDef } from '../shared/types.ts'

/**
 * Where the send fee goes, and at what rate.
 *
 * The rate is a fixed 0.5% (FEE_BPS), set in the app itself. Nothing is
 * fetched to decide it, so no server, including goldfelty.com, can raise it.
 *
 * The recipients are fixed when the app is built (the GOLDFELTY_FEE_ADDRESS
 * repository variables: one for EVM networks, and _BTC, _SOL and _TRX for
 * Bitcoin, Solana and Tron). They are never fetched at runtime either.
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

const overrides = new Map<ChainFamily, string | null>()

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
}

/** The rate in basis points: the fixed 0.5%, or 0 when this build has no fee address. */
export function currentFeeBps(): number {
  return feesEnabled() ? FEE_BPS : 0
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
