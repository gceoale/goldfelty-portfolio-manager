import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker, { d1 } from '../src/worker.js'
import { handleSocial, seal, unseal, sealingKey, checkField, redact, queueView, callbackUrl } from '../src/social.js'

const ADMIN = 'correct-horse-battery-staple-42'

function fakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  return {
    raw: db,
    prepare(sql) {
      let args = []
      const stmt = db.prepare(sql)
      return {
        bind(...values) { args = values; return this },
        async first() { return stmt.get(...args) ?? null },
        async run() { stmt.run(...args); return { success: true } },
        async all() { return { results: stmt.all(...args) } }
      }
    }
  }
}

function setup(fetchImpl) {
  const database = fakeD1()
  const db = d1(database)
  const call = async (method, path, { body, token = ADMIN, now = Date.now(), ip = '1.2.3.4' } = {}) => {
    const headers = { 'cf-connecting-ip': ip }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const req = new Request(`https://api.goldfelty.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const res = await handleSocial(db, req, now, { adminToken: ADMIN, fetch: fetchImpl })
    const text = res ? await res.text() : ''
    return { res, status: res?.status, body: text ? JSON.parse(text) : null, location: res?.headers.get('location') }
  }
  return { database, db, call }
}

test('sealed values round-trip and fail closed with the wrong key', async () => {
  const k = await sealingKey(ADMIN)
  const sealed = await seal(k, { secret: 'sk-ant-123' })
  assert.doesNotMatch(sealed, /sk-ant/)
  assert.deepEqual(await unseal(k, sealed), { secret: 'sk-ant-123' })
  assert.equal(await unseal(await sealingKey('another-admin-token-xyz'), sealed), null)
  assert.equal(await unseal(k, 'garbage'), null)
})

test('everything needs the admin token, and other paths fall through', async () => {
  const { call } = setup()
  assert.equal((await call('GET', '/v1/admin/social', { token: null })).status, 401)
  assert.equal((await call('GET', '/v1/admin/social', { token: 'wrong-token-but-long-enough' })).status, 401)
  assert.equal((await call('GET', '/v1/admin/social')).status, 200)
  assert.equal((await call('GET', '/v1/health')).res, null)
})

test('settings are checked, secrets are encrypted at rest and never sent back', async () => {
  const { call, database } = setup()
  let r = await call('PUT', '/v1/admin/social/config', {
    body: { set: { anthropicApiKey: 'sk-ant-secret-9999', 'x.clientId': 'abc123', 'x.clientSecret': 'xsecret-7777', timezone: 'America/New_York', 'x.windows': ['09:00-11:00'], 'video.auto': true } }
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.config.anthropicApiKey, { set: true, ends: '9999' })
  assert.equal(r.body.config.x.clientId, 'abc123')
  const raw = database.raw.prepare("SELECT value FROM social_kv WHERE key = 'config'").get().value
  assert.doesNotMatch(raw, /sk-ant|xsecret|abc123/)

  r = await call('GET', '/v1/admin/social')
  assert.doesNotMatch(JSON.stringify(r.body), /sk-ant-secret|xsecret-7777/)
  assert.equal(r.body.config.timezone, 'America/New_York')

  for (const bad of [{ 'x.dailyCap': 9 }, { 'reddit.dailyCap': 2 }, { timezone: 'Mars/Base' }, { 'x.windows': ['25:00-26:00'] }, { evil: 1 }, { 'x.clientId': 'has space' }]) {
    assert.equal((await call('PUT', '/v1/admin/social/config', { body: { set: bad } })).status, 400, JSON.stringify(bad))
  }
  r = await call('PUT', '/v1/admin/social/config', { body: { clear: ['anthropicApiKey'] } })
  assert.deepEqual(r.body.config.anthropicApiKey, { set: false })
})

test('connecting: a sign-in link, then the callback stores the account', async () => {
  const fetched = []
  const fetchImpl = async (url, init = {}) => {
    fetched.push({ url: String(url), init })
    if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 7200, scope: 'tweet.write' })
    if (String(url).endsWith('/users/me')) return Response.json({ data: { username: 'goldfelty' } })
    return new Response('nope', { status: 404 })
  }
  const { call, database } = setup(fetchImpl)
  assert.equal((await call('POST', '/v1/admin/social/connect/x')).status, 400)
  await call('PUT', '/v1/admin/social/config', { body: { set: { 'x.clientId': 'cid', 'x.clientSecret': 'csecret' } } })
  const r = await call('POST', '/v1/admin/social/connect/x')
  const auth = new URL(r.body.url)
  assert.equal(auth.origin + auth.pathname, 'https://x.com/i/oauth2/authorize')
  assert.equal(auth.searchParams.get('redirect_uri'), callbackUrl('x'))
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  const state = auth.searchParams.get('state')

  // A wrong state changes nothing.
  let cb = await call('GET', `/v1/social/callback/x?state=${'z'.repeat(43)}&code=evil`, { token: null })
  assert.equal(cb.status, 302)
  assert.match(cb.location, /error=/)

  cb = await call('GET', `/v1/social/callback/x?state=${state}&code=good`, { token: null })
  assert.match(cb.location, /^https:\/\/goldfelty\.com\/admin\/social\/\?platform=x&connected=goldfelty$/)
  const tokenCall = fetched.find((f) => f.url.endsWith('/oauth2/token'))
  assert.equal(tokenCall.init.headers.authorization, 'Basic ' + btoa('cid:csecret'))
  const sent = new URLSearchParams(tokenCall.init.body)
  assert.equal(sent.get('code'), 'good')
  assert.ok(sent.get('code_verifier'))

  // The state is single use.
  cb = await call('GET', `/v1/social/callback/x?state=${state}&code=good`, { token: null })
  assert.match(cb.location, /out%20of%20date|out\+of\+date/)

  const view = await call('GET', '/v1/admin/social')
  assert.equal(view.body.connections.x.connected, true)
  assert.equal(view.body.connections.x.username, 'goldfelty')
  assert.doesNotMatch(JSON.stringify(view.body), /"AT"|"RT"/)
  const raw = database.raw.prepare("SELECT value FROM social_kv WHERE key = 'tokens:x'").get().value
  assert.doesNotMatch(raw, /AT|RT|goldfelty/)

  const state2 = await call('GET', '/v1/admin/social/state')
  assert.equal(state2.body.tokens.x.access_token, 'AT')
  assert.equal(state2.body.config.x.clientSecret, 'csecret')

  await call('POST', '/v1/admin/social/disconnect/x')
  assert.equal((await call('GET', '/v1/admin/social')).body.connections.x.connected, false)
})

test('an expired sign-in link is refused', async () => {
  const { call } = setup(async () => Response.json({}))
  await call('PUT', '/v1/admin/social/config', { body: { set: { 'reddit.clientId': 'rid' } } })
  const now = Date.now()
  const r = await call('POST', '/v1/admin/social/connect/reddit', { now })
  const url = new URL(r.body.url)
  assert.equal(url.searchParams.get('duration'), 'permanent')
  const cb = await call('GET', `/v1/social/callback/reddit?state=${url.searchParams.get('state')}&code=c`, { token: null, now: now + 16 * 60_000 })
  assert.match(cb.location, /error=/)
})

test('the runner syncs state; a sign-in changed meanwhile is not overwritten', async () => {
  const fetchImpl = async (url) =>
    String(url).includes('token') ? Response.json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 }) : Response.json({ data: { username: 'gf' } })
  const { call } = setup(fetchImpl)
  await call('PUT', '/v1/admin/social/config', { body: { set: { 'x.clientId': 'cid' } } })
  const link = new URL((await call('POST', '/v1/admin/social/connect/x')).body.url)
  await call('GET', `/v1/social/callback/x?state=${link.searchParams.get('state')}&code=c`, { token: null })

  const start = (await call('GET', '/v1/admin/social/state')).body
  const refreshed = { ...start.tokens.x, access_token: 'A2', refresh_token: 'R2' }
  let r = await call('PUT', '/v1/admin/social/state', {
    body: {
      queue: { items: [{ id: 'abc123', platform: 'x', kind: 'post', status: 'posted', content: { text: 'Hello' }, result: { url: 'https://x.com/i/web/status/1' }, postedAt: new Date().toISOString() }] },
      autopilot: { lastGeneratedAt: 'now' },
      tokens: { x: refreshed },
      log: ['Posted to x'],
      run: { ok: true, summary: '1 posted' },
      facts: 'Default facts'
    }
  })
  assert.deepEqual(r.body.skipped, [])
  let view = (await call('GET', '/v1/admin/social')).body
  assert.equal(view.queue.posted[0].url, 'https://x.com/i/web/status/1')
  assert.equal(view.log.at(-1).line, 'Posted to x')
  assert.equal(view.runs.at(-1).summary, '1 posted')
  assert.equal(view.facts, 'Default facts')
  assert.equal((await call('GET', '/v1/admin/social/state')).body.tokens.x.access_token, 'A2')

  // The owner's facts are never replaced by the runner's default.
  await call('PUT', '/v1/admin/social/facts', { body: { text: 'Owner facts' } })
  await call('PUT', '/v1/admin/social/state', { body: { facts: 'Default facts' } })
  assert.equal((await call('GET', '/v1/admin/social')).body.facts, 'Owner facts')

  // Reconnected meanwhile: the runner's stale copy is skipped.
  const link2 = new URL((await call('POST', '/v1/admin/social/connect/x')).body.url)
  await call('GET', `/v1/social/callback/x?state=${link2.searchParams.get('state')}&code=c`, { token: null, now: Date.now() + 5000 })
  r = await call('PUT', '/v1/admin/social/state', { body: { tokens: { x: { ...refreshed, access_token: 'STALE' } } } })
  assert.deepEqual(r.body.skipped, ['x'])
  assert.equal((await call('GET', '/v1/admin/social/state')).body.tokens.x.access_token, 'A1')
})

test('pause, resume and pulling an item before it posts', async () => {
  const { call } = setup()
  assert.equal((await call('POST', '/v1/admin/social/pause')).body.control.paused, true)
  assert.equal((await call('GET', '/v1/admin/social/control')).body.paused, true)
  await call('POST', '/v1/admin/social/resume')
  await call('POST', '/v1/admin/social/items/abc123/remove')
  const c = (await call('GET', '/v1/admin/social/control')).body
  assert.equal(c.paused, false)
  assert.deepEqual(c.blocked, ['abc123'])
  assert.equal((await call('POST', '/v1/admin/social/items/../remove')).status, 404)
})

test('field checks and redaction', () => {
  assert.deepEqual(checkField('x.dailyCap', 2), [2])
  assert.equal(checkField('youtube.privacyStatus', 'secret-ish')[1], 'Visibility is public, unlisted or private.')
  assert.deepEqual(redact({ x: { clientSecret: 'xs-abcd1234' } }).x.clientSecret, { set: true, ends: '1234' })
  assert.equal(redact({ video: { elevenlabsApiKey: 'old-key-1' } }).video.elevenlabsApiKey, undefined)
})

test('the queue view shows what is next and what happened', () => {
  const v = queueView({
    items: [
      { id: 'a', platform: 'x', kind: 'post', status: 'approved', approvedAt: '2026-10-27T09:00:00Z', content: { text: 'next' } },
      { id: 'b', platform: 'x', kind: 'post', status: 'posted', postedAt: '2026-10-27T08:00:00Z', content: { text: 'done' }, result: { url: 'u' }, metrics: { likes: 3 } },
      { id: 'c', platform: 'reddit', kind: 'self', status: 'rejected', content: { title: 'T', body: 'B' }, note: 'dull' }
    ]
  })
  assert.equal(v.upcoming[0].text, 'next')
  assert.equal(v.posted[0].metrics.likes, 3)
  assert.equal(v.turnedDown[0].note, 'dull')
  assert.deepEqual(v.counts, { approved: 1, posted: 1, rejected: 1 })
})

test('the deployed Worker routes social requests and answers CORS preflight for PUT', async () => {
  const database = fakeD1()
  const env = { DB: database, ADMIN_TOKEN: ADMIN }
  const pre = await worker.fetch(new Request('https://api.goldfelty.com/v1/admin/social/config', { method: 'OPTIONS' }), env)
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/)
  const res = await worker.fetch(new Request('https://api.goldfelty.com/v1/admin/social', { headers: { authorization: `Bearer ${ADMIN}` } }), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://goldfelty.com')
  assert.equal((await worker.fetch(new Request('https://api.goldfelty.com/v1/health'), env)).status, 200)
})
