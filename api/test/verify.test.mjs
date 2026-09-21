import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import { recoverAddress, checksumAddress, isAddress } from '../src/verify.js'

// ethers is a dev-only cross-check here: it signs, our own code recovers.
// If the two ever disagree, this implementation is wrong.

test('recovers the address ethers signed with', async () => {
  const wallet = Wallet.createRandom()
  const message = 'Goldfelty account registration\nusername: alice'
  const signature = await wallet.signMessage(message)
  assert.equal(recoverAddress(message, signature), wallet.address)
})

test('recovers correctly across many random keys', async () => {
  for (let i = 0; i < 25; i++) {
    const wallet = Wallet.createRandom()
    const message = `message number ${i}`
    assert.equal(recoverAddress(message, await wallet.signMessage(message)), wallet.address)
  }
})

test('handles unicode and long messages', async () => {
  const wallet = Wallet.createRandom()
  for (const message of ['héllo wörld ✓', 'x'.repeat(5000), '', '\n\n']) {
    assert.equal(recoverAddress(message, await wallet.signMessage(message)), wallet.address)
  }
})

test('a different message recovers a different address', async () => {
  const wallet = Wallet.createRandom()
  const signature = await wallet.signMessage('the real message')
  assert.notEqual(recoverAddress('a forged message', signature), wallet.address)
})

test('rejects malformed signatures instead of guessing', () => {
  for (const bad of ['0x', '0xabcd', 'not hex', '0x' + '00'.repeat(64), '0x' + '11'.repeat(66)]) {
    assert.throws(() => recoverAddress('hi', bad), `${bad} should throw`)
  }
})

test('rejects a bad recovery id', () => {
  assert.throws(() => recoverAddress('hi', '0x' + '11'.repeat(64) + '09'), /recovery id/)
})

test('checksums addresses to EIP-55', () => {
  // The canonical example from the EIP.
  assert.equal(
    checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  )
  assert.equal(
    checksumAddress('0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359'),
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
  )
})

test('validates address shape', () => {
  assert.equal(isAddress('0x' + 'a'.repeat(40)), true)
  assert.equal(isAddress('0x' + 'a'.repeat(39)), false)
  assert.equal(isAddress('nope'), false)
})
