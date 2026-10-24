import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Interface } from 'ethers'
import { feeUnits, clampFeeBps, formatFeeRate, MAX_FEE_BPS, DEFAULT_FEE_BPS, FEE_CHAIN_IDS } from '../src/shared/fees.ts'
import { TOKENS, tokenKey } from '../src/shared/chains.ts'

const OWNER = '0x8617E340B3D01FA5F11F306F4090FD50E238070D'
const USER = '0x52908400098527886E0F7030069857D2E4169EE7'
const FRIEND = '0xde709f2102306220921060314715629080e2fb77'

// The rate file is served locally; set before the modules read it.
let served = { feeBps: 50 }
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url.startsWith('/fees.json')) return res.end(typeof served === 'string' ? served : JSON.stringify(served))
  if (req.url.startsWith('/simple/price')) return res.end('{}')
  // Anything else is JSON-RPC: answer "not found" so nothing waits on the network.
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const one = (m) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_blockNumber' ? '0x1' : null })
    const parsed = JSON.parse(body || '{}')
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GOLDFELTY_FEE_CONFIG_URL = `http://127.0.0.1:${server.address().port}/fees.json`
const fees = await import('../src/main/fees.ts')
const { executeTransfer } = await import('../src/main/transfers.ts')
const { Store } = await import('../src/main/store.ts')
const { registerConnectionAccounts } = await import('../src/main/wallets.ts')
const { DEFAULT_SETTINGS } = await import('../src/main/settings.ts')
const { disposeProviders } = await import('../src/main/rpc.ts')

const local = `http://127.0.0.1:${server.address().port}`
const SETTINGS = { ...DEFAULT_SETTINGS, priceProviderUrl: local, customRpc: { 1: local } }

test.after(() => {
  disposeProviders()
  server.closeAllConnections()
  server.close()
})

test('the rate is clamped to the 0% to 10% the Terms allow', () => {
  assert.equal(MAX_FEE_BPS, 1000)
  assert.equal(DEFAULT_FEE_BPS, 50)
  assert.equal(clampFeeBps(5000), 1000)
  assert.equal(clampFeeBps(-5), 0)
  assert.equal(clampFeeBps('nope'), 0)
  assert.equal(formatFeeRate(50), '0.5%')
  assert.equal(formatFeeRate(1000), '10%')
})

test('the fee rounds down, so it never exceeds the stated rate', () => {
  assert.equal(feeUnits(1_000_000n, 50), 5_000n) // 1 USDC -> 0.005
  assert.equal(feeUnits(199n, 50), 0n)
  assert.equal(feeUnits(10n ** 18n, 1000), 10n ** 17n)
})

test('no fee address in the build means no fee, and no request to the site', async () => {
  fees.setFeeRecipientForTests(null)
  assert.equal(await fees.currentFeeBps(), 0)
  const eth = TOKENS.find((t) => t.key === tokenKey(1, null))
  assert.equal(fees.planFee(eth, 10n ** 18n, USER, 50), null)
})

test('reads the rate from the site, clamps it, and falls back when it is unreachable', async () => {
  fees.setFeeRecipientForTests(OWNER)
  served = { feeBps: 75 }
  assert.equal(await fees.currentFeeBps(0), 75)
  served = { feeBps: 99999 }
  assert.equal(await fees.currentFeeBps(2 * 3600_000), 1000, 'a typo on the site cannot exceed 10%')
  served = 'not json'
  assert.equal(await fees.currentFeeBps(4 * 3600_000), 1000, 'a broken file keeps the last good rate')
  fees.setFeeRecipientForTests(OWNER)
  served = 'not json'
  assert.equal(await fees.currentFeeBps(0), DEFAULT_FEE_BPS, 'with nothing known, the default applies')
})

test('only charged on networks the fee wallet supports, and never on the owner', () => {
  fees.setFeeRecipientForTests(OWNER)
  const sepolia = TOKENS.find((t) => t.chainId === 11155111)
  assert.equal(FEE_CHAIN_IDS.has(11155111), false)
  assert.equal(fees.planFee(sepolia, 10n ** 18n, USER, 50), null)
  const eth = TOKENS.find((t) => t.key === tokenKey(1, null))
  assert.equal(fees.planFee(eth, 10n ** 18n, OWNER, 50), null)
  assert.equal(fees.planFee(eth, 10n ** 18n, USER, 50).units, 5n * 10n ** 15n)
})

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-fees-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir)
  store.open(randomBytes(32))
  const [wallet] = registerConnectionAccounts(
    store,
    { id: 'frame', kind: 'frame', name: 'Frame', providerId: 'frame-desktop', rdns: null, icon: null, accounts: [USER], chainIds: [1], connectedAt: 1, active: true, topic: null },
    [1]
  )
  return { store, wallet }
}

const erc20 = new Interface(['function transfer(address,uint256)'])

test('sends the transfer first, then the fee as its own transaction to the owner', async (t) => {
  fees.setFeeRecipientForTests(OWNER)
  served = { feeBps: 50 }
  const { store, wallet } = setup(t)
  const usdc = TOKENS.find((x) => x.chainId === 1 && x.symbol === 'USDC')
  const sent = []
  const sender = { isReachable: () => true, sendTransaction: async (_c, _chain, tx) => (sent.push(tx), '0x' + String(sent.length).repeat(64)) }
  const result = await executeTransfer(store, SETTINGS, sender, { walletId: wallet.id, tokenKey: usdc.key, to: FRIEND, amount: '100', feeBps: 50 })

  assert.equal(sent.length, 2)
  const [main, fee] = sent.map((tx) => erc20.decodeFunctionData('transfer', tx.data))
  assert.equal(main[0].toLowerCase(), FRIEND.toLowerCase())
  assert.equal(main[1], 100_000_000n, 'the recipient gets the full amount')
  assert.equal(fee[0], OWNER)
  assert.equal(fee[1], 500_000n, '0.5% of 100 USDC')
  assert.equal(result.fee.status, 'sent')
  assert.deepEqual(store.transfers.map((r) => r.kind).sort(), ['fee', 'transfer'])
})

test('never charges more than the rate the user reviewed', async (t) => {
  fees.setFeeRecipientForTests(OWNER)
  served = { feeBps: 200 }
  const { store, wallet } = setup(t)
  let asked = false
  const sender = { isReachable: () => true, sendTransaction: async () => ((asked = true), '0x' + 'a'.repeat(64)) }
  await assert.rejects(
    executeTransfer(store, SETTINGS, sender, { walletId: wallet.id, tokenKey: tokenKey(1, null), to: FRIEND, amount: '1', feeBps: 50 }),
    (e) => e.code === 'FEE_CHANGED'
  )
  assert.equal(asked, false, 'nothing was sent when the rate went up after review')
})

test('a declined fee does not undo the transfer, and is reported', async (t) => {
  fees.setFeeRecipientForTests(OWNER)
  served = { feeBps: 50 }
  const { store, wallet } = setup(t)
  let n = 0
  const sender = {
    isReachable: () => true,
    sendTransaction: async () => {
      n++
      if (n === 2) throw Object.assign(new Error('User rejected'), { code: 4001 })
      return '0x' + 'b'.repeat(64)
    }
  }
  const result = await executeTransfer(store, SETTINGS, sender, { walletId: wallet.id, tokenKey: tokenKey(1, null), to: FRIEND, amount: '1', feeBps: 50 })
  assert.equal(result.hash, '0x' + 'b'.repeat(64))
  assert.equal(result.fee.status, 'declined')
})
