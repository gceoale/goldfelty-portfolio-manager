import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store.ts'
import { Vault } from '../src/main/vault.ts'
import {
  connectSmartWallets,
  connectWatchWallet,
  reconcileWallets,
  WalletLimitError,
  InvalidAddressError,
  MAX_WALLETS
} from '../src/main/wallets.ts'
import { routesForSymbol, receiveRoutes } from '../src/main/transfers.ts'
import { tokenKey } from '../src/shared/chains.ts'

const PASSWORD = 'Tr0ubad0ur&Bits'

async function scenario(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-wallets-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir)
  const vault = new Vault(dir)
  await vault.create(PASSWORD)
  return { store, vault, dir }
}

test('connects 50 smart wallets, each with its own address and key', async (t) => {
  const { store, vault } = await scenario(t)
  const created = connectSmartWallets(store, vault, { count: 50, label: 'Trading' })

  assert.equal(created.length, 50)
  assert.equal(store.activeWallets().length, 50)
  assert.equal(new Set(created.map((w) => w.address)).size, 50)
  assert.equal(new Set(created.map((w) => w.ownerAddress)).size, 50)
  assert.equal(created[0].label, 'Trading 1')
  assert.equal(created[49].label, 'Trading 50')
  assert.ok(created.every((w) => w.kind === 'smart'))
  assert.ok(created.every((w) => w.chainIds.length > 0))
})

test('never reuses a derivation index across separate connects', async (t) => {
  const { store, vault } = await scenario(t)
  connectSmartWallets(store, vault, { count: 20 })
  connectSmartWallets(store, vault, { count: 35 })

  const indices = store.wallets.map((w) => w.derivationIndex)
  assert.equal(indices.length, 55)
  assert.equal(new Set(indices).size, 55, 'a reused index would mean two wallets sharing one key')
  assert.deepEqual([...indices].sort((a, b) => a - b), Array.from({ length: 55 }, (_, i) => i))
})

test('enforces the wallet ceiling', async (t) => {
  const { store, vault } = await scenario(t)
  connectSmartWallets(store, vault, { count: MAX_WALLETS })
  assert.throws(() => connectSmartWallets(store, vault, { count: 1 }), WalletLimitError)
})

test('falls back to the default networks when given none', async (t) => {
  const { store, vault } = await scenario(t)
  const [wallet] = connectSmartWallets(store, vault, { count: 1, chainIds: [999999] })
  assert.ok(wallet.chainIds.length > 0)
  assert.ok(!wallet.chainIds.includes(999999))
})

test('adds watch-only wallets and rejects bad or duplicate addresses', async (t) => {
  const { store } = await scenario(t)
  const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
  const watch = connectWatchWallet(store, { address, label: 'Cold storage' })

  assert.equal(watch.kind, 'watch')
  assert.equal(watch.ownerAddress, null)
  assert.equal(watch.derivationIndex, null)

  assert.throws(() => connectWatchWallet(store, { address: 'not-an-address' }), InvalidAddressError)
  assert.throws(() => connectWatchWallet(store, { address: address.toLowerCase() }), /already connected/)
})

test('reconcile repairs an address that drifted in the state file', async (t) => {
  const { store, vault } = await scenario(t)
  const [wallet] = connectSmartWallets(store, vault, { count: 1 })
  const correct = wallet.address

  store.updateWallet(wallet.id, { address: '0x0000000000000000000000000000000000000dEaD' })
  const { repaired } = reconcileWallets(store, vault)

  assert.equal(repaired, 1)
  assert.equal(store.wallet(wallet.id).address, correct)
})

test('reconcile leaves watch wallets alone', async (t) => {
  const { store, vault } = await scenario(t)
  connectWatchWallet(store, { address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' })
  assert.equal(reconcileWallets(store, vault).repaired, 0)
})

/* ---- routing ---------------------------------------------------------- */

function balance(walletId, chainId, address, symbol, amount, value) {
  return {
    walletId,
    tokenKey: tokenKey(chainId, address),
    chainId,
    symbol,
    raw: String(amount),
    amount,
    value,
    stale: false
  }
}

const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

test('offers one route per wallet and chain holding the token', async (t) => {
  const { store, vault } = await scenario(t)
  const [a, b] = connectSmartWallets(store, vault, { count: 2 })

  const routes = routesForSymbol(
    store,
    [
      balance(a.id, 1, USDC_ETH, 'USDC', 120, 120),
      balance(b.id, 1, USDC_ETH, 'USDC', 400, 400),
      balance(b.id, 8453, USDC_BASE, 'USDC', 75, 75)
    ],
    'USDC'
  )

  assert.equal(routes.length, 3, 'the user must get the choice, not a guess')
  assert.ok(routes.every((r) => r.walletKind === 'smart'))
  assert.deepEqual(
    routes.map((r) => r.amount),
    [400, 120, 75],
    'routes are ordered by what they can cover'
  )
})

test('marks routes that cannot cover the amount as insufficient', async (t) => {
  const { store, vault } = await scenario(t)
  const [a, b] = connectSmartWallets(store, vault, { count: 2 })

  const routes = routesForSymbol(
    store,
    [balance(a.id, 1, USDC_ETH, 'USDC', 10, 10), balance(b.id, 1, USDC_ETH, 'USDC', 500, 500)],
    'USDC',
    100
  )

  assert.equal(routes[0].walletId, b.id, 'a route that works must come first')
  assert.equal(routes[0].sufficient, true)
  assert.equal(routes[1].sufficient, false)
})

test('never routes through an archived wallet', async (t) => {
  const { store, vault } = await scenario(t)
  const [a, b] = connectSmartWallets(store, vault, { count: 2 })
  store.updateWallet(a.id, { archived: true })

  const routes = routesForSymbol(
    store,
    [balance(a.id, 1, USDC_ETH, 'USDC', 100, 100), balance(b.id, 1, USDC_ETH, 'USDC', 100, 100)],
    'USDC'
  )
  assert.equal(routes.length, 1)
  assert.equal(routes[0].walletId, b.id)
})

test('flags a route whose account is not deployed on that chain yet', async (t) => {
  const { store, vault } = await scenario(t)
  const [a] = connectSmartWallets(store, vault, { count: 1 })

  let [route] = routesForSymbol(store, [balance(a.id, 1, USDC_ETH, 'USDC', 100, 100)], 'USDC')
  assert.equal(route.requiresDeployment, true)

  store.updateWallet(a.id, { deployedOn: [1] })
  ;[route] = routesForSymbol(store, [balance(a.id, 1, USDC_ETH, 'USDC', 100, 100)], 'USDC')
  assert.equal(route.requiresDeployment, false)
})

test('receive offers every wallet and chain that can accept the symbol', async (t) => {
  const { store, vault } = await scenario(t)
  connectSmartWallets(store, vault, { count: 3, chainIds: [1, 8453] })

  const routes = receiveRoutes(store, 'USDC')
  assert.equal(routes.length, 6, '3 wallets on 2 chains')
  assert.equal(new Set(routes.map((r) => r.walletId)).size, 3)
  assert.equal(new Set(routes.map((r) => r.chainId)).size, 2)
})

test('receive includes watch wallets, since they can still be paid into', async (t) => {
  const { store, vault } = await scenario(t)
  connectSmartWallets(store, vault, { count: 1, chainIds: [1] })
  connectWatchWallet(store, { address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', chainIds: [1] })

  const routes = receiveRoutes(store, 'USDC')
  assert.equal(routes.length, 2)
  assert.ok(routes.some((r) => r.walletKind === 'watch'))
})
