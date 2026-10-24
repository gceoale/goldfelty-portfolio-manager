import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, migrateLegacy, StoreClosedError } from '../src/main/store.ts'
import { CorruptDataError } from '../src/main/crypto.ts'
import { Prefs, FREE_ATTEMPTS } from '../src/main/prefs.ts'
import { applySettingsPatch, normaliseSettings, isAllowedEndpoint, DEFAULT_SETTINGS } from '../src/main/settings.ts'

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function wallet(overrides = {}) {
  return {
    id: 'w1',
    label: 'MetaMask',
    kind: 'browser',
    address: ADDRESS,
    connectionId: 'browser:io.metamask',
    providerName: 'MetaMask',
    providerId: 'metamask',
    chainIds: [1],
    enabledTokens: [],
    color: '#f6851b',
    createdAt: 1,
    archived: false,
    note: null,
    ...overrides
  }
}

test('nothing about your wallets is readable on disk', (t) => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.open(randomBytes(32))
  store.addWallet(wallet())
  store.updateSettings({ currency: 'EUR' })
  store.close()
  const raw = readFileSync(join(dir, 'state.enc'), 'utf8')
  assert.ok(!raw.toLowerCase().includes(ADDRESS.toLowerCase().slice(2)), 'addresses are encrypted')
  assert.ok(!raw.includes('MetaMask'))
  assert.ok(!raw.includes('EUR'))
})

test('reopens with the right key, refuses the wrong one, and is unusable while closed', (t) => {
  const dir = tempDir(t)
  const key = randomBytes(32)
  const store = new Store(dir)
  store.open(key)
  store.addWallet(wallet())
  store.close()
  assert.throws(() => store.wallets, StoreClosedError)

  const again = new Store(dir)
  assert.throws(() => again.open(randomBytes(32)), CorruptDataError)
  again.open(key)
  assert.equal(again.wallets[0].address, ADDRESS)
})

test('a version 1 state file is converted, encrypted, and removed', (t) => {
  const dir = tempDir(t)
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      settings: { currency: 'GBP', confirmBeforeSend: true, autoLockMinutes: 0, customRpc: { 1: 'javascript:alert(1)' } },
      account: { username: 'alice', email: 'a@example.com', goldfeltyId: 'gf_x', createdAt: 1, linked: true, backedUp: true },
      wallets: [
        { id: 'a', label: 'Smart 1', kind: 'smart', address: '0x0000000000000000000000000000000000000001' },
        { id: 'b', label: 'Watch', kind: 'watch', address: '0x0000000000000000000000000000000000000002' },
        { id: 'c', label: 'Phone', kind: 'walletconnect', address: '0x0000000000000000000000000000000000000003', providerName: 'Rainbow' },
        { id: 'd', label: 'Ext', kind: 'extension', address: '0x0000000000000000000000000000000000000004', providerName: 'MetaMask' }
      ]
    })
  )
  const store = new Store(dir)
  const report = store.open(randomBytes(32))
  assert.deepEqual(report.createdAddresses, ['0x0000000000000000000000000000000000000001'])
  assert.equal(existsSync(join(dir, 'state.json')), false, 'the plaintext file is gone')
  assert.deepEqual(store.wallets.map((w) => w.kind), ['readonly', 'readonly', 'walletconnect', 'browser'])
  assert.ok(store.wallets.every((w) => w.connectionId === null), 'old connections must be made again')
  assert.equal(store.wallets[3].providerId, 'metamask')
  assert.equal(store.settings.currency, 'GBP')
  assert.equal(store.settings.autoLockMinutes, DEFAULT_SETTINGS.autoLockMinutes, '"never lock" is not carried over')
  assert.deepEqual(store.settings.customRpc, {}, 'an unsafe endpoint from an old file is dropped')
  assert.equal(store.account.username, 'alice')
})

test('migrateLegacy copes with an empty file', () => {
  const { data, report } = migrateLegacy({})
  assert.deepEqual(data.wallets, [])
  assert.deepEqual(report.createdAddresses, [])
})

test('reset clears wallets but keeps the account and settings', (t) => {
  const store = new Store(tempDir(t))
  store.open(randomBytes(32))
  store.setAccount({ username: 'bob', email: 'b@example.com', goldfeltyId: 'local-1', createdAt: 1, linked: false, address: null })
  store.updateSettings({ currency: 'JPY' })
  store.addWallet(wallet())
  store.reset()
  assert.equal(store.wallets.length, 0)
  assert.equal(store.account.username, 'bob')
  assert.equal(store.settings.currency, 'JPY')
})

/* ---- settings rules ----------------------------------------------------- */

test('endpoints must be https, or http on this computer, with no credentials', () => {
  assert.equal(isAllowedEndpoint('https://eth.example.com'), true)
  assert.equal(isAllowedEndpoint('http://127.0.0.1:8545'), true)
  assert.equal(isAllowedEndpoint('http://localhost:8545'), true)
  assert.equal(isAllowedEndpoint('http://rpc.example.com'), false)
  assert.equal(isAllowedEndpoint('https://user:pass@rpc.example.com'), false)
  assert.equal(isAllowedEndpoint('file:///etc/passwd'), false)
  assert.equal(isAllowedEndpoint('javascript:alert(1)'), false)
  assert.equal(isAllowedEndpoint('not a url'), false)
})

test('settings patches are validated field by field', () => {
  const s = DEFAULT_SETTINGS
  assert.throws(() => applySettingsPatch(s, { customRpc: { 1: 'http://evil.example' } }), /https/)
  assert.throws(() => applySettingsPatch(s, { priceProviderUrl: 'http://evil.example' }), /https/)
  assert.throws(() => applySettingsPatch(s, { enabledChains: [] }), /at least one/)
  assert.throws(() => applySettingsPatch(s, { walletConnectProjectId: 'nope' }), /32/)
  const next = applySettingsPatch(s, {
    autoLockMinutes: 0,
    refreshIntervalSeconds: 1,
    theme: 'neon',
    enabledChains: [1, 999999, 1],
    customRpc: { 1: 'https://eth.example.com', 424242: 'https://x.example.com' },
    surprise: true
  })
  assert.equal(next.autoLockMinutes, 1, 'auto-lock cannot be turned off')
  assert.equal(next.refreshIntervalSeconds, 15)
  assert.equal(next.theme, s.theme)
  assert.deepEqual(next.enabledChains, [1])
  assert.deepEqual(next.customRpc, { 1: 'https://eth.example.com' })
  assert.equal('surprise' in next, false)
  assert.deepEqual(applySettingsPatch(next, { customRpc: { 1: '' } }).customRpc, {})
})

test('normaliseSettings repairs a file one field at a time', () => {
  const s = normaliseSettings({ currency: 'EUR', priceProviderUrl: 'ftp://x', enabledChains: 'all' })
  assert.equal(s.currency, 'EUR')
  assert.equal(s.priceProviderUrl, DEFAULT_SETTINGS.priceProviderUrl)
  assert.deepEqual(s.enabledChains, DEFAULT_SETTINGS.enabledChains)
})

/* ---- unlock throttling --------------------------------------------------- */

test('wrong passwords past the free ones make the next try wait, doubling', (t) => {
  const prefs = new Prefs(tempDir(t))
  const now = 1_000_000
  for (let i = 0; i < FREE_ATTEMPTS; i++) assert.equal(prefs.recordFailedUnlock(now), null)
  assert.equal(prefs.recordFailedUnlock(now), now + 1000)
  assert.equal(prefs.recordFailedUnlock(now), now + 2000)
  assert.equal(prefs.recordFailedUnlock(now), now + 4000)
  assert.equal(prefs.unlockRetryAt(now), now + 4000)
  assert.equal(prefs.unlockRetryAt(now + 5000), null)
  prefs.recordSuccessfulUnlock()
  assert.equal(prefs.failedUnlocks, 0)
})

test('the count survives a restart and the wait is capped', (t) => {
  const dir = tempDir(t)
  const prefs = new Prefs(dir)
  for (let i = 0; i < 40; i++) prefs.recordFailedUnlock(0)
  const reopened = new Prefs(dir)
  assert.equal(reopened.failedUnlocks, 40)
  assert.equal(reopened.unlockRetryAt(0), 15 * 60_000)
})

test('prefs hold no settings that change where the app connects', (t) => {
  const dir = tempDir(t)
  const prefs = new Prefs(dir)
  prefs.setTheme('dark')
  const raw = JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['failedUnlocks', 'greetingName', 'onboarded', 'schemaVersion', 'theme', 'unlockRetryAt', 'upgradeNotice'])
})
