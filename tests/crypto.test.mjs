import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveKey,
  deriveKeyFor,
  encryptWithKey,
  decryptWithKey,
  newSalt,
  scorePassword,
  WrongPasswordError,
  CorruptVaultError,
  KDF_PARAMS
} from '../src/main/crypto.ts'

// Onboarding derives a key per attempt, so keep the test params cheap.
const FAST = { N: 1024, r: 8, p: 1, keyLength: 32 }

async function blobFor(password, plaintext) {
  const salt = newSalt()
  const kdf = { name: 'scrypt', ...FAST, salt: salt.toString('base64') }
  const key = await deriveKey(password, salt, FAST)
  return { blob: encryptWithKey(key, plaintext, kdf), kdf }
}

test('round-trips a payload through encrypt and decrypt', async () => {
  const secret = 'gravity drift ocean ...'
  const { blob, kdf } = await blobFor('correct horse battery staple', secret)
  const key = await deriveKeyFor('correct horse battery staple', kdf)
  assert.equal(decryptWithKey(key, blob), secret)
})

test('rejects the wrong password without revealing anything', async () => {
  const { blob, kdf } = await blobFor('right-password-1!', 'seed words here')
  const wrongKey = await deriveKeyFor('wrong-password-1!', kdf)
  assert.throws(() => decryptWithKey(wrongKey, blob), WrongPasswordError)
})

test('detects a tampered ciphertext as corruption, not a bad password', async () => {
  const { blob, kdf } = await blobFor('right-password-1!', 'seed words here')
  const bytes = Buffer.from(blob.ciphertext, 'base64')
  bytes[0] ^= 0xff
  const tampered = { ...blob, ciphertext: bytes.toString('base64') }
  const key = await deriveKeyFor('right-password-1!', kdf)
  assert.throws(() => decryptWithKey(key, tampered), CorruptVaultError)
})

test('derives a distinct key for each salt', async () => {
  const a = await deriveKey('same-password', newSalt(), FAST)
  const b = await deriveKey('same-password', newSalt(), FAST)
  assert.notEqual(a.toString('hex'), b.toString('hex'))
})

test('normalises unicode so a password types the same on every platform', async () => {
  // "é" as one codepoint vs. e + combining accent.
  const salt = newSalt()
  const composed = await deriveKey('café-Passw0rd!', salt, FAST)
  const decomposed = await deriveKey('café-Passw0rd!', salt, FAST)
  assert.equal(composed.toString('hex'), decomposed.toString('hex'))
})

test('scores passwords against the onboarding bar', () => {
  assert.equal(scorePassword('password').score, 0)
  assert.equal(scorePassword('short1!A').score, 0)
  assert.ok(scorePassword('Tr0ubad0ur&Bits').score >= 2)
  assert.equal(scorePassword('Tr0ubad0ur&Bits-Are-Long').label, 'Excellent')
  assert.ok(scorePassword('alllowercase').problems.length > 0)
})

test('ships production KDF parameters that are actually expensive', () => {
  assert.ok(KDF_PARAMS.N >= 1 << 16, 'scrypt N must stay high enough to matter')
  assert.equal(KDF_PARAMS.keyLength, 32)
})
