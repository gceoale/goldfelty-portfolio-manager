import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Wallet } from 'ethers'
import worker, { d1 } from '../src/worker.js'
import { statementFor } from '../src/accounts.js'

/**
 * A minimal stand-in for the D1 binding over real SQLite, so the SQL in
 * worker.js and schema.sql runs for real rather than against a Map.
 */
function fakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  return {
    raw: db,
    prepare(sql) {
      let args = []
      const stmt = db.prepare(sql)
      return {
        bind(...values) {
          args = values
          return this
        },
        async first() {
          return stmt.get(...args) ?? null
        },
        async run() {
          stmt.run(...args)
          return { success: true }
        },
        async all() {
          return { results: stmt.all(...args) }
        }
      }
    }
  }
}

test('the schema enforces one account per username and per address', async () => {
  const database = fakeD1()
  const store = d1(database)
  await store.insert({ username: 'alice', email: 'a@example.com', address: '0x' + '1'.repeat(40) })
  await assert.rejects(store.insert({ username: 'alice', email: 'b@example.com', address: '0x' + '2'.repeat(40) }), /UNIQUE/)
  await assert.rejects(store.insert({ username: 'bob', email: 'b@example.com', address: '0x' + '1'.repeat(40) }), /UNIQUE/)
  assert.equal((await store.findByUsername('alice')).username, 'alice')
})

test('rate-limit counting works in SQL, and sweeping one kind spares the other', async () => {
  const database = fakeD1()
  const store = d1(database)
  assert.equal(await store.hit('register:abc', 10), 1)
  assert.equal(await store.hit('register:abc', 10), 2)
  assert.equal(await store.hit('check:abc', 900_000), 1)
  // Force a sweep from the per-minute kind; the hourly row must survive.
  const random = Math.random
  Math.random = () => 0
  try {
    await store.hit('check:abc', 900_100)
  } finally {
    Math.random = random
  }
  const rows = database.raw.prepare('SELECT key, bucket FROM rate_limits ORDER BY key').all()
  assert.ok(rows.some((r) => r.key === 'register:abc'), 'hourly counts survive a per-minute sweep')
  assert.ok(!rows.some((r) => r.key === 'check:abc' && r.bucket === 900_000), 'stale per-minute rows are swept')
})

test('a full registration goes through the Worker entry point', async () => {
  const env = { DB: fakeD1() }
  const wallet = Wallet.createRandom()
  const body = { username: 'carol', email: 'carol@example.com', address: wallet.address, issuedAt: new Date().toISOString() }
  body.signature = await wallet.signMessage(statementFor(body))
  const res = await worker.fetch(
    new Request('https://api.goldfelty.com/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify(body)
    }),
    env
  )
  assert.equal(res.status, 201)
  const json = await res.json()
  // The exact shape the desktop app checks for.
  assert.match(json.id, /^gf_[0-9a-f-]{36}$/)
  const taken = await worker.fetch(new Request('https://api.goldfelty.com/v1/accounts/username-available?username=carol'), env)
  assert.equal((await taken.json()).available, false)
})

test('the owner sees user counts and shared totals, from real SQL', async () => {
  const env = { DB: fakeD1(), ADMIN_TOKEN: 'z'.repeat(40) }
  const register = async (username) => {
    const wallet = Wallet.createRandom()
    const body = { username, email: `${username}@example.com`, address: wallet.address, issuedAt: new Date().toISOString() }
    body.signature = await wallet.signMessage(statementFor(body))
    const res = await worker.fetch(
      new Request('https://api.goldfelty.com/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      env
    )
    return res.json()
  }
  const a = await register('dana')
  const b = await register('eli')
  await register('fay')
  const share = (token, value, currency) =>
    worker.fetch(
      new Request('https://api.goldfelty.com/v1/reports', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ value, currency, wallets: 2 })
      }),
      env
    )
  assert.equal((await share(a.token, 5000, 'USD')).status, 204)
  assert.equal((await share(b.token, 250, 'USD')).status, 204)
  assert.equal((await share(a.token, 6000, 'USD')).status, 204, 'a later report replaces the earlier one')

  const res = await worker.fetch(new Request('https://api.goldfelty.com/v1/admin/stats', { headers: { authorization: `Bearer ${'z'.repeat(40)}` } }), env)
  const stats = await res.json()
  assert.equal(stats.users, 3)
  assert.equal(stats.sharing, 2)
  assert.deepEqual(stats.totals, [{ currency: 'USD', users: 2, total: 6250 }])
  assert.deepEqual(stats.accounts.map((x) => [x.username, x.value]), [['dana', 6000], ['eli', 250], ['fay', null]])
})
