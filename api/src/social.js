import { json, bearer, sameString, sha256hex, randomToken, rateLimit, MIN_ADMIN_TOKEN, SECURITY_HEADERS } from './accounts.js'

/**
 * Goldfelty's social autopilot, server side.
 *
 * The autopilot itself (social/ in this repository) runs on a schedule in
 * GitHub Actions. This Worker is where its state lives between runs, and
 * where the owner manages it from goldfelty.com/admin/social/:
 *
 *   - settings and API keys, account sign-ins and pending OAuth states are
 *     encrypted (AES-256-GCM, key derived from ADMIN_TOKEN) before they
 *     reach D1;
 *   - X, Reddit and YouTube are connected here: the dashboard asks for a
 *     sign-in link, the platform redirects back to /v1/social/callback/...,
 *     and the tokens are stored for the runner;
 *   - the runner (with the admin token) downloads everything at the start
 *     of a run and uploads the queue, its state and refreshed sign-ins.
 *
 * Every /v1/admin/social endpoint needs the admin token.
 */

export const PLATFORMS = {
  x: {
    label: 'X',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scope: 'tweet.read tweet.write users.read media.write offline.access',
    pkce: true,
    authParams: {}
  },
  reddit: {
    label: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scope: 'identity submit read mysubreddits',
    pkce: false,
    authParams: { duration: 'permanent' }
  },
  youtube: {
    label: 'YouTube',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    pkce: true,
    authParams: { access_type: 'offline', prompt: 'consent' }
  }
}
const PLATFORM_IDS = Object.keys(PLATFORMS)

const API_ORIGIN = 'https://api.goldfelty.com'
const DASHBOARD = 'https://goldfelty.com/admin/social/'
export const callbackUrl = (platform) => `${API_ORIGIN}/v1/social/callback/${platform}`

/** What the dashboard may change, and how each value is checked. */
const SECRET = 'secret'
const FIELDS = {
  anthropicApiKey: SECRET,
  timezone: 'timezone',
  'x.clientId': 'id',
  'x.clientSecret': SECRET,
  'x.dailyCap': 'cap3',
  'x.windows': 'windows',
  'reddit.clientId': 'id',
  'reddit.clientSecret': SECRET,
  'reddit.dailyCap': 'cap1',
  'reddit.windows': 'windows',
  'youtube.clientId': 'id',
  'youtube.clientSecret': SECRET,
  'youtube.privacyStatus': 'privacy',
  'youtube.windows': 'windows',
  'video.auto': 'bool',
  'video.tts': 'tts',
  'video.openaiApiKey': SECRET,
  'video.elevenlabsApiKey': SECRET
}
const SECRET_FIELDS = Object.keys(FIELDS).filter((k) => FIELDS[k] === SECRET)

export const MAX_STATE_BYTES = 1_500_000
const MAX_FACTS = 20_000
const LOG_LINES = 300
const RUNS_KEPT = 60
const OAUTH_TTL_MS = 15 * 60_000

// ---- encryption -----------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s)
const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function sealingKey(adminToken) {
  const ikm = await crypto.subtle.importKey('raw', enc(adminToken), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('goldfelty-social-v1'), info: enc('social_kv') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc(JSON.stringify(value))))
  return `v1.${b64(iv)}.${b64(ct)}`
}

export async function unseal(key, text) {
  const [v, iv, ct] = String(text).split('.')
  if (v !== 'v1' || !iv || !ct) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return null
  }
}

const isSealed = (name) => name === 'config' || name.startsWith('tokens:') || name.startsWith('oauth:')

function store(db, key) {
  return {
    async load(names) {
      const raw = await db.socialGet(names)
      const out = {}
      for (const name of names) {
        if (raw[name] === undefined) continue
        out[name] = isSealed(name) ? await unseal(key, raw[name]) : JSON.parse(raw[name])
      }
      return out
    },
    async save(name, value, now) {
      const text = isSealed(name) ? await seal(key, value) : JSON.stringify(value)
      await db.socialPut(name, text, new Date(now).toISOString())
    },
    remove: (name) => db.socialDelete(name)
  }
}

// ---- helpers ---------------------------------------------------------------

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj, path, value) {
  const keys = path.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}
  if (value === undefined) delete o[keys.at(-1)]
  else o[keys.at(-1)] = value
}

export function checkField(path, value) {
  const kind = FIELDS[path]
  if (!kind) return [null, `Unknown setting ${path}.`]
  switch (kind) {
    case SECRET:
    case 'id': {
      const v = String(value ?? '').trim()
      if (!v || v.length > 400 || /\s/.test(v)) return [null, `${path} doesn't look right.`]
      return [v]
    }
    case 'timezone':
      try {
        new Intl.DateTimeFormat('en', { timeZone: String(value) })
        return [String(value)]
      } catch {
        return [null, 'Unknown time zone.']
      }
    case 'cap3':
    case 'cap1': {
      const n = Number(value)
      const max = kind === 'cap3' ? 3 : 1
      if (!Number.isInteger(n) || n < 0 || n > max) return [null, `${path} is 0 to ${max}.`]
      return [n]
    }
    case 'windows': {
      const list = Array.isArray(value) ? value.map(String) : []
      const ok = list.length <= 6 && list.every((w) => {
        const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(w)
        if (!m) return false
        const a = m[1] * 60 + Number(m[2])
        const b = m[3] * 60 + Number(m[4])
        return m[2] < 60 && m[4] < 60 && a < b && b <= 1440
      })
      return ok ? [list] : [null, 'Posting windows look like 09:00-11:00.']
    }
    case 'privacy':
      return ['public', 'unlisted', 'private'].includes(value) ? [value] : [null, 'Visibility is public, unlisted or private.']
    case 'bool':
      return typeof value === 'boolean' ? [value] : [null, `${path} is on or off.`]
    case 'tts':
      return ['auto', 'openai', 'elevenlabs', 'none'].includes(value) ? [value] : [null, 'Unknown voice setting.']
  }
  return [null, `Unknown setting ${path}.`]
}

/** The settings with every secret replaced by whether it is set. */
export function redact(config = {}) {
  const out = structuredClone(config)
  for (const path of SECRET_FIELDS) {
    const v = getPath(config, path)
    setPath(out, path, v ? { set: true, ends: String(v).slice(-4) } : { set: false })
  }
  return out
}

function connection(t) {
  if (!t?.access_token) return { connected: false }
  return {
    connected: true,
    username: t.username || '',
    connectedAt: t.connectedAt || null,
    canRefresh: Boolean(t.refresh_token),
    error: t.error || null,
    moderated: t.moderated || undefined
  }
}

function itemText(i) {
  const c = i.content || {}
  if (i.kind === 'post') return c.text || ''
  if (i.kind === 'thread') return (c.tweets || []).join('\n\n')
  if (i.kind === 'self') return `${c.title || ''}\n\n${c.body || ''}`
  return `${c.title || ''}${c.premise ? `\n\n${c.premise}` : ''}`
}

/** What the dashboard shows of the queue: what's next, and what happened. */
export function queueView(queue) {
  const items = queue?.items || []
  const pick = (statuses, n, by) =>
    items
      .filter((i) => statuses.includes(i.status))
      .sort((a, b) => String(b[by] || b.updatedAt).localeCompare(String(a[by] || a.updatedAt)))
      .slice(0, n)
      .map((i) => ({
        id: i.id,
        platform: i.platform,
        kind: i.kind,
        status: i.status,
        text: itemText(i).slice(0, 1200),
        url: i.result?.url || null,
        metrics: i.metrics || null,
        note: i.note || null,
        error: i.error || null,
        at: i.postedAt || i.approvedAt || i.updatedAt || i.createdAt
      }))
  return {
    upcoming: pick(['approved', 'posting'], 30, 'approvedAt').reverse(),
    posted: pick(['posted'], 40, 'postedAt'),
    turnedDown: pick(['rejected', 'failed'], 20, 'updatedAt'),
    counts: items.reduce((m, i) => ({ ...m, [i.status]: (m[i.status] || 0) + 1 }), {})
  }
}

async function checkAdmin(request, adminToken) {
  if (typeof adminToken !== 'string' || adminToken.length < MIN_ADMIN_TOKEN) {
    return json(503, { message: 'Admin access is not set up.' })
  }
  const supplied = bearer(request)
  if (!supplied || !sameString(await sha256hex(supplied), await sha256hex(adminToken))) {
    return json(401, { message: 'Wrong admin token.' })
  }
  return null
}

async function readJson(request, limit) {
  if (!String(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return [null, json(415, { message: 'Send JSON.' })]
  }
  if (Number(request.headers.get('content-length') ?? 0) > limit) return [null, json(413, { message: 'Request too large.' })]
  const text = await request.text()
  if (text.length > limit) return [null, json(413, { message: 'Request too large.' })]
  try {
    return [JSON.parse(text), null]
  } catch {
    return [null, json(400, { message: 'Malformed request body.' })]
  }
}

// ---- OAuth -----------------------------------------------------------------

async function pkcePair() {
  const verifier = randomToken()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc(verifier)))
  const challenge = b64(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { verifier, challenge }
}

export function authorizeUrl(platform, config, { state, challenge }) {
  const def = PLATFORMS[platform]
  const url = new URL(def.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config[platform].clientId)
  url.searchParams.set('redirect_uri', callbackUrl(platform))
  url.searchParams.set('scope', def.scope)
  url.searchParams.set('state', state)
  if (def.pkce) {
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [k, v] of Object.entries(def.authParams)) url.searchParams.set(k, v)
  return url.toString()
}

const USER_AGENT = 'web:goldfelty-social:1.0 (by goldfelty.com)'

async function tokenExchange(platform, pc, params, fetchImpl) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  const body = new URLSearchParams(params)
  if (platform === 'reddit' || (platform === 'x' && pc.clientSecret)) {
    headers.authorization = 'Basic ' + btoa(`${pc.clientId}:${pc.clientSecret || ''}`)
  } else {
    body.set('client_id', pc.clientId)
    if (pc.clientSecret) body.set('client_secret', pc.clientSecret)
  }
  if (platform === 'reddit') headers['user-agent'] = USER_AGENT
  const res = await fetchImpl(PLATFORMS[platform].tokenUrl, { method: 'POST', headers, body: body.toString() })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `sign-in failed (${res.status})`)
  }
  return data
}

async function whoami(platform, accessToken, fetchImpl) {
  const auth = { authorization: `Bearer ${accessToken}` }
  if (platform === 'x') {
    const res = await fetchImpl('https://api.x.com/2/users/me', { headers: auth })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`couldn't read the X account (${res.status})`)
    return { username: data.data?.username || '' }
  }
  if (platform === 'reddit') {
    const headers = { ...auth, 'user-agent': USER_AGENT }
    const me = await fetchImpl('https://oauth.reddit.com/api/v1/me', { headers })
    const data = await me.json().catch(() => ({}))
    if (!me.ok) throw new Error(`couldn't read the Reddit account (${me.status})`)
    const mods = await fetchImpl('https://oauth.reddit.com/subreddits/mine/moderator?limit=100', { headers })
    const list = mods.ok ? await mods.json().catch(() => ({})) : {}
    return { username: data.name || '', moderated: (list.data?.children || []).map((c) => c.data.display_name) }
  }
  const res = await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: auth })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`couldn't read the YouTube channel (${res.status})`)
  const ch = data.items?.[0]
  if (!ch) throw new Error('this Google account has no YouTube channel yet')
  return { username: ch.snippet.title, channelId: ch.id }
}

function backToDashboard(params) {
  const url = new URL(DASHBOARD)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v).slice(0, 200))
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, location: url.toString() } })
}

export async function callback(kv, platform, url, now, fetchImpl) {
  const state = url.searchParams.get('state') || ''
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(state)) return backToDashboard({ platform, error: 'That sign-in link is out of date. Try Connect again.' })
  const key = `oauth:${state}`
  const { [key]: pending } = await kv.load([key])
  await kv.remove(key)
  if (!pending || pending.platform !== platform || now - pending.at > OAUTH_TTL_MS) {
    return backToDashboard({ platform, error: 'That sign-in link is out of date. Try Connect again.' })
  }
  if (url.searchParams.get('error')) {
    return backToDashboard({ platform, error: `${PLATFORMS[platform].label} said: ${url.searchParams.get('error')}` })
  }
  const code = url.searchParams.get('code')
  if (!code) return backToDashboard({ platform, error: 'No sign-in code came back.' })
  try {
    const { config = {} } = await kv.load(['config'])
    const pc = config[platform] || {}
    const params = { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(platform) }
    if (PLATFORMS[platform].pkce) params.code_verifier = pending.verifier
    const tok = await tokenExchange(platform, pc, params, fetchImpl)
    const who = await whoami(platform, tok.access_token, fetchImpl)
    await kv.save(
      `tokens:${platform}`,
      {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: now + (Number(tok.expires_in) || 3600) * 1000,
        scope: tok.scope,
        ...who,
        connectedAt: new Date(now).toISOString()
      },
      now
    )
    return backToDashboard({ platform, connected: who.username || 'yes' })
  } catch (error) {
    return backToDashboard({ platform, error: `Couldn't connect: ${error.message}` })
  }
}

// ---- requests ----------------------------------------------------------------

const ALL_KEYS = ['config', 'facts', 'control', 'queue', 'autopilot', 'log', 'runs', ...PLATFORM_IDS.map((p) => `tokens:${p}`)]

/**
 * Handles /v1/admin/social/... and /v1/social/callback/...; returns null for
 * anything else.
 */
export async function handleSocial(db, request, now = Date.now(), options = {}) {
  const url = new URL(request.url)
  const path = url.pathname
  const fetchImpl = options.fetch || fetch

  const cb = /^\/v1\/social\/callback\/(x|reddit|youtube)$/.exec(path)
  if (cb && request.method === 'GET') {
    const limited = await rateLimit(db, request, 'callback', now)
    if (limited) return limited
    if (typeof options.adminToken !== 'string' || options.adminToken.length < MIN_ADMIN_TOKEN) {
      return backToDashboard({ platform: cb[1], error: 'Admin access is not set up on the API.' })
    }
    return callback(store(db, await sealingKey(options.adminToken)), cb[1], url, now, fetchImpl)
  }

  if (!path.startsWith('/v1/admin/social')) return null
  const limited = await rateLimit(db, request, 'social', now)
  if (limited) return limited
  const denied = await checkAdmin(request, options.adminToken)
  if (denied) return denied
  const kv = store(db, await sealingKey(options.adminToken))
  const route = `${request.method} ${path.slice('/v1/admin/social'.length) || '/'}`

  // The dashboard's view: secrets redacted.
  if (route === 'GET /') {
    const v = await kv.load(ALL_KEYS)
    return json(200, {
      config: redact(v.config),
      facts: v.facts?.text ?? '',
      control: { paused: false, blocked: [], ...v.control },
      connections: Object.fromEntries(PLATFORM_IDS.map((p) => [p, connection(v[`tokens:${p}`])])),
      queue: queueView(v.queue),
      autopilot: v.autopilot || {},
      log: (v.log?.lines || []).slice(-100),
      runs: (v.runs?.list || []).slice(-30),
      callbacks: Object.fromEntries(PLATFORM_IDS.map((p) => [p, callbackUrl(p)]))
    })
  }

  if (route === 'PUT /config') {
    const [body, bad] = await readJson(request, 20_000)
    if (bad) return bad
    const { config = {} } = await kv.load(['config'])
    for (const [field, value] of Object.entries(body.set || {})) {
      const [clean, problem] = checkField(field, value)
      if (problem) return json(400, { message: problem })
      setPath(config, field, clean)
    }
    for (const field of body.clear || []) {
      if (!FIELDS[field]) return json(400, { message: `Unknown setting ${field}.` })
      setPath(config, field, undefined)
    }
    await kv.save('config', config, now)
    return json(200, { config: redact(config) })
  }

  if (route === 'PUT /facts') {
    const [body, bad] = await readJson(request, MAX_FACTS * 4)
    if (bad) return bad
    const text = String(body.text ?? '')
    if (text.length > MAX_FACTS) return json(400, { message: `Keep the facts under ${MAX_FACTS} characters.` })
    await kv.save('facts', { text, updatedAt: new Date(now).toISOString() }, now)
    return json(200, { ok: true })
  }

  if (route === 'POST /pause' || route === 'POST /resume') {
    const { control = {} } = await kv.load(['control'])
    control.paused = route === 'POST /pause'
    await kv.save('control', control, now)
    return json(200, { control: { paused: false, blocked: [], ...control } })
  }

  const remove = /^POST \/items\/([a-f0-9]{4,20})\/remove$/.exec(route)
  if (remove) {
    const { control = {} } = await kv.load(['control'])
    control.blocked = [...new Set([...(control.blocked || []), remove[1]])].slice(-500)
    await kv.save('control', control, now)
    return json(200, { control: { paused: false, ...control } })
  }

  const conn = /^POST \/(connect|disconnect)\/(x|reddit|youtube)$/.exec(route)
  if (conn) {
    const [, action, platform] = conn
    if (action === 'disconnect') {
      await kv.remove(`tokens:${platform}`)
      return json(200, { ok: true })
    }
    const { config = {} } = await kv.load(['config'])
    const pc = config[platform] || {}
    if (!pc.clientId) return json(400, { message: `Add the ${PLATFORMS[platform].label} client ID first.` })
    if (platform === 'youtube' && !pc.clientSecret) return json(400, { message: 'Add the YouTube client secret first.' })
    await db.socialSweep('oauth:', new Date(now - OAUTH_TTL_MS).toISOString())
    const state = randomToken()
    const { verifier, challenge } = await pkcePair()
    await kv.save(`oauth:${state}`, { platform, verifier, at: now }, now)
    return json(200, { url: authorizeUrl(platform, config, { state, challenge }) })
  }

  // ---- the runner ----
  if (route === 'GET /control') {
    const { control = {} } = await kv.load(['control'])
    return json(200, { paused: false, blocked: [], ...control })
  }

  if (route === 'GET /state') {
    const v = await kv.load(ALL_KEYS)
    return json(200, {
      config: v.config || {},
      facts: v.facts?.text ?? '',
      control: { paused: false, blocked: [], ...v.control },
      tokens: Object.fromEntries(PLATFORM_IDS.filter((p) => v[`tokens:${p}`]).map((p) => [p, v[`tokens:${p}`]])),
      queue: v.queue || { items: [] },
      autopilot: v.autopilot || {}
    })
  }

  if (route === 'PUT /state') {
    const [body, bad] = await readJson(request, MAX_STATE_BYTES)
    if (bad) return bad
    if (body.queue) {
      if (!Array.isArray(body.queue.items)) return json(400, { message: 'queue.items must be a list.' })
      await kv.save('queue', { items: body.queue.items }, now)
    }
    if (body.autopilot && typeof body.autopilot === 'object') await kv.save('autopilot', body.autopilot, now)
    // Sign-ins: only replace the one the runner started with. If the owner
    // reconnected or disconnected meanwhile, theirs wins.
    const skipped = []
    for (const [platform, rec] of Object.entries(body.tokens || {})) {
      if (!PLATFORMS[platform]) continue
      const name = `tokens:${platform}`
      const { [name]: current } = await kv.load([name])
      if (!current || current.connectedAt !== rec.connectedAt) {
        skipped.push(platform)
        continue
      }
      await kv.save(name, rec, now)
    }
    if (body.facts && typeof body.facts === 'string') {
      const { facts } = await kv.load(['facts'])
      if (!facts?.text) await kv.save('facts', { text: body.facts.slice(0, MAX_FACTS), updatedAt: new Date(now).toISOString() }, now)
    }
    if (Array.isArray(body.log) && body.log.length) {
      const { log = { lines: [] } } = await kv.load(['log'])
      const stamp = new Date(now).toISOString()
      log.lines = [...log.lines, ...body.log.slice(-100).map((line) => ({ at: stamp, line: String(line).slice(0, 500) }))].slice(-LOG_LINES)
      await kv.save('log', log, now)
    }
    if (body.run && typeof body.run === 'object') {
      const { runs = { list: [] } } = await kv.load(['runs'])
      runs.list = [...runs.list, { ...body.run, at: new Date(now).toISOString() }].slice(-RUNS_KEPT)
      await kv.save('runs', runs, now)
    }
    return json(200, { ok: true, skipped })
  }

  return json(404, { message: 'Not found.' })
}
