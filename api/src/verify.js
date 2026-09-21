import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'

/**
 * Recovering the signer of a personal_sign signature.
 *
 * ethers would do this in one call, but it is a large dependency to drag into
 * a Worker for one function. These two noble packages are a few kilobytes and
 * are the same primitives ethers uses underneath.
 */

const PREFIX = '\x19Ethereum Signed Message:\n'

function toBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('bad hex')
    out[i] = byte
  }
  return out
}

function toHex(bytes) {
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** EIP-55 mixed-case checksum, so addresses compare and display consistently. */
export function checksumAddress(address) {
  const lower = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error('not an address')
  const hash = toHex(keccak_256(new TextEncoder().encode(lower))).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i]
  }
  return out
}

export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

/** The digest a wallet actually signs for personal_sign / eth_sign. */
function messageHash(message) {
  const body = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(PREFIX + body.length)
  const joined = new Uint8Array(prefix.length + body.length)
  joined.set(prefix, 0)
  joined.set(body, prefix.length)
  return keccak_256(joined)
}

/**
 * Recover the address that produced `signature` over `message`.
 * Throws if the signature is malformed; never guesses.
 */
export function recoverAddress(message, signature) {
  const bytes = toBytes(signature)
  if (bytes.length !== 65) throw new Error('signature must be 65 bytes')

  const r = bytes.slice(0, 32)
  const s = bytes.slice(32, 64)
  let v = bytes[64]
  // Wallets send 27/28; some send 0/1. EIP-155 chain-encoded v never appears
  // for personal_sign, so anything else is malformed.
  if (v === 27 || v === 28) v -= 27
  if (v !== 0 && v !== 1) throw new Error('bad recovery id')

  const sig = secp256k1.Signature.fromCompact(new Uint8Array([...r, ...s])).addRecoveryBit(v)

  // Reject the upper half of the curve order. Without this every signature has
  // a second equally valid form, and anything keyed on the bytes can be
  // bypassed by submitting the other one.
  if (sig.hasHighS()) throw new Error('non-canonical signature')

  const point = sig.recoverPublicKey(messageHash(message))
  const pub = point.toRawBytes(false).slice(1)
  return checksumAddress(toHex(keccak_256(pub)).slice(-40))
}
