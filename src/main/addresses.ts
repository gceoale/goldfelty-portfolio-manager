import { getAddress, isAddress as isEvmAddress } from 'ethers'
import * as bitcoin from 'bitcoinjs-lib'
import ecc from '@bitcoinerlab/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import type { ChainFamily } from '../shared/types.ts'

/**
 * Addresses on every chain Goldfelty knows, and how to tell them apart.
 *
 * Every format here except Solana's carries a checksum, so a mistyped
 * character is refused rather than accepted as somebody else's address.
 * Solana addresses have none; the UI says so where that matters.
 */

bitcoin.initEccLib(ecc)

export const UTXO_NETWORKS: Record<string, bitcoin.Network> = {
  bitcoin: bitcoin.networks.bitcoin,
  litecoin: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
  },
  dogecoin: {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    // Dogecoin has no segwit; the prefix is never matched.
    bech32: 'doge',
    bip32: { public: 0x02facafd, private: 0x02fac398 },
    pubKeyHash: 0x1e,
    scriptHash: 0x16,
    wif: 0x9e
  }
}

/** Chain ids for the UTXO chains, matching src/shared/chains.ts. */
export const UTXO_CHAIN_IDS: Record<string, number> = { bitcoin: -1, litecoin: -2, dogecoin: -3 }

export class AddressError extends Error {
  code = 'BAD_ADDRESS'
}

const B58_BITCOIN = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_RIPPLE = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'

export function base58Decode(text: string, alphabet = B58_BITCOIN): Uint8Array | null {
  if (!text || text.length > 128) return null
  let num = 0n
  for (const ch of text) {
    const v = alphabet.indexOf(ch)
    if (v < 0) return null
    num = num * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num >>= 8n
  }
  for (const ch of text) {
    if (ch !== alphabet[0]) break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

export function base58Encode(bytes: Uint8Array, alphabet = B58_BITCOIN): string {
  let num = 0n
  for (const b of bytes) num = (num << 8n) | BigInt(b)
  let out = ''
  while (num > 0n) {
    out = alphabet[Number(num % 58n)] + out
    num /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = alphabet[0] + out
  }
  return out
}

function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/** Decode base58check and return the payload, or null if the checksum fails. */
export function base58CheckDecode(text: string, alphabet = B58_BITCOIN): Uint8Array | null {
  const raw = base58Decode(text, alphabet)
  if (!raw || raw.length < 5) return null
  const payload = raw.slice(0, -4)
  const check = sha256d(payload).slice(0, 4)
  for (let i = 0; i < 4; i++) if (raw[raw.length - 4 + i] !== check[i]) return null
  return payload
}

export function base58CheckEncode(payload: Uint8Array, alphabet = B58_BITCOIN): string {
  const check = sha256d(payload).slice(0, 4)
  const out = new Uint8Array(payload.length + 4)
  out.set(payload)
  out.set(check, payload.length)
  return base58Encode(out, alphabet)
}

export function isUtxoAddress(address: string, chainKey: string): boolean {
  const network = UTXO_NETWORKS[chainKey]
  if (!network) return false
  try {
    bitcoin.address.toOutputScript(address, network)
    return true
  } catch {
    return false
  }
}

export function isSolanaAddress(address: string): boolean {
  const raw = base58Decode(address)
  return !!raw && raw.length === 32 && address.length >= 32 && address.length <= 44
}

export function isTronAddress(address: string): boolean {
  const payload = base58CheckDecode(address)
  return !!payload && payload.length === 21 && payload[0] === 0x41
}

/** Tron base58 address to the 20-byte hex form contracts use. */
export function tronToHex20(address: string): string {
  const payload = base58CheckDecode(address)
  if (!payload || payload.length !== 21 || payload[0] !== 0x41) throw new AddressError('Not a Tron address.')
  return Buffer.from(payload.slice(1)).toString('hex')
}

export function isXrpAddress(address: string): boolean {
  if (!address.startsWith('r')) return false
  const payload = base58CheckDecode(address, B58_RIPPLE)
  return !!payload && payload.length === 21 && payload[0] === 0x00
}

export interface DetectedAddress {
  family: ChainFamily
  /** The chains this address lives on: one for UTXO chains, the family's chains otherwise. */
  chainIds: number[] | null
  address: string
}

/**
 * Work out which chain an address belongs to from its format alone. EVM
 * addresses come back checksummed; everything else exactly as given, since
 * base58 and bech32 are case-sensitive or case-normalised by definition.
 */
export function detectAddress(raw: string): DetectedAddress {
  const text = String(raw ?? '').trim()
  if (!text) throw new AddressError('Paste an address.')
  if (text.startsWith('0x') || text.startsWith('0X')) {
    if (!isEvmAddress(text)) throw new AddressError('That isn’t a valid address. Copy it from the wallet rather than typing it.')
    return { family: 'evm', chainIds: null, address: getAddress(text) }
  }
  // '3…' is both a Bitcoin and an old Litecoin P2SH form; Bitcoin is tried first.
  for (const key of ['bitcoin', 'litecoin', 'dogecoin']) {
    const candidate = /^(bc1|ltc1)/i.test(text) ? text.toLowerCase() : text
    if (isUtxoAddress(candidate, key)) return { family: 'utxo', chainIds: [UTXO_CHAIN_IDS[key]], address: candidate }
  }
  if (isTronAddress(text)) return { family: 'tron', chainIds: null, address: text }
  if (isXrpAddress(text)) return { family: 'xrp', chainIds: null, address: text }
  if (isSolanaAddress(text)) return { family: 'solana', chainIds: null, address: text }
  throw new AddressError('Goldfelty doesn’t recognise that address. Copy it from the wallet rather than typing it.')
}

/** Validate an address for a given chain and return its canonical form. */
export function validateFor(family: ChainFamily, chainKey: string, raw: string): string {
  const text = String(raw ?? '').trim()
  switch (family) {
    case 'evm':
      if (!isEvmAddress(text)) break
      return getAddress(text)
    case 'utxo': {
      const candidate = /^(bc1|ltc1)/i.test(text) ? text.toLowerCase() : text
      if (isUtxoAddress(candidate, chainKey)) return candidate
      break
    }
    case 'solana':
      if (isSolanaAddress(text)) return text
      break
    case 'tron':
      if (isTronAddress(text)) return text
      break
    case 'xrp':
      if (isXrpAddress(text)) return text
      break
  }
  throw new AddressError('That isn’t a valid address on this network.')
}

/** Address equality, case-insensitive only where the format is. */
export function sameAddress(family: ChainFamily, a: string, b: string): boolean {
  if (family === 'evm' || (family === 'utxo' && /^(bc1|ltc1)/i.test(a))) return a.toLowerCase() === b.toLowerCase()
  return a === b
}
