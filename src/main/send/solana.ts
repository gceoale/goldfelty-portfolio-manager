import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { jsonRpc } from '../backends/http.ts'
import { base58Decode, base58Encode } from '../addresses.ts'
import type { Chain, Settings, TokenDef } from '../../shared/types.ts'

/**
 * Solana transfers, built here byte by byte (legacy message format) so that
 * what the wallet signs can be compared exactly with what was asked for.
 *
 * SOL moves with a System Program transfer; SPL tokens (USDC, USDT) with
 * the Token Program's transferChecked, between associated token accounts.
 * The Goldfelty fee is a second transfer instruction in the same
 * transaction: one approval, one signature, and it lands or fails with the
 * user's transfer.
 */

export class SolanaError extends Error {
  readonly code: string
  constructor(message: string, code = 'SOL_FAILED') {
    super(message)
    this.code = code
  }
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/** Lamports a new, empty system account must hold to exist. */
export const RENT_EXEMPT_MIN = 890_880n
/** Lamports to open a token account. */
export const TOKEN_ACCOUNT_RENT = 2_039_280n
const SIGNATURE_FEE = 5_000n
/** Compute-unit ceilings, with headroom over what these instructions use. */
const CU_NATIVE = 5_000
const CU_TOKEN = 50_000
const CU_OPEN_ACCOUNT = 50_000
/** A modest priority fee so transfers land when the network is busy: 0.0002 SOL at most. */
const MICRO_LAMPORTS_PER_CU = 2_000_000n

const key = (address: string): Uint8Array => {
  const bytes = base58Decode(address)
  if (!bytes || bytes.length !== 32) throw new SolanaError('That isn’t a Solana address.', 'BAD_ADDRESS')
  return bytes
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, n, true)
  return out
}
function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** Solana's "compact-u16" length prefix. */
function shortvec(n: number): Uint8Array {
  const out: number[] = []
  let rest = n
  for (;;) {
    let byte = rest & 0x7f
    rest >>= 7
    if (rest) byte |= 0x80
    out.push(byte)
    if (!rest) break
  }
  return Uint8Array.from(out)
}
function readShortvec(bytes: Uint8Array, at: number): [number, number] {
  let n = 0
  for (let i = 0; i < 3; i++) {
    const byte = bytes[at + i]
    if (byte === undefined) throw new SolanaError('Malformed transaction.', 'BAD_TX')
    n |= (byte & 0x7f) << (7 * i)
    if (!(byte & 0x80)) return [n, at + i + 1]
  }
  throw new SolanaError('Malformed transaction.', 'BAD_TX')
}

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(bytes)
    return true
  } catch {
    return false
  }
}

/** A program-derived address: the first bump, from 255 down, whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = key(programId)
  const marker = new TextEncoder().encode('ProgramDerivedAddress')
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concat(...seeds, Uint8Array.of(bump), program, marker))
    if (!onCurve(hash)) return base58Encode(hash)
  }
  throw new SolanaError('No program address found.')
}

/** The associated token account `owner` holds `mint` in. */
export function associatedTokenAddress(owner: string, mint: string): string {
  return findProgramAddress([key(owner), key(TOKEN_PROGRAM), key(mint)], ATA_PROGRAM)
}

interface AccountMeta {
  pubkey: string
  signer: boolean
  writable: boolean
}
interface Instruction {
  programId: string
  accounts: AccountMeta[]
  data: Uint8Array
}

const ix = {
  computeLimit: (units: number): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concat(Uint8Array.of(2), u32(units)) }),
  computePrice: (micro: bigint): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concat(Uint8Array.of(3), u64(micro)) }),
  transfer: (from: string, to: string, lamports: bigint): Instruction => ({
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, signer: true, writable: true },
      { pubkey: to, signer: false, writable: true }
    ],
    data: concat(u32(2), u64(lamports))
  }),
  createAta: (payer: string, ata: string, owner: string, mint: string): Instruction => ({
    programId: ATA_PROGRAM,
    accounts: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: ata, signer: false, writable: true },
      { pubkey: owner, signer: false, writable: false },
      { pubkey: mint, signer: false, writable: false },
      { pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
      { pubkey: TOKEN_PROGRAM, signer: false, writable: false }
    ],
    data: Uint8Array.of(1) // CreateIdempotent
  }),
  transferChecked: (source: string, mint: string, dest: string, owner: string, amount: bigint, decimals: number): Instruction => ({
    programId: TOKEN_PROGRAM,
    accounts: [
      { pubkey: source, signer: false, writable: true },
      { pubkey: mint, signer: false, writable: false },
      { pubkey: dest, signer: false, writable: true },
      { pubkey: owner, signer: true, writable: false }
    ],
    data: concat(Uint8Array.of(12), u64(amount), Uint8Array.of(decimals))
  })
}

/** Serialize a legacy message with `payer` as the fee payer. */
export function compileMessage(payer: string, instructions: Instruction[], blockhash: string): Uint8Array {
  const metas = new Map<string, { signer: boolean; writable: boolean }>()
  metas.set(payer, { signer: true, writable: true })
  for (const i of instructions) {
    for (const a of i.accounts) {
      const m = metas.get(a.pubkey) ?? { signer: false, writable: false }
      metas.set(a.pubkey, { signer: m.signer || a.signer, writable: m.writable || a.writable })
    }
    if (!metas.has(i.programId)) metas.set(i.programId, { signer: false, writable: false })
  }
  const all = [...metas.entries()]
  const order = (m: { signer: boolean; writable: boolean }): number => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3)
  // Stable sort keeps the payer first among the writable signers.
  const keys = all.map(([k, m], i) => ({ k, m, i })).sort((a, b) => order(a.m) - order(b.m) || a.i - b.i)
  const index = new Map(keys.map((x, i) => [x.k, i]))
  const header = Uint8Array.of(
    keys.filter((x) => x.m.signer).length,
    keys.filter((x) => x.m.signer && !x.m.writable).length,
    keys.filter((x) => !x.m.signer && !x.m.writable).length
  )
  const hash = key(blockhash)
  const compiled = instructions.map((i) =>
    concat(Uint8Array.of(index.get(i.programId)!), shortvec(i.accounts.length), Uint8Array.from(i.accounts.map((a) => index.get(a.pubkey)!)), shortvec(i.data.length), i.data)
  )
  return concat(header, shortvec(keys.length), ...keys.map((x) => key(x.k)), hash, shortvec(compiled.length), ...compiled)
}

export interface SolanaPlan {
  /** The message the wallet must sign, unchanged. */
  message: Uint8Array
  /** The unsigned transaction, base64, as handed to the wallet. */
  txBase64: string
  /** Lamports for signatures, priority and any account the transfer opens. */
  networkFee: bigint
  /** Whether the Goldfelty fee made it in; it is left out when it can't be paid without costing the user extra. */
  feeIncluded: boolean
  warnings: string[]
}

interface AccountInfo {
  value: { lamports: number } | null
}

async function exists(chain: Chain, settings: Settings, address: string): Promise<{ exists: boolean; lamports: bigint }> {
  const r = await jsonRpc<AccountInfo>(chain.id, settings, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }])
  return r.value ? { exists: true, lamports: BigInt(r.value.lamports) } : { exists: false, lamports: 0n }
}

export async function planSolana(
  chain: Chain,
  settings: Settings,
  from: string,
  to: string,
  token: TokenDef,
  units: bigint,
  fee: { recipient: string; units: bigint } | null
): Promise<SolanaPlan> {
  const warnings: string[] = []
  const instructions: Instruction[] = []
  let computeUnits = token.address === null ? CU_NATIVE : CU_TOKEN
  let networkFee = SIGNATURE_FEE
  let feeIncluded = false

  if (token.address === null) {
    const dest = await exists(chain, settings, to)
    if (!dest.exists && units < RENT_EXEMPT_MIN) {
      throw new SolanaError('That address has never been used, and Solana needs at least 0.00089088 SOL sent to open it.', 'BELOW_RENT')
    }
    instructions.push(ix.transfer(from, to, units))
    if (fee) {
      const feeAccount = await exists(chain, settings, fee.recipient)
      if (feeAccount.exists || fee.units >= RENT_EXEMPT_MIN) {
        instructions.push(ix.transfer(from, fee.recipient, fee.units))
        feeIncluded = true
      }
    }
  } else {
    const mint = token.address
    const source = associatedTokenAddress(from, mint)
    const dest = associatedTokenAddress(to, mint)
    const balance = await jsonRpc<{ value: { amount: string } }>(chain.id, settings, 'getTokenAccountBalance', [source, { commitment: 'confirmed' }]).catch(() => null)
    const held = balance ? BigInt(balance.value.amount) : 0n
    if (held < units + (fee?.units ?? 0n)) {
      throw new SolanaError(`This wallet’s main ${token.symbol} account doesn’t hold enough to cover this and the fee.`, 'INSUFFICIENT')
    }
    if (!(await exists(chain, settings, dest)).exists) {
      instructions.push(ix.createAta(from, dest, to, mint))
      networkFee += TOKEN_ACCOUNT_RENT
      computeUnits += CU_OPEN_ACCOUNT
      warnings.push(`The recipient has no ${token.symbol} account yet. Opening one costs about 0.002 SOL, once, paid by you.`)
    }
    instructions.push(ix.transferChecked(source, mint, dest, from, units, token.decimals))
    if (fee) {
      const feeAccount = associatedTokenAddress(fee.recipient, mint)
      // Never make the user pay to open Goldfelty's own account.
      if ((await exists(chain, settings, feeAccount)).exists) {
        instructions.push(ix.transferChecked(source, mint, feeAccount, from, fee.units, token.decimals))
        feeIncluded = true
      }
    }
  }

  networkFee += (BigInt(computeUnits) * MICRO_LAMPORTS_PER_CU) / 1_000_000n
  instructions.unshift(ix.computeLimit(computeUnits), ix.computePrice(MICRO_LAMPORTS_PER_CU))
  const { value } = await jsonRpc<{ value: { blockhash: string } }>(chain.id, settings, 'getLatestBlockhash', [{ commitment: 'finalized' }])
  const message = compileMessage(from, instructions, value.blockhash)
  const tx = concat(shortvec(1), new Uint8Array(64), message)
  return { message, txBase64: Buffer.from(tx).toString('base64'), networkFee, feeIncluded, warnings }
}

/**
 * Check the wallet signed exactly the planned message, with the sender's
 * key, and return the signed transaction and its signature (the tx id).
 */
export function finishSolana(plan: SolanaPlan, from: string, signedBase64: string): { tx: string; signature: string } {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(signedBase64, 'base64'))
  } catch {
    throw new SolanaError('The wallet returned something that isn’t a transaction.', 'BAD_TX')
  }
  const [count, at] = readShortvec(bytes, 0)
  if (count !== 1) throw new SolanaError('The wallet changed who signs the transaction. Nothing was sent.', 'TAMPERED')
  const signature = bytes.slice(at, at + 64)
  const message = bytes.slice(at + 64)
  if (message.length !== plan.message.length || !message.every((b, i) => b === plan.message[i])) {
    throw new SolanaError('The wallet changed the transaction before signing it. Nothing was sent.', 'TAMPERED')
  }
  if (!ed25519.verify(signature, message, key(from))) {
    throw new SolanaError('The wallet’s signature doesn’t check out. Nothing was sent.', 'BAD_SIGNATURE')
  }
  return { tx: Buffer.from(bytes).toString('base64'), signature: base58Encode(signature) }
}

export async function broadcastSolana(chain: Chain, settings: Settings, signed: { tx: string; signature: string }): Promise<string> {
  const answer = await jsonRpc<string>(chain.id, settings, 'sendTransaction', [signed.tx, { encoding: 'base64', preflightCommitment: 'confirmed' }])
  if (answer !== signed.signature) throw new SolanaError('The network gave back a different transaction id. Check the explorer before trying again.', 'TXID_MISMATCH')
  return answer
}

export async function solanaStatus(chain: Chain, settings: Settings, signature: string): Promise<'confirmed' | 'failed' | 'pending'> {
  const r = await jsonRpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>(chain.id, settings, 'getSignatureStatuses', [
    [signature],
    { searchTransactionHistory: true }
  ])
  const s = r.value?.[0]
  if (!s) return 'pending'
  if (s.err) return 'failed'
  return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending'
}
