import { jsonRpc, postJson } from '../backends/http.ts'
import { planBitcoin, finishBitcoin, broadcastBitcoin, bitcoinStatus, BitcoinError } from './bitcoin.ts'
import { planSolana, finishSolana, broadcastSolana, solanaStatus } from './solana.ts'
import { buildTron, finishTron, broadcastTron, estimateTronFee, tronStatus } from './tron.ts'
import type { FeePlan } from '../fees.ts'
import type { Chain, Settings, TokenDef, Wallet } from '../../shared/types.ts'

/**
 * Sending on Bitcoin, Solana and Tron. transfers.ts handles everything the
 * chains share (validation, warnings, prices, records); this file does the
 * part that differs: building, signing, checking and broadcasting.
 */

/** What the connection manager offers for these chains. */
export interface OtherSigner {
  signPsbt(connectionId: string, psbtHex: string, inputs: number[], address: string): Promise<string>
  signSolana(connectionId: string, address: string, txBase64: string): Promise<string>
  signTron(connectionId: string, tx: unknown): Promise<unknown>
}

export class OtherSendError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface OtherQuote {
  /** Native base units: satoshis, lamports or sun. */
  networkFee: bigint
  /** The fee as it will actually be charged; null if this chain can't carry it for this transfer. */
  fee: FeePlan | null
  warnings: string[]
}

export async function quoteOther(chain: Chain, settings: Settings, wallet: Wallet, token: TokenDef, to: string, units: bigint, fee: FeePlan | null): Promise<OtherQuote> {
  const warnings: string[] = []
  try {
    switch (chain.family) {
      case 'utxo': {
        const plan = await planBitcoin(chain, settings, wallet, to, units, fee)
        return { networkFee: plan.networkFee, fee, warnings }
      }
      case 'solana': {
        const plan = await planSolana(chain, settings, wallet.address, to, token, units, fee)
        const charged = plan.feeIncluded ? fee : null
        const { value } = await jsonRpc<{ value: number }>(chain.id, settings, 'getBalance', [wallet.address, { commitment: 'confirmed' }])
        const needed = plan.networkFee + (token.address === null ? units + (charged?.units ?? 0n) : 0n)
        if (BigInt(value) < needed) warnings.push(`${wallet.label} doesn’t have enough SOL to cover this and the fees.`)
        return { networkFee: plan.networkFee, fee: charged, warnings: [...plan.warnings, ...warnings] }
      }
      case 'tron': {
        const one = await estimateTronFee(chain, settings, wallet.address, to, token, units)
        // The fee is its own transaction, with its own network cost.
        const networkFee = fee ? one * 2n : one
        const account = await postJson<{ balance?: number }>(chain.id, settings, '/wallet/getaccount', { address: wallet.address, visible: true })
        const needed = networkFee + (token.address === null ? units + (fee?.units ?? 0n) : 0n)
        if (BigInt(account.balance ?? 0) < needed) {
          warnings.push(`${wallet.label} may not have enough TRX for this and the network fee. Tron charges less if you have staked energy or bandwidth.`)
        }
        return { networkFee, fee, warnings }
      }
      default:
        throw new OtherSendError(`Goldfelty can’t send on ${chain.name}. Send from the wallet itself.`, 'CANT_SEND')
    }
  } catch (error) {
    if (error instanceof OtherSendError) throw error
    const message = (error as Error).message
    // A problem that will stop the send is worth showing as it is; anything else is the network.
    warnings.push((error as { code?: string }).code && !/BACKEND/.test(String((error as { code?: string }).code)) ? message : `Couldn’t reach ${chain.name}, so the fee is a guess.`)
    return { networkFee: 0n, fee, warnings }
  }
}

export interface OtherSent {
  hash: string
  /** Set when a fee was asked for. `sameTransaction` when it rode in the transfer itself. */
  fee: null | { plan: FeePlan; status: 'sent' | 'declined' | 'failed'; hash: string | null; message?: string; sameTransaction: boolean }
}

function feeChanged(): OtherSendError {
  return new OtherSendError('Goldfelty’s fee changed since you reviewed this. Review it again before sending.', 'FEE_CHANGED')
}

export async function sendOther(
  chain: Chain,
  settings: Settings,
  signer: OtherSigner,
  wallet: Wallet,
  token: TokenDef,
  to: string,
  units: bigint,
  fee: FeePlan | null,
  shownBps: number
): Promise<OtherSent> {
  const connectionId = wallet.connectionId!
  switch (chain.family) {
    case 'utxo': {
      if ((fee?.bps ?? 0) > shownBps) throw feeChanged()
      const plan = await planBitcoin(chain, settings, wallet, to, units, fee)
      const signed = await signer.signPsbt(connectionId, plan.psbtHex, plan.inputs, wallet.address)
      const hash = await broadcastBitcoin(chain, settings, finishBitcoin(chain, plan, signed))
      return { hash, fee: fee ? { plan: fee, status: 'sent', hash, sameTransaction: true } : null }
    }
    case 'solana': {
      const plan = await planSolana(chain, settings, wallet.address, to, token, units, fee)
      const charged = plan.feeIncluded ? fee : null
      if ((charged?.bps ?? 0) > shownBps) throw feeChanged()
      const signed = await signer.signSolana(connectionId, wallet.address, plan.txBase64)
      const hash = await broadcastSolana(chain, settings, finishSolana(plan, wallet.address, signed))
      return { hash, fee: charged ? { plan: charged, status: 'sent', hash, sameTransaction: true } : null }
    }
    case 'tron': {
      if ((fee?.bps ?? 0) > shownBps) throw feeChanged()
      const tx = await buildTron(chain, settings, wallet.address, to, token, units)
      const signed = await signer.signTron(connectionId, tx)
      const hash = await broadcastTron(chain, settings, finishTron(tx, wallet.address, signed))
      if (!fee) return { hash, fee: null }
      // As on EVM networks: the fee is asked for only once the transfer is on its way.
      try {
        const feeTx = await buildTron(chain, settings, wallet.address, fee.recipient, token, fee.units)
        const feeSigned = await signer.signTron(connectionId, feeTx)
        const feeHash = await broadcastTron(chain, settings, finishTron(feeTx, wallet.address, feeSigned))
        return { hash, fee: { plan: fee, status: 'sent', hash: feeHash, sameTransaction: false } }
      } catch (error) {
        const err = error as Error & { code?: string | number }
        const declined = err.code === 4001 || /reject|denied|cancell?ed|declined/i.test(err.message)
        return { hash, fee: { plan: fee, status: declined ? 'declined' : 'failed', hash: null, message: declined ? 'The fee was declined.' : err.message, sameTransaction: false } }
      }
    }
    default:
      throw new OtherSendError(`Goldfelty can’t send on ${chain.name}. Send from the wallet itself.`, 'CANT_SEND')
  }
}

/** Where a transaction stands on its chain. */
export async function otherStatus(chain: Chain, settings: Settings, hash: string): Promise<'confirmed' | 'failed' | 'pending'> {
  switch (chain.family) {
    case 'utxo':
      return bitcoinStatus(chain, settings, hash)
    case 'solana':
      return solanaStatus(chain, settings, hash)
    case 'tron':
      return tronStatus(chain, settings, hash)
    default:
      return 'pending'
  }
}

export { BitcoinError }
