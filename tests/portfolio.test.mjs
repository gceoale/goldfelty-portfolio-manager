import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeChange, sliceHistory } from '../src/main/portfolio.ts'
import { Store } from '../src/main/store.ts'
import { validateUsername, validateEmail } from '../src/main/goldfelty.ts'
import { CHAINS, TOKENS, tokensBySymbol, getChain, tokenKey } from '../src/shared/chains.ts'

const HOUR = 3600_000

function history(...entries) {
  return entries.map(([hoursAgo, total]) => ({ at: Date.now() - hoursAgo * HOUR, total, byWallet: {} }))
}

test('measures growth against the first snapshot inside the window', () => {
  const snapshots = history([48, 800], [20, 1000], [2, 1100])
  const { change, changePct } = computeChange(snapshots, 1200, '24h')
  assert.equal(change, 200, 'the 24h baseline is the 20h-old snapshot, not the 48h one')
  assert.equal(Math.round(changePct), 20)
})

test('reports a loss as a negative change', () => {
  const { change, changePct } = computeChange(history([10, 1000]), 750, '24h')
  assert.equal(change, -250)
  assert.equal(changePct, -25)
})

test('falls back to the oldest snapshot for the all-time range', () => {
  const { change } = computeChange(history([5000, 100], [10, 900]), 1000, 'all')
  assert.equal(change, 900)
})

test('returns a flat change rather than dividing by zero', () => {
  assert.deepEqual(computeChange([], 500, '24h'), { change: 0, changePct: 0 })
  assert.deepEqual(computeChange(history([5, 0]), 500, '24h'), { change: 0, changePct: 0 })
})

test('always leaves the chart at least two points to draw', () => {
  const snapshots = history([400, 10], [380, 20])
  assert.equal(sliceHistory(snapshots, '24h').length, 2)
  assert.equal(sliceHistory(history([1, 5]), '24h').length, 1)
})

test('collapses snapshots taken within five minutes of each other', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir)

  store.pushSnapshot({ at: Date.now() - 60_000, total: 100, byWallet: {} })
  store.pushSnapshot({ at: Date.now(), total: 110, byWallet: {} })
  assert.equal(store.history.length, 1, 'a burst of refreshes must not flatten the time axis')
  assert.equal(store.history[0].total, 110)

  store.pushSnapshot({ at: Date.now() + 10 * 60_000, total: 130, byWallet: {} })
  assert.equal(store.history.length, 2)
})

test('settings survive a reload and reset restores defaults', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = new Store(dir)
  store.updateSettings({ currency: 'EUR', autoLockMinutes: 30 })
  assert.equal(new Store(dir).settings.currency, 'EUR')

  store.reset()
  assert.equal(store.settings.currency, 'USD')
  assert.equal(store.wallets.length, 0)
})

/* ---- registry sanity --------------------------------------------------- */

test('every chain carries at least one RPC endpoint and an explorer', () => {
  for (const chain of CHAINS) {
    assert.ok(chain.rpcUrls.length > 0, `${chain.name} has no RPC`)
    assert.ok(chain.rpcUrls.every((url) => url.startsWith('https://')), `${chain.name} has a non-TLS RPC`)
    assert.ok(chain.explorer.startsWith('https://'))
    assert.equal(getChain(chain.id).id, chain.id)
  }
})

test('token keys are unique and every chain has a native token', () => {
  assert.equal(new Set(TOKENS.map((t) => t.key)).size, TOKENS.length)
  for (const chain of CHAINS) {
    const native = TOKENS.find((t) => t.chainId === chain.id && t.address === null)
    assert.ok(native, `${chain.name} has no native token`)
    assert.equal(native.key, tokenKey(chain.id, null))
    assert.equal(native.symbol, chain.nativeSymbol)
  }
})

test('the same symbol spans several chains, which is what forces a route choice', () => {
  const usdc = tokensBySymbol('USDC')
  assert.ok(usdc.length >= 5)
  assert.equal(new Set(usdc.map((t) => t.chainId)).size, usdc.length)
})

test('validates usernames and emails before they reach the network', () => {
  assert.equal(validateUsername('satoshi'), null)
  assert.equal(validateUsername('a-b_c9'), null)
  assert.match(validateUsername('ab'), /at least 3/)
  assert.match(validateUsername('-nope'), /lowercase letters/)
  assert.match(validateUsername('has space'), /lowercase letters/)
  assert.equal(validateEmail('you@example.com'), null)
  assert.match(validateEmail('not-an-email'), /valid email/)
})
