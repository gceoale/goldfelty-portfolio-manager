import * as bitcoin from 'bitcoinjs-lib'
import { getJson, request } from '../backends/http.ts'
import { UTXO_NETWORKS } from '../addresses.ts'
import { BTC_DUST } from '../fees.ts'
import type { Chain, Settings } from '../../shared/types.ts'

/**
 * Bitcoin transfers.
 *
 * Goldfelty picks the coins, builds an unsigned PSBT and asks the wallet to
 * sign its inputs. The Goldfelty fee, when there is one, is an extra output
 * of the same transaction, so the wallet shows both payments on one screen
 * and the user approves them together. What comes back is checked against
 * what was asked for, byte for byte, before Goldfelty broadcasts it itself.
 */

export class BitcoinError extends Error {
  readonly code: string
  constructor(message: string, code = 'BTC_FAILED') {
    super(message)
    this.code = code
  }
}

type InputKind = 'p2wpkh' | 'p2tr' | 'p2sh-p2wpkh' | 'p2pkh'

/** Virtual bytes each input type adds once signed. */
const INPUT_VBYTES: Record<InputKind, number> = { p2wpkh: 68, p2tr: 58, 'p2sh-p2wpkh': 91, p2pkh: 148 }
const OVERHEAD_VBYTES = 11
/** Spending more coins than this in one go is never needed and would make huge PSBTs. */
const MAX_INPUTS = 200
/** Refuse fee rates beyond this, sat/vB: a sign of a broken or hostile fee API. */
const MAX_FEE_RATE = 500
const RBF_SEQUENCE = 0xfffffffd

interface Utxo {
  txid: string
  vout: number
  value: number
  status?: { confirmed?: boolean }
}

export interface BitcoinPlan {
  psbtHex: string
  /** Indexes of the inputs the wallet must sign: all of them. */
  inputs: number[]
  networkFee: bigint
  feeRate: number
  /** The unsigned transaction, for comparison with what the wallet returns. */
  unsignedTx: string
  outputs: Array<{ address: string; value: bigint }>
}

function network(chain: Chain): bitcoin.Network {
  const n = UTXO_NETWORKS[chain.key]
  if (!n || chain.key !== 'bitcoin') throw new BitcoinError(`Goldfelty can’t send on ${chain.name}.`, 'UNSUPPORTED')
  return n
}

function kindOf(script: Uint8Array): InputKind | null {
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh'
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr'
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14) return 'p2sh-p2wpkh'
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9) return 'p2pkh'
  return null
}

function outputVbytes(script: Uint8Array): number {
  return 8 + 1 + script.length
}

/** How the wallet's own address is spent, and the extra data each type needs in a PSBT. */
function spendInfo(address: string, publicKey: string | null | undefined, net: bitcoin.Network) {
  const script = bitcoin.address.toOutputScript(address, net)
  const kind = kindOf(script)
  if (!kind) throw new BitcoinError('Goldfelty can’t spend from this kind of Bitcoin address.', 'UNSUPPORTED_ADDRESS')
  const pubkey = publicKey ? Buffer.from(publicKey, 'hex') : null
  let redeemScript: Buffer | undefined
  let tapInternalKey: Buffer | undefined
  if (kind === 'p2sh-p2wpkh') {
    if (!pubkey || pubkey.length !== 33) throw new BitcoinError('Reconnect this wallet: Goldfelty needs its public key to spend from this address.', 'NO_PUBLIC_KEY')
    const inner = bitcoin.payments.p2wpkh({ pubkey, network: net })
    const outer = bitcoin.payments.p2sh({ redeem: inner, network: net })
    if (outer.address !== address) throw new BitcoinError('The wallet’s public key doesn’t match this address.', 'KEY_MISMATCH')
    redeemScript = inner.output
  }
  if (kind === 'p2tr') {
    const x = pubkey && pubkey.length === 33 ? pubkey.subarray(1) : pubkey
    if (!x || x.length !== 32) throw new BitcoinError('Reconnect this wallet: Goldfelty needs its public key to spend from a Taproot address.', 'NO_PUBLIC_KEY')
    const tr = bitcoin.payments.p2tr({ internalPubkey: x, network: net })
    if (tr.address !== address) throw new BitcoinError('The wallet’s public key doesn’t match this address.', 'KEY_MISMATCH')
    tapInternalKey = x
  }
  return { script, kind, redeemScript, tapInternalKey }
}

/** sat/vB for confirmation within about three blocks. */
export async function feeRate(chain: Chain, settings: Settings): Promise<number> {
  const estimates = await getJson<Record<string, number>>(chain.id, settings, '/fee-estimates')
  const raw = estimates['3'] ?? estimates['2'] ?? estimates['6'] ?? estimates['1']
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new BitcoinError('Couldn’t get a Bitcoin fee estimate.', 'NO_FEE_RATE')
  const rate = Math.max(1, Math.ceil(raw))
  if (rate > MAX_FEE_RATE) throw new BitcoinError(`Bitcoin fees are unusually high right now (${rate} sat/vB). Try again later.`, 'FEE_TOO_HIGH')
  return rate
}

/**
 * Pick coins and build the PSBT: `to` gets `units`, the fee address (if
 * any) gets its share, and what is left over returns to the sender.
 */
export async function planBitcoin(
  chain: Chain,
  settings: Settings,
  from: { address: string; publicKey?: string | null },
  to: string,
  units: bigint,
  fee: { recipient: string; units: bigint } | null
): Promise<BitcoinPlan> {
  const net = network(chain)
  const spend = spendInfo(from.address, from.publicKey, net)
  if (units < BTC_DUST) throw new BitcoinError(`Bitcoin can’t send less than ${BTC_DUST} satoshis.`, 'DUST')

  const [utxos, rate] = await Promise.all([
    getJson<Utxo[]>(chain.id, settings, `/address/${encodeURIComponent(from.address)}/utxo`),
    feeRate(chain, settings)
  ])
  if (!Array.isArray(utxos)) throw new BitcoinError('Unexpected answer from the Bitcoin API.')

  const outputs: Array<{ address: string; value: bigint }> = [{ address: to, value: units }]
  if (fee) outputs.push({ address: fee.recipient, value: fee.units })
  const outScripts = outputs.map((o) => bitcoin.address.toOutputScript(o.address, net))
  const changeVbytes = outputVbytes(spend.script)
  const fixedVbytes = OVERHEAD_VBYTES + outScripts.reduce((n, s) => n + outputVbytes(s), 0)
  const target = outputs.reduce((n, o) => n + o.value, 0n)

  // Largest coins first: fewest inputs, so the lowest network fee.
  const coins = utxos
    .filter((u) => typeof u.txid === 'string' && /^[0-9a-f]{64}$/i.test(u.txid) && Number.isInteger(u.vout) && Number.isSafeInteger(u.value) && u.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_INPUTS)

  const chosen: Utxo[] = []
  let total = 0n
  let change = 0n
  let networkFee = 0n
  let done = false
  for (const coin of coins) {
    chosen.push(coin)
    total += BigInt(coin.value)
    const inputVbytes = chosen.length * INPUT_VBYTES[spend.kind]
    const feeWithChange = BigInt(Math.ceil((fixedVbytes + inputVbytes + changeVbytes) * rate))
    const feeWithout = BigInt(Math.ceil((fixedVbytes + inputVbytes) * rate))
    if (total >= target + feeWithChange + BTC_DUST) {
      change = total - target - feeWithChange
      networkFee = feeWithChange
      done = true
      break
    }
    if (total >= target + feeWithout) {
      // Too little left for a change output: it goes to the miners instead.
      change = 0n
      networkFee = total - target
      done = true
      break
    }
  }
  if (!done) {
    throw new BitcoinError('There isn’t enough BTC at this address to cover this, the fees and the network fee.', 'INSUFFICIENT')
  }

  const psbt = new bitcoin.Psbt({ network: net })
  psbt.setVersion(2)
  for (const coin of chosen) {
    const input: Parameters<typeof psbt.addInput>[0] = {
      hash: coin.txid,
      index: coin.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: { script: spend.script, value: coin.value }
    }
    if (spend.redeemScript) input.redeemScript = spend.redeemScript
    if (spend.tapInternalKey) input.tapInternalKey = spend.tapInternalKey
    if (spend.kind === 'p2pkh') {
      delete input.witnessUtxo
      const hex = await request(chain.id, settings, `/tx/${coin.txid}/hex`)
      if (!/^[0-9a-f]+$/i.test(hex.trim())) throw new BitcoinError('Unexpected answer from the Bitcoin API.')
      input.nonWitnessUtxo = Buffer.from(hex.trim(), 'hex')
    }
    psbt.addInput(input)
  }
  outputs.forEach((o, i) => psbt.addOutput({ script: outScripts[i], value: Number(o.value) }))
  if (change > 0n) {
    psbt.addOutput({ script: spend.script, value: Number(change) })
    outputs.push({ address: from.address, value: change })
  }

  return {
    psbtHex: psbt.toHex(),
    inputs: chosen.map((_, i) => i),
    networkFee,
    feeRate: rate,
    unsignedTx: unsignedTxHex(psbt),
    outputs
  }
}

function unsignedTxHex(psbt: bitcoin.Psbt): string {
  return (psbt.data.globalMap.unsignedTx as unknown as { toBuffer(): Buffer }).toBuffer().toString('hex')
}

function parsePsbt(text: string, net: bitcoin.Network): bitcoin.Psbt {
  const t = text.trim()
  try {
    if (/^70736274ff[0-9a-f]*$/i.test(t)) return bitcoin.Psbt.fromHex(t, { network: net })
    return bitcoin.Psbt.fromBase64(t, { network: net })
  } catch {
    throw new BitcoinError('The wallet returned something that isn’t a PSBT.', 'BAD_PSBT')
  }
}

/**
 * Check the wallet signed exactly what was planned, finalize it, and return
 * the raw transaction. Throws if anything about the transaction changed.
 */
export function finishBitcoin(chain: Chain, plan: BitcoinPlan, signed: string): { hex: string; txid: string } {
  const net = network(chain)
  const psbt = parsePsbt(signed, net)
  if (unsignedTxHex(psbt) !== plan.unsignedTx) {
    throw new BitcoinError('The wallet changed the transaction before signing it. Nothing was sent.', 'TAMPERED')
  }
  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i]
    if (input.finalScriptWitness || input.finalScriptSig) continue
    try {
      psbt.finalizeInput(i)
    } catch {
      throw new BitcoinError('The wallet didn’t sign every input. Nothing was sent.', 'UNSIGNED')
    }
  }
  let tx: bitcoin.Transaction
  try {
    tx = psbt.extractTransaction()
  } catch (error) {
    throw new BitcoinError(`The signed transaction isn’t valid: ${(error as Error).message}`, 'BAD_TX')
  }
  return { hex: tx.toHex(), txid: tx.getId() }
}

/** Broadcast through the same Esplora API. Returns the txid it reports. */
export async function broadcastBitcoin(chain: Chain, settings: Settings, signed: { hex: string; txid: string }): Promise<string> {
  const answer = (await request(chain.id, settings, '/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: signed.hex })).trim()
  if (answer !== signed.txid) throw new BitcoinError('The network gave back a different transaction id. Check the explorer before trying again.', 'TXID_MISMATCH')
  return answer
}

/** 'confirmed' once in a block; 'pending' while in the mempool or unknown. */
export async function bitcoinStatus(chain: Chain, settings: Settings, txid: string): Promise<'confirmed' | 'pending'> {
  const status = await getJson<{ confirmed?: boolean }>(chain.id, settings, `/tx/${txid}/status`)
  return status.confirmed ? 'confirmed' : 'pending'
}
