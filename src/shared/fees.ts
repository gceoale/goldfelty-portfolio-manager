/**
 * The Goldfelty send fee, as the Terms of Service describe it.
 *
 * - 0.5% of each token sent through Goldfelty, paid by the sender on top of
 *   the amount the recipient gets.
 * - Fixed in the app. Nothing outside it, including goldfelty.com, can
 *   change the rate; a different rate would need a new release, announced
 *   in the Terms and the release notes before it applied.
 * - Always shown on the review screen before anything is sent, and approved
 *   in the user's own wallet.
 * - Only charged on networks the fee wallet (Exodus) supports.
 */

/** 0.5%, in basis points (100 = 1%). */
export const FEE_BPS = 50

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

/** A rate kept within 0 and the fixed rate. */
function boundBps(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(FEE_BPS, n)
}

/** The fee on `amount` base units, rounded down so it never exceeds the rate. */
export function feeUnits(amount: bigint, bps: number): bigint {
  if (amount <= 0n) return 0n
  return (amount * BigInt(boundBps(bps))) / 10_000n
}

/** "0.5%". */
export function formatFeeRate(bps: number): string {
  return `${Number((boundBps(bps) / 100).toFixed(2))}%`
}
