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

test('returns only an id and a username', async () => {
  const db = makeDb()
  const { json } = await post(db, (await signed()).body)
  assert.deepEqual(Object.keys(json).sort(), ['id', 'username'])
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
