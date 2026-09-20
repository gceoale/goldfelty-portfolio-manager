import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAddress, isAddress, Interface } from 'ethers'
import {
  predictAccountAddress,
  accountSalt,
  proxyInitCode,
  encodeNativeTransfer,
  encodeTokenTransfer,
  actionDigest,
  FACTORY_ADDRESS,
  ACCOUNT_IMPLEMENTATION,
  erc20Interface
} from '../src/main/smartAccount.ts'

const OWNER_A = '0x1111111111111111111111111111111111111111'
const OWNER_B = '0x2222222222222222222222222222222222222222'

test('predicts a valid, checksummed account address offline', () => {
  const address = predictAccountAddress(OWNER_A, 0n)
  assert.ok(isAddress(address))
  assert.equal(address, getAddress(address))
})

test('is deterministic: the same owner and salt always give the same address', () => {
  assert.equal(predictAccountAddress(OWNER_A, 7n), predictAccountAddress(OWNER_A, 7n))
})

test('gives every derivation index its own address', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i++) seen.add(predictAccountAddress(OWNER_A, BigInt(i)))
  assert.equal(seen.size, 64, 'indices must not collide')
})

test('binds the owner into the salt so addresses cannot be front-run', () => {
  assert.notEqual(accountSalt(OWNER_A, 0n), accountSalt(OWNER_B, 0n))
  assert.notEqual(predictAccountAddress(OWNER_A, 0n), predictAccountAddress(OWNER_B, 0n))
})

test('builds ERC-1167 minimal-proxy init code carrying the implementation', () => {
  const code = proxyInitCode()
  assert.ok(code.startsWith('0x3d602d80600a3d3981f3363d3d373d3d3d363d73'))
  assert.ok(code.toLowerCase().includes(ACCOUNT_IMPLEMENTATION.slice(2).toLowerCase()))
  assert.ok(code.endsWith('5af43d82803e903d91602b57fd5bf3'))
  // 10 bytes of creation code + 45 bytes of runtime.
  assert.equal((code.length - 2) / 2, 55, 'minimal proxy init code is 55 bytes')
})

test('the factory address is a real checksummed address', () => {
  assert.equal(FACTORY_ADDRESS, getAddress(FACTORY_ADDRESS))
})

test('wraps a native transfer as an account execute call', () => {
  const data = encodeNativeTransfer('0x3333333333333333333333333333333333333333', 1_000_000_000n)
  const iface = new Interface(['function execute(address dest, uint256 value, bytes calldata func)'])
  const decoded = iface.decodeFunctionData('execute', data)
  assert.equal(decoded[0], getAddress('0x3333333333333333333333333333333333333333'))
  assert.equal(decoded[1], 1_000_000_000n)
  assert.equal(decoded[2], '0x')
})

test('wraps an ERC-20 transfer so the account is the sender, not the owner', () => {
  const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const recipient = '0x4444444444444444444444444444444444444444'
  const data = encodeTokenTransfer(token, recipient, 2_500_000n)
  const iface = new Interface(['function execute(address dest, uint256 value, bytes calldata func)'])
  const [dest, value, inner] = iface.decodeFunctionData('execute', data)
  assert.equal(dest, getAddress(token), 'the call must target the token contract')
  assert.equal(value, 0n, 'an ERC-20 transfer carries no native value')
  const transfer = erc20Interface.decodeFunctionData('transfer', inner)
  assert.equal(transfer[0], getAddress(recipient))
  assert.equal(transfer[1], 2_500_000n)
})

test('separates action digests by chain and nonce so a signature cannot be replayed', () => {
  const account = predictAccountAddress(OWNER_A, 0n)
  const calldata = encodeNativeTransfer(OWNER_B, 1n)
  const onMainnet = actionDigest(account, 1, 0n, calldata)
  assert.notEqual(onMainnet, actionDigest(account, 8453, 0n, calldata), 'cross-chain replay')
  assert.notEqual(onMainnet, actionDigest(account, 1, 1n, calldata), 'same-chain replay')
})
