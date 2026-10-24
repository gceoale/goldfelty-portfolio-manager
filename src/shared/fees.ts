/**
 * The Goldfelty send fee, as the Terms of Service describe it.
 *
 * - A percentage of each token sent through Goldfelty, paid by the sender on
 *   top of the amount the recipient gets.
 * - Set by the owner of goldfelty.com, between 0% and 10%. The app clamps
 *   whatever it is told to that range.
 * - Always shown on the review screen before anything is sent, and approved
 *   in the user's own wallet as a separate transaction.
 * - Only charged on networks the fee wallet (Exodus) supports.
 */

/** 10%, the most the Terms allow. Basis points: 100 = 1%. */
export const MAX_FEE_BPS = 1000

/** 0.5%, used until goldfelty.com says otherwise, or when it can't be reached. */
export const DEFAULT_FEE_BPS = 50

/**
 * Networks where fees are taken: the networks Exodus supports that Goldfelty
 * can send on. One Exodus address receives on all the EVM networks; Bitcoin,
 * Solana and Tron each have their own. Testnets are never charged, and
 * Litecoin, Dogecoin and XRP can't be sent from Goldfelty at all.
 */
export const FEE_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  56, // BNB Smart Chain
  137, // Polygon
  43114, // Avalanche C-Chain
  42161, // Arbitrum One
  10, // Optimism
  8453, // Base
  -1, // Bitcoin
  -501, // Solana
  -195 // Tron
])

export function clampFeeBps(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_FEE_BPS, n)
}

/** The fee on `amount` base units, rounded down so it never exceeds the rate. */
export function feeUnits(amount: bigint, bps: number): bigint {
  if (amount <= 0n) return 0n
  return (amount * BigInt(clampFeeBps(bps))) / 10_000n
}

/** "0.5%", "1%", "0.25%". */
export function formatFeeRate(bps: number): string {
  return `${Number((clampFeeBps(bps) / 100).toFixed(2))}%`
}
