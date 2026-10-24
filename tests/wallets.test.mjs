import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet as EthersWallet } from 'ethers'
import { Store } from '../src/main/store.ts'
import { registerConnectionAccounts, detachConnection, trackAddress } from '../src/main/wallets.ts'
import {
  routesForSymbol,
  receiveRoutes,
  lookalikeOf,
  describeMismatch,
  buildTransaction,
  executeTransfer
} from '../src/main/transfers.ts'
import { TOKENS, tokenKey } from '../src/shared/chains.ts'
import { WALLET_REGISTRY, matchRegistry, providerIdFor, monogram } from '../src/shared/walletRegistry.ts'
import { DEFAULT_SETTINGS } from '../src/main/settings.ts'

const A = '0x52908400098527886E0F7030069857D2E4169EE7'
const B = '0x8617E340B3D01FA5F11F306F4090FD50E238070D'
const C = '0xde709f2102306220921060314715629080e2fb77'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-wallets-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir)
  store.open(randomBytes(32))
  return store
}

function connection(overrides = {}) {
  return {
    id: 'browser:io.metamask',
    kind: 'browser',
    family: 'evm',
    name: 'MetaMask',
    providerId: 'metamask',
    rdns: 'io.metamask',
    icon: null,
    accounts: [A],
    chainIds: [1],
    connectedAt: 1,
    active: true,
    topic: null,
    ...overrides
  }
}

const reachable = { isReachable: () => true, sendTransaction: async () => '0x' + 'ab'.repeat(32) }

/* ---- registry ------------------------------------------------------------ */

test('the registry covers more than 30 wallets with unique ids and rdns', () => {
  assert.ok(WALLET_REGISTRY.length >= 30)
  assert.equal(new Set(WALLET_REGISTRY.map((w) => w.id)).size, WALLET_REGISTRY.length)
  const rdns = WALLET_REGISTRY.flatMap((w) => w.rdns)
  assert.equal(new Set(rdns).size, rdns.length)
  for (const w of WALLET_REGISTRY) {
    assert.ok(w.homepage.startsWith('https://'), `${w.name} links over https`)
    assert.match(w.color, /^#[0-9a-f]{6}$/i)
  }
})

test('announced wallets are matched by rdns first, then by name', () => {
  assert.equal(matchRegistry('io.rabby', 'Anything').id, 'rabby')
  assert.equal(matchRegistry('com.unknown', 'Rabby Wallet').id, 'rabby')
  assert.equal(matchRegistry('com.unknown', 'Totally New Wallet'), null)
  assert.equal(providerIdFor('com.unknown', 'Totally New Wallet'), 'com.unknown')
  assert.equal(monogram('MetaMask'), 'M')
  assert.equal(monogram('Coinbase Wallet'), 'C')
})

/* ---- registering accounts ---------------------------------------------- */

test('each shared account becomes one wallet, named after its app', (t) => {
  const store = openStore(t)
  const created = registerConnectionAccounts(store, connection({ accounts: [A, B] }), [1, 8453])
  assert.deepEqual(created.map((w) => w.label), ['MetaMask 1', 'MetaMask 2'])
  assert.ok(created.every((w) => w.kind === 'browser' && w.connectionId === 'browser:io.metamask'))
  assert.deepEqual(created[0].chainIds, [1, 8453])
})

test('reconnecting re-points an existing address instead of duplicating it', (t) => {
  const store = openStore(t)
  registerConnectionAccounts(store, connection(), [1])
  detachConnection(store, 'browser:io.metamask')
  assert.equal(store.wallets[0].connectionId, null)
  registerConnectionAccounts(store, connection({ id: 'frame', kind: 'frame', family: 'evm', name: 'Frame', providerId: 'frame-desktop', rdns: null }), [1])
  assert.equal(store.wallets.length, 1)
  assert.equal(store.wallets[0].kind, 'frame')
  assert.equal(store.wallets[0].connectionId, 'frame')
})

test('a read-only address from an earlier version can send again once a wallet shares it', (t) => {
  const store = openStore(t)
  store.addWallet({
    id: 'old', label: 'Old', kind: 'readonly', address: A, connectionId: null, providerName: null, providerId: null,
    chainIds: [1], enabledTokens: [], color: '#888888', createdAt: 1, archived: false, note: 'created by v1'
  })
  registerConnectionAccounts(store, connection(), [1])
  assert.equal(store.wallets.length, 1)
  assert.equal(store.wallets[0].kind, 'browser')
  assert.equal(store.wallets[0].note, null)
})

test('ignores anything that is not an address', (t) => {
  const store = openStore(t)
  assert.equal(registerConnectionAccounts(store, connection({ accounts: ['nope', A] }), [1]).length, 1)
})

/* ---- routes ------------------------------------------------------------- */

const ETH = tokenKey(1, null)

function balance(walletId, amount) {
  return { walletId, tokenKey: ETH, chainId: 1, symbol: 'ETH', raw: '0', amount, value: amount * 3000, stale: false }
}

test('read-only wallets are never offered to send from or receive into', (t) => {
  const store = openStore(t)
  const [mm] = registerConnectionAccounts(store, connection(), [1])
  store.addWallet({
    id: 'ro', label: 'Old', kind: 'readonly', address: B, connectionId: null, providerName: null, providerId: null,
    chainIds: [1], enabledTokens: [], color: '#888888', createdAt: 1, archived: false, note: null
  })
  const routes = routesForSymbol(store, reachable, [balance(mm.id, 1), balance('ro', 5)], 'ETH')
  assert.deepEqual(routes.map((r) => r.walletId), [mm.id])
  assert.ok(receiveRoutes(store, reachable, 'ETH').every((r) => r.walletId !== 'ro'))
})

test('routes the user can actually use sort first', (t) => {
  const store = openStore(t)
  const [first, second] = registerConnectionAccounts(store, connection({ accounts: [A, B] }), [1])
  const sender = { ...reachable, isReachable: () => false }
  store.updateWallet(second.id, { connectionId: 'other' })
  const routes = routesForSymbol(
    store,
    { ...sender, isReachable: (id) => id === 'other' },
    [balance(first.id, 10), balance(second.id, 1)],
    'ETH',
    0.5
  )
  assert.equal(routes[0].walletId, second.id, 'reachable beats bigger balance')
  assert.equal(routes[1].reachable, false)
})

/* ---- transfers ---------------------------------------------------------- */

test('flags an address that only looks like one you have used', () => {
  const poisoned = '0x5290' + '0'.repeat(32) + '9EE7'
  assert.equal(lookalikeOf(poisoned, [A, B]), A)
  assert.equal(lookalikeOf(A, [A, B]), null, 'the real one is fine')
  assert.equal(lookalikeOf(C, [A, B]), null)
})

test('notices when the chain recorded something other than what was asked', () => {
  const usdc = TOKENS.find((t) => t.chainId === 1 && t.symbol === 'USDC')
  const w = { address: A }
  const asked = buildTransaction(w, usdc, B, 1_000_000n)
  const same = { from: A.toLowerCase(), to: usdc.address, value: 0n, data: asked.data }
  assert.equal(describeMismatch(asked, same), null)
  assert.match(describeMismatch(asked, { ...same, to: C }), /different address/)
  assert.match(describeMismatch(asked, { ...same, from: C }), /sent from a different/)
  const swapped = buildTransaction(w, usdc, C, 1_000_000n)
  assert.match(describeMismatch(asked, { ...same, data: swapped.data }), /contents differ/)
  const eth = buildTransaction(w, { address: null }, B, 5n)
  assert.match(describeMismatch(eth, { from: A, to: B, value: 6n, data: '0x' }), /different amount/)
})

test('a wallet declining is reported as declined, with nothing recorded', async (t) => {
  const store = openStore(t)
  const [mm] = registerConnectionAccounts(store, connection(), [1])
  const declining = {
    isReachable: () => true,
    sendTransaction: async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }
  }
  await assert.rejects(
    executeTransfer(store, DEFAULT_SETTINGS, declining, { walletId: mm.id, tokenKey: ETH, to: B, amount: '0.1', feeBps: 0 }),
    (e) => e.code === 'DECLINED'
  )
  assert.equal(store.transfers.length, 0)
})

test('refuses bad amounts and recipients before asking the wallet anything', async (t) => {
  const store = openStore(t)
  const [mm] = registerConnectionAccounts(store, connection(), [1])
  let asked = false
  const spy = { isReachable: () => true, sendTransaction: async () => ((asked = true), '0x') }
  for (const [to, amount] of [[B, '0'], [B, '-1'], [B, '1e999999'], ['0x1234', '1'], [B, 'abc']]) {
    await assert.rejects(executeTransfer(store, DEFAULT_SETTINGS, spy, { walletId: mm.id, tokenKey: ETH, to, amount, feeBps: 0 }))
  }
  assert.equal(asked, false)
})

test('a signer from ethers can stand in for a wallet when checking signatures', async () => {
  // Sanity check for the account tests: personal_sign over hex-encoded UTF-8
  // is the same as signing the string.
  const w = EthersWallet.createRandom()
  const text = 'Goldfelty account registration\nusername: a'
  assert.equal(await w.signMessage(text), await w.signMessage(Buffer.from(text, 'utf8')))
})

/* ---- wallets that can't connect ----------------------------------------- */

test('an Exodus address can be tracked read-only, and never offered for sending or receiving', (t) => {
  const store = openStore(t)
  const w = trackAddress(store, { address: A.toLowerCase(), providerId: 'exodus-desktop' }, [1, 8453])
  assert.equal(w.kind, 'readonly')
  assert.equal(w.address, A, 'stored checksummed')
  assert.equal(w.label, 'Exodus')
  assert.equal(w.connectionId, null)
  assert.match(w.note, /send and receive with Exodus/)
  assert.deepEqual(routesForSymbol(store, reachable, [balance(w.id, 3)], 'ETH'), [])
  assert.deepEqual(receiveRoutes(store, reachable, 'ETH'), [])
})

test('tracking refuses typos, duplicates, and unknown apps get a plain label', (t) => {
  const store = openStore(t)
  // Flip the case of one letter: mixed-case addresses carry a checksum in their case.
  const i = A.indexOf('E')
  const badChecksum = A.slice(0, i) + 'e' + A.slice(i + 1)
  assert.throws(() => trackAddress(store, { address: badChecksum }, [1]), /valid address/)
  assert.throws(() => trackAddress(store, { address: 'not an address' }, [1]), /recognise that address/)
  const w = trackAddress(store, { address: B, label: '  Cold storage  ', providerId: 'made-up' }, [1])
  assert.equal(w.label, 'Cold storage')
  assert.equal(w.providerId, null)
  assert.throws(() => trackAddress(store, { address: B.toLowerCase() }, [1]), /already in Goldfelty/)
})

test('connecting a tracked address later upgrades it in place', (t) => {
  const store = openStore(t)
  trackAddress(store, { address: A, providerId: 'exodus-desktop' }, [1])
  registerConnectionAccounts(store, connection(), [1])
  assert.equal(store.wallets.length, 1)
  assert.equal(store.wallets[0].kind, 'browser')
})

test('any chain’s address can be tracked, and lands on the right chain', (t) => {
  const store = openStore(t)
  const cases = [
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'utxo', [-1]],
    ['DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', 'utxo', [-3]],
    ['LVg2kJoFNg45Nbpy53h7Fe1wKyeXVRhMH9', 'utxo', [-2]],
    ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tron', [-195]],
    ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'xrp', [-144]],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana', [-501]]
  ]
  for (const [address, family, chainIds] of cases) {
    const w = trackAddress(store, { address, providerId: 'exodus-desktop' }, [1])
    assert.equal(w.family, family, address)
    assert.deepEqual(w.chainIds, chainIds, address)
    assert.equal(w.kind, 'readonly')
  }
  // A one-character slip in a checksummed format is refused.
  assert.throws(() => trackAddress(store, { address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr' }, [1]), /recognise/)
  assert.throws(() => trackAddress(store, { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u' }, [1]), /recognise/)
})
