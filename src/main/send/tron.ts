import { sha256 } from '@noble/hashes/sha2'
import { recoverAddress } from 'ethers'
import { postJson } from '../backends/http.ts'
import { tronToHex20 } from '../addresses.ts'
import type { Chain, Settings, TokenDef } from '../../shared/types.ts'

/**
 * Tron transfers: TRX, and TRC-20 tokens such as USDT.
 *
 * TronGrid builds the transaction; Goldfelty decodes its raw bytes (the
 * part the signature covers) and checks the sender, recipient, amount and
 * fee limit are exactly what the user asked for before any wallet sees it.
 * After signing, the signature must recover to the sender. The Goldfelty
 * fee is a second, separate transaction, as on EVM networks.
 */

export class TronError extends Error {
  readonly code: string
  constructor(message: string, code = 'TRX_FAILED') {
    super(message)
    this.code = code
  }
}

/** The most energy a TRC-20 transfer may burn, in sun: 50 TRX. */
export const TRC20_FEE_LIMIT = 50_000_000n
const TRANSFER_CONTRACT = 1
const TRIGGER_SMART_CONTRACT = 31
/** transfer(address,uint256) */
const TRANSFER_SELECTOR = 'a9059cbb'

export interface TronTx {
  txID: string
  raw_data: unknown
  raw_data_hex: string
  visible?: boolean
  signature?: string[]
}

/* ---- A minimal protobuf reader, enough for Transaction.raw -------------------------- */

type Field = { no: number; wire: number; value: bigint | Uint8Array }

function readVarint(b: Uint8Array, at: number): [bigint, number] {
  let n = 0n
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = b[at++]
    if (byte === undefined) throw new TronError('Malformed transaction.', 'BAD_TX')
    n |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [n, at]
  }
  throw new TronError('Malformed transaction.', 'BAD_TX')
}

function fields(b: Uint8Array): Field[] {
  const out: Field[] = []
  let at = 0
  while (at < b.length) {
    const [tag, next] = readVarint(b, at)
    at = next
    const no = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const [v, n2] = readVarint(b, at)
      out.push({ no, wire, value: v })
      at = n2
    } else if (wire === 2) {
      const [len, n2] = readVarint(b, at)
      const end = n2 + Number(len)
      if (end > b.length) throw new TronError('Malformed transaction.', 'BAD_TX')
      out.push({ no, wire, value: b.slice(n2, end) })
      at = end
    } else if (wire === 1) {
      out.push({ no, wire, value: b.slice(at, at + 8) })
      at += 8
    } else if (wire === 5) {
      out.push({ no, wire, value: b.slice(at, at + 4) })
      at += 4
    } else {
      throw new TronError('Malformed transaction.', 'BAD_TX')
    }
  }
  return out
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const one = (fs: Field[], no: number): Field | undefined => {
  const all = fs.filter((f) => f.no === no)
  if (all.length > 1) throw new TronError('Unexpected transaction layout.', 'BAD_TX')
  return all[0]
}
const bytesOf = (f: Field | undefined): Uint8Array => (f && f.value instanceof Uint8Array ? f.value : new Uint8Array())
const intOf = (f: Field | undefined): bigint => (f && typeof f.value === 'bigint' ? f.value : 0n)

export interface DecodedTron {
  type: number
  owner: string
  /** TRX: the recipient. TRC-20: the token contract. */
  to: string
  amount: bigint
  data: string
  callValue: bigint
  feeLimit: bigint
  expiration: bigint
}

/** Decode the signed part of a Tron transaction: one contract, and its parameters. */
export function decodeTronRaw(rawHex: string): DecodedTron {
  if (!/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2) throw new TronError('Malformed transaction.', 'BAD_TX')
  const raw = fields(new Uint8Array(Buffer.from(rawHex, 'hex')))
  const contracts = raw.filter((f) => f.no === 11)
  if (contracts.length !== 1) throw new TronError('The transaction does more than one thing. Nothing was sent.', 'BAD_TX')
  const contract = fields(bytesOf(contracts[0]))
  const type = Number(intOf(one(contract, 1)))
  const any = fields(bytesOf(one(contract, 2)))
  const param = fields(bytesOf(one(any, 2)))
  const base = { feeLimit: intOf(one(raw, 18)), expiration: intOf(one(raw, 8)) }
  if (type === TRANSFER_CONTRACT) {
    return { ...base, type, owner: hex(bytesOf(one(param, 1))), to: hex(bytesOf(one(param, 2))), amount: intOf(one(param, 3)), data: '', callValue: 0n }
  }
  if (type === TRIGGER_SMART_CONTRACT) {
    return {
      ...base,
      type,
      owner: hex(bytesOf(one(param, 1))),
      to: hex(bytesOf(one(param, 2))),
      amount: 0n,
      callValue: intOf(one(param, 3)),
      data: hex(bytesOf(one(param, 4)))
    }
  }
  throw new TronError('That isn’t a transfer. Nothing was sent.', 'BAD_TX')
}

/** The 21-byte form (0x41 prefix) addresses take inside a transaction. */
const tron21 = (address: string): string => '41' + tronToHex20(address)

function transferData(to: string, units: bigint): string {
  return TRANSFER_SELECTOR + tronToHex20(to).padStart(64, '0') + units.toString(16).padStart(64, '0')
}

/** Throw unless `tx` is exactly a transfer of `units` of `token` from `from` to `to`. */
export function checkTronTx(tx: TronTx, from: string, to: string, token: TokenDef, units: bigint, now = Date.now()): void {
  if (!tx || typeof tx.txID !== 'string' || typeof tx.raw_data_hex !== 'string') throw new TronError('Unexpected answer from TronGrid.', 'BAD_TX')
  if (hex(sha256(Buffer.from(tx.raw_data_hex, 'hex'))) !== tx.txID.toLowerCase()) throw new TronError('The transaction id doesn’t match its contents.', 'BAD_TX')
  const d = decodeTronRaw(tx.raw_data_hex)
  if (d.owner !== tron21(from)) throw new TronError('The transaction is from a different address. Nothing was sent.', 'TAMPERED')
  if (d.expiration < BigInt(now) || d.expiration > BigInt(now + 24 * 3_600_000)) throw new TronError('The transaction has an odd expiry. Nothing was sent.', 'BAD_TX')
  if (token.address === null) {
    if (d.type !== TRANSFER_CONTRACT || d.to !== tron21(to) || d.amount !== units) {
      throw new TronError('TronGrid built a different transfer than the one you entered. Nothing was sent.', 'TAMPERED')
    }
    return
  }
  if (
    d.type !== TRIGGER_SMART_CONTRACT ||
    d.to !== tron21(token.address) ||
    d.callValue !== 0n ||
    d.data.toLowerCase() !== transferData(to, units) ||
    d.feeLimit > TRC20_FEE_LIMIT
  ) {
    throw new TronError('TronGrid built a different transfer than the one you entered. Nothing was sent.', 'TAMPERED')
  }
}

/** Ask TronGrid for the unsigned transaction, then check it. */
export async function buildTron(chain: Chain, settings: Settings, from: string, to: string, token: TokenDef, units: bigint): Promise<TronTx> {
  let tx: TronTx
  if (token.address === null) {
    const r = await postJson<TronTx & { Error?: string }>(chain.id, settings, '/wallet/createtransaction', {
      owner_address: from,
      to_address: to,
      amount: Number(units),
      visible: true
    })
    if (r.Error) throw new TronError(`TronGrid refused the transfer: ${String(r.Error).slice(0, 200)}`)
    tx = r
  } else {
    const r = await postJson<{ result?: { result?: boolean; message?: string }; transaction?: TronTx }>(chain.id, settings, '/wallet/triggersmartcontract', {
      owner_address: from,
      contract_address: token.address,
      function_selector: 'transfer(address,uint256)',
      parameter: transferData(to, units).slice(8),
      fee_limit: Number(TRC20_FEE_LIMIT),
      call_value: 0,
      visible: true
    })
    if (!r.result?.result || !r.transaction) throw new TronError(`TronGrid refused the transfer${r.result?.message ? `: ${decodeMessage(r.result.message)}` : '.'}`)
    tx = r.transaction
  }
  checkTronTx(tx, from, to, token, units)
  return tx
}

function decodeMessage(m: string): string {
  return (/^[0-9a-f]+$/i.test(m) ? Buffer.from(m, 'hex').toString('utf8') : m).slice(0, 200)
}

/** Check the wallet returned our transaction, signed by `from`, and return it ready to broadcast. */
export function finishTron(planned: TronTx, from: string, signed: unknown): TronTx {
  const s = signed as Partial<TronTx> | null
  if (!s || s.txID !== planned.txID || s.raw_data_hex !== planned.raw_data_hex) {
    throw new TronError('The wallet changed the transaction before signing it. Nothing was sent.', 'TAMPERED')
  }
  const sig = Array.isArray(s.signature) && s.signature.length === 1 ? String(s.signature[0]).replace(/^0x/, '') : ''
  if (!/^[0-9a-f]{130}$/i.test(sig)) throw new TronError('The wallet’s signature isn’t valid. Nothing was sent.', 'BAD_SIGNATURE')
  let signer: string
  try {
    signer = '41' + recoverAddress(`0x${planned.txID}`, `0x${sig}`).slice(2).toLowerCase()
  } catch {
    throw new TronError('The wallet’s signature isn’t valid. Nothing was sent.', 'BAD_SIGNATURE')
  }
  if (signer !== tron21(from)) throw new TronError('The transaction was signed by a different account. Nothing was sent.', 'BAD_SIGNATURE')
  // Our own copy of the transaction, with only the signature taken from the wallet.
  return { txID: planned.txID, raw_data: planned.raw_data, raw_data_hex: planned.raw_data_hex, visible: planned.visible, signature: [sig] }
}

export async function broadcastTron(chain: Chain, settings: Settings, tx: TronTx): Promise<string> {
  const r = await postJson<{ result?: boolean; txid?: string; code?: string; message?: string }>(chain.id, settings, '/wallet/broadcasttransaction', tx)
  if (!r.result) throw new TronError(`The network refused it: ${decodeMessage(r.message ?? r.code ?? 'unknown error')}`, 'REJECTED')
  return tx.txID
}

/** A rough upper bound on the network fee, in sun, assuming no staked energy or bandwidth. */
export async function estimateTronFee(chain: Chain, settings: Settings, from: string, to: string, token: TokenDef, units: bigint): Promise<bigint> {
  const BANDWIDTH = 350n * 1_000n
  if (token.address === null) {
    const account = await postJson<Record<string, unknown>>(chain.id, settings, '/wallet/getaccount', { address: to, visible: true })
    // Sending TRX to an address that has never been used activates it, which costs 1 TRX more.
    return Object.keys(account).length === 0 ? BANDWIDTH + 1_100_000n : BANDWIDTH
  }
  const [sim, params] = await Promise.all([
    postJson<{ energy_used?: number }>(chain.id, settings, '/wallet/triggerconstantcontract', {
      owner_address: from,
      contract_address: token.address,
      function_selector: 'transfer(address,uint256)',
      parameter: transferData(to, units).slice(8),
      visible: true
    }),
    postJson<{ chainParameter?: Array<{ key: string; value?: number }> }>(chain.id, settings, '/wallet/getchainparameters', {})
  ])
  const energyFee = BigInt(params.chainParameter?.find((p) => p.key === 'getEnergyFee')?.value ?? 210)
  const energy = BigInt(sim.energy_used ?? 65_000)
  const estimate = energy * energyFee + BANDWIDTH
  return estimate > TRC20_FEE_LIMIT ? TRC20_FEE_LIMIT : estimate
}

export async function tronStatus(chain: Chain, settings: Settings, txid: string): Promise<'confirmed' | 'failed' | 'pending'> {
  const info = await postJson<{ blockNumber?: number; result?: string; receipt?: { result?: string } }>(chain.id, settings, '/wallet/gettransactioninfobyid', { value: txid })
  if (!info.blockNumber) return 'pending'
  if (info.result === 'FAILED') return 'failed'
  if (info.receipt?.result && info.receipt.result !== 'SUCCESS') return 'failed'
  return 'confirmed'
}
