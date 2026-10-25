import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import { handleRequest, statementFor, usernameProblem, MAX_AGE_MS } from '../src/accounts.js'

/** An in-memory stand-in for D1, unique indexes included. */
function makeDb() {
  const byUsername = new Map()
  const byAddress = new Map()
  return {
    async findByUsername(u) { return byUsername.get(u) ?? null },
    async findByAddress(a) { return byAddress.get(a) ?? null },
    async insert({ username, email, address }) {
      if (byUsername.has(username)) throw new Error('UNIQUE constraint failed: accounts.username')
      const account = { id: `gf_${byUsername.size}`, username, email, address }
      byUsername.set(username, account)
      byAddress.set(address, account)
      return account
    },
    tokens: new Map(),
    reports: new Map(),
    async setToken(id, hash) {
      for (const [h, v] of this.tokens) if (v === id) this.tokens.delete(h)
      this.tokens.set(hash, id)
    },
    async findByTokenHash(hash) {
      const id = this.tokens.get(hash)
      return id ? [...byUsername.values()].find((a) => a.id === id) : null
    },
    async upsertReport(id, r) { this.reports.set(id, r) },
    async deleteReport(id) { this.reports.delete(id) },
    async stats() { return { users: byUsername.size, sharing: this.reports.size, totals: [], accounts: [] } },
    size: () => byUsername.size
  }
}

async function post(db, body, now = Date.now()) {
  const request = new Request('https://api.goldfelty.com/v1/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const res = await handleRequest(db, request, now)
  return { res, json: await res.json() }
}

async function signed(overrides = {}, wallet = Wallet.createRandom()) {
  const body = {
    username: 'alice',
    email: 'alice@example.com',
    address: wallet.address,
    issuedAt: new Date().toISOString(),
    ...overrides
  }
  body.signature = overrides.signature ?? (await wallet.signMessage(statementFor(body)))
  return { body, wallet }
}

test('registers when the signature checks out', async () => {
  const db = makeDb()
  const { body } = await signed()
  const { res, json } = await post(db, body)
  assert.equal(res.status, 201)
  assert.equal(json.username, 'alice')
  assert.match(json.id, /^gf_/)
})

test('refuses a signature from a different key', async () => {
  const db = makeDb()
  const victim = Wallet.createRandom()
  const impostor = Wallet.createRandom()
  const { body } = await signed({ address: victim.address }, victim)
  body.signature = await impostor.signMessage(statementFor(body))
  const { res, json } = await post(db, body)
  assert.equal(res.status, 401)
  assert.match(json.message, /does not match/)
  assert.equal(db.size(), 0)
})

test('refuses a signature taken from a different statement', async () => {
  const db = makeDb()
  const { body, wallet } = await signed({ username: 'alice' })
  // Same signature, different username: the statement no longer matches.
  const tampered = { ...body, username: 'bob' }
  tampered.signature = await wallet.signMessage(statementFor(body))
  const { res } = await post(db, tampered)
  assert.equal(res.status, 401)
})

test('refuses a stale or future-dated registration', async () => {
  const db = makeDb()
  const old = await signed({ issuedAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString() })
  assert.equal((await post(db, old.body)).res.status, 400)
  const future = await signed({ issuedAt: new Date(Date.now() + 10 * 60_000).toISOString() })
  assert.equal((await post(db, future.body)).res.status, 400)
})

test('refuses a username somebody else holds', async () => {
  const db = makeDb()
  assert.equal((await post(db, (await signed({ username: 'taken' })).body)).res.status, 201)
  const second = await post(db, (await signed({ username: 'taken' })).body)
  assert.equal(second.res.status, 409)
})

test('returns the existing account when an address re-registers', async () => {
  const db = makeDb()
  const wallet = Wallet.createRandom()
  const first = await signed({ username: 'stable' }, wallet)
  assert.equal((await post(db, first.body)).res.status, 201)

  // This is what happens every time the app re-links after being offline.
  const again = await signed({ username: 'somethingelse' }, wallet)
  const { res, json } = await post(db, again.body)
  assert.equal(res.status, 200)
  assert.equal(json.username, 'stable')
  assert.equal(db.size(), 1)
})

test('lets the unique index settle a simultaneous claim', async () => {
  const db = makeDb()
  const a = await signed({ username: 'race' })
  const b = await signed({ username: 'race' })
  // Both pass the availability check, then both try to insert.
  const [first, second] = await Promise.all([post(db, a.body), post(db, b.body)])
  const statuses = [first.res.status, second.res.status].sort()
  assert.deepEqual(statuses, [201, 409], 'exactly one should win')
  assert.equal(db.size(), 1)
})

test('rejects bad usernames and emails', async () => {
  const db = makeDb()
  for (const username of ['ab', '-bad', 'has space', 'UPPER', 'MiXed', 'x'.repeat(25), 'admin', 'support']) {
    const { body } = await signed({ username })
    // 400, not 401: these must be refused on their own terms, before the
    // signature is even considered.
    assert.equal((await post(db, body)).res.status, 400, `${username} should be refused`)
  }
  const { body } = await signed({ email: 'nope' })
  assert.equal((await post(db, body)).res.status, 400)
})

test('reports availability, including reserved names', async () => {
  const db = makeDb()
  await post(db, (await signed({ username: 'claimed' })).body)
  const ask = async (u) => {
    const res = await handleRequest(db, new Request(`https://api.goldfelty.com/v1/accounts/username-available?username=${u}`))
    return res.json()
  }
  assert.equal((await ask('claimed')).available, false)
  assert.equal((await ask('free')).available, true)
  assert.equal((await ask('admin')).available, false)
  assert.equal((await ask('--')).available, false)
})

test('returns only an id, a username and the reporting token', async () => {
  const db = makeDb()
  const { json } = await post(db, (await signed()).body)
  assert.deepEqual(Object.keys(json).sort(), ['id', 'token', 'username'])
})

test('handles malformed bodies and unknown routes', async () => {
  const db = makeDb()
  const bad = await handleRequest(db, new Request('https://api.goldfelty.com/v1/accounts', {
    method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' }
  }))
  assert.equal(bad.status, 400)
  const missing = await handleRequest(db, new Request('https://api.goldfelty.com/nope'))
  assert.equal(missing.status, 404)
  const health = await handleRequest(db, new Request('https://api.goldfelty.com/health'))
  assert.equal(health.status, 200)
})

test('answers CORS preflight for the site only', async () => {
  const db = makeDb()
  const res = await handleRequest(db, new Request('https://api.goldfelty.com/v1/accounts', { method: 'OPTIONS' }))
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://goldfelty.com')
})

test('username rules are shared, not duplicated', () => {
  assert.equal(usernameProblem('alice'), null)
  assert.match(usernameProblem('ab'), /3 to 24/)
  assert.match(usernameProblem('admin'), /reserved/)
})

/** The same Map database, counting rate-limit hits like D1 does. */
function makeLimitedDb() {
  const db = makeDb()
  const hits = new Map()
  db.hit = async (key, window) => {
    const k = `${key}|${window}`
    hits.set(k, (hits.get(k) ?? 0) + 1)
    return hits.get(k)
  }
  return db
}

function fromIp(ip, path, init = {}) {
  return new Request(`https://api.goldfelty.com${path}`, { ...init, headers: { 'cf-connecting-ip': ip, ...(init.headers ?? {}) } })
}

test('rate-limits registrations per caller, not globally', async () => {
  const db = makeLimitedDb()
  const now = Date.now()
  const attempt = (ip) =>
    handleRequest(db, fromIp(ip, '/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), now)
  for (let i = 0; i < 10; i++) assert.equal((await attempt('198.51.100.1')).status, 400)
  const blocked = await attempt('198.51.100.1')
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  assert.equal((await attempt('198.51.100.2')).status, 400, 'another caller is unaffected')
})

test('rate-limits username lookups', async () => {
  const db = makeLimitedDb()
  const now = Date.now()
  let last
  for (let i = 0; i < 121; i++) last = await handleRequest(db, fromIp('203.0.113.9', '/v1/accounts/username-available?username=bob'), now)
  assert.equal(last.status, 429)
})

test('refuses oversized and non-JSON bodies before parsing them', async () => {
  const db = makeDb()
  const big = await handleRequest(
    db,
    new Request('https://api.goldfelty.com/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5000) })
  )
  assert.equal(big.status, 413)
  const form = await handleRequest(
    db,
    new Request('https://api.goldfelty.com/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })
  )
  assert.equal(form.status, 415)
})

test('refuses loosely formatted timestamps and signatures', async () => {
  const db = makeDb()
  const { body } = await signed({ issuedAt: new Date().toUTCString() })
  assert.equal((await post(db, body)).res.status, 400)
  const { body: second } = await signed({ signature: '0x1234' })
  assert.equal((await post(db, second)).res.status, 400)
})

test('sends hardening headers on every response', async () => {
  const res = await handleRequest(makeDb(), new Request('https://api.goldfelty.com/health'))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(res.headers.get('strict-transport-security'), /max-age=/)
})


/* ---- reports and the owner's stats ---------------------------------------- */

const ADMIN = 'a'.repeat(48)

function authed(path, token, init = {}) {
  return new Request(`https://api.goldfelty.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
  })
}

test('registration hands back a reporting token, and re-linking replaces it', async () => {
  const db = makeDb()
  const { body, wallet } = await signed()
  const first = await post(db, body)
  assert.match(first.json.token, /^[A-Za-z0-9_-]{43}$/)
  const { body: again } = await signed({}, wallet)
  const second = await post(db, again)
  assert.notEqual(second.json.token, first.json.token)
  const stale = await handleRequest(db, authed('/v1/reports', first.json.token, { method: 'POST', body: JSON.stringify({ value: 1, currency: 'USD', wallets: 1 }) }))
  assert.equal(stale.status, 401, 'the old token stops working')
})

test('a signed-in user can share a total, and withdraw it', async () => {
  const db = makeDb()
  const { body } = await signed()
  const { json } = await post(db, body)
  const ok = await handleRequest(db, authed('/v1/reports', json.token, { method: 'POST', body: JSON.stringify({ value: 1234.5, currency: 'EUR', wallets: 3 }) }))
  assert.equal(ok.status, 204)
  assert.equal(db.reports.get(json.id).value, 1234.5)
  const gone = await handleRequest(db, authed('/v1/reports', json.token, { method: 'DELETE' }))
  assert.equal(gone.status, 204)
  assert.equal(db.reports.size, 0)
})

test('reports are validated and need a real token', async () => {
  const db = makeDb()
  const { body } = await signed()
  const { json } = await post(db, body)
  const send = (b, token = json.token) => handleRequest(db, authed('/v1/reports', token, { method: 'POST', body: JSON.stringify(b) }))
  assert.equal((await send({ value: 1, currency: 'USD', wallets: 1 }, 'x'.repeat(43))).status, 401)
  assert.equal((await send({ value: -1, currency: 'USD', wallets: 1 })).status, 400)
  assert.equal((await send({ value: 1e13, currency: 'USD', wallets: 1 })).status, 400)
  assert.equal((await send({ value: 1, currency: 'BTC', wallets: 1 })).status, 400)
  assert.equal((await send({ value: 1, currency: 'USD', wallets: 1.5 })).status, 400)
})

test('the owner’s stats need the admin token, and are off until one is set', async () => {
  const db = makeDb()
  const req = (token) => new Request('https://api.goldfelty.com/v1/admin/stats', { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await handleRequest(db, req(ADMIN), Date.now(), {})).status, 503)
  assert.equal((await handleRequest(db, req(ADMIN), Date.now(), { adminToken: 'short' })).status, 503)
  assert.equal((await handleRequest(db, req('b'.repeat(48)), Date.now(), { adminToken: ADMIN })).status, 401)
  const ok = await handleRequest(db, req(ADMIN), Date.now(), { adminToken: ADMIN })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).users, 0)
})

test('a user token is not an admin token', async () => {
  const db = makeDb()
  const { body } = await signed()
  const { json } = await post(db, body)
  const res = await handleRequest(db, authed('/v1/admin/stats', json.token), Date.now(), { adminToken: ADMIN })
  assert.equal(res.status, 401)
})

test('a 16-character admin token works, and guessing is cut off after 10 tries in 15 minutes', async () => {
  const db = makeDb()
  const sixteen = 'Abcdefgh123456!?'
  const req = (token) => new Request('https://api.goldfelty.com/v1/admin/stats', { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await handleRequest(db, req(sixteen.slice(0, 15)), Date.now(), { adminToken: sixteen.slice(0, 15) })).status, 503, '15 characters is too short')
  assert.equal((await handleRequest(db, req(sixteen), Date.now(), { adminToken: sixteen })).status, 200)

  const guesser = makeLimitedDb()
  const now = Date.now()
  for (let i = 0; i < 10; i++) assert.equal((await handleRequest(guesser, req(`wrong-guess-${i}xx`), now, { adminToken: sixteen })).status, 401)
  assert.equal((await handleRequest(guesser, req(sixteen), now, { adminToken: sixteen })).status, 429, 'even the right token waits once the limit is hit')
  assert.equal((await handleRequest(guesser, req(sixteen), now + 15 * 60_000 + 1, { adminToken: sixteen })).status, 200, 'and works again after the window')
})
