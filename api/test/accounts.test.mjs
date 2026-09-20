import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gf-api-'))

const { handle } = await import('../src/server.js')

const server = createServer(handle)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

test.after(() => {
  server.close()
  rmSync(process.env.DATA_DIR, { recursive: true, force: true })
})

function statement({ username, email, address, issuedAt }) {
  return [
    'Goldfelty account registration',
    `username: ${username}`,
    `email: ${email}`,
    `address: ${address}`,
    `issued: ${issuedAt}`
  ].join('\n')
}

async function register(overrides = {}, wallet = Wallet.createRandom()) {
  const body = {
    username: `user${Math.random().toString(36).slice(2, 8)}`,
    email: 'someone@example.com',
    address: wallet.address,
    issuedAt: new Date().toISOString(),
    ...overrides
  }
  body.signature = overrides.signature ?? (await wallet.signMessage(statement(body)))
  const res = await fetch(`${base}/v1/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { res, json: await res.json(), body, wallet }
}

test('registers an account when the signature checks out', async () => {
  const { res, json, body } = await register()
  assert.equal(res.status, 201)
  assert.match(json.id, /^gf_/)
  assert.equal(json.username, body.username)
})

test('rejects a signature from a different key', async () => {
  const impostor = Wallet.createRandom()
  const victim = Wallet.createRandom()
  const issuedAt = new Date().toISOString()
  const body = { username: 'claimed', email: 'a@b.co', address: victim.address, issuedAt }
  // Signed by the impostor, claiming the victim's address.
  const signature = await impostor.signMessage(statement(body))
  const { res, json } = await register({ ...body, signature }, victim)
  assert.equal(res.status, 401)
  assert.match(json.message, /does not match/)
})

test('rejects a signature over different content', async () => {
  const wallet = Wallet.createRandom()
  const issuedAt = new Date().toISOString()
  const signed = { username: 'alice', email: 'a@b.co', address: wallet.address, issuedAt }
  const signature = await wallet.signMessage(statement(signed))
  // Same signature, different username: the statement no longer matches.
  const { res } = await register({ ...signed, username: 'bob', signature }, wallet)
  assert.equal(res.status, 401)
})

test('refuses a stale registration', async () => {
  const issuedAt = new Date(Date.now() - 20 * 60_000).toISOString()
  const { res, json } = await register({ issuedAt })
  assert.equal(res.status, 400)
  assert.match(json.message, /too old/)
})

test('refuses one dated in the future', async () => {
  const issuedAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const { res, json } = await register({ issuedAt })
  assert.equal(res.status, 400)
  assert.match(json.message, /future/)
})

test('refuses a taken username', async () => {
  const first = await register({ username: 'taken' })
  assert.equal(first.res.status, 201)
  const second = await register({ username: 'taken' })
  assert.equal(second.res.status, 409)
})

test('re-registering the same address returns the existing account', async () => {
  const wallet = Wallet.createRandom()
  const first = await register({ username: 'stable' }, wallet)
  assert.equal(first.res.status, 201)
  // The app re-links after being offline; that must not be an error.
  const again = await register({ username: 'different' }, wallet)
  assert.equal(again.res.status, 200)
  assert.equal(again.json.username, 'stable')
})

test('validates usernames and emails', async () => {
  for (const username of ['ab', '-bad', 'has space', 'UPPER', 'x'.repeat(25)]) {
    const { res } = await register({ username })
    assert.equal(res.status, 400, `${username} should be refused`)
  }
  const { res } = await register({ email: 'nope' })
  assert.equal(res.status, 400)
})

test('reports username availability', async () => {
  await register({ username: 'claimedname' })
  const taken = await (await fetch(`${base}/v1/accounts/username-available?username=claimedname`)).json()
  assert.equal(taken.available, false)
  const free = await (await fetch(`${base}/v1/accounts/username-available?username=freename`)).json()
  assert.equal(free.available, true)
  const bad = await (await fetch(`${base}/v1/accounts/username-available?username=--`)).json()
  assert.equal(bad.available, false)
})

test('never echoes anything secret back', async () => {
  const { json } = await register()
  assert.deepEqual(Object.keys(json).sort(), ['id', 'username'])
})

test('health check answers', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 200)
})
