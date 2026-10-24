import { recoverAddress, checksumAddress, isAddress } from './verify.js'

/**
 * Account registration, independent of where it runs.
 *
 * Storage arrives as a `db` object so this can be tested against a plain Map
 * and deployed against D1 without the logic knowing the difference.
 *
 * Nothing secret is posted here: no passwords, no key material. Whoever is
 * claiming a username proves they control an address by signing a statement.
 * If this service were compromised the worst case is a wrong username, not
 * lost funds.
 */

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** How stale a signed registration may be, limiting replay of a captured body. */
export const MAX_AGE_MS = 10 * 60_000

/** A registration body is a few hundred bytes. Anything far larger is not one. */
export const MAX_BODY_BYTES = 4096

/**
 * Per-IP limits, counted in fixed windows in D1. IPs are stored only as a
 * SHA-256 hash. The database's unique indexes remain what actually prevents
 * double claims; this just keeps anyone from hammering the endpoints.
 */
export const LIMITS = {
  register: { max: 10, windowMs: 60 * 60_000 },
  check: { max: 120, windowMs: 60_000 },
  report: { max: 30, windowMs: 60 * 60_000 },
  admin: { max: 60, windowMs: 60_000 }
}

/** Currencies the app reports totals in. */
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'])

/** Names nobody gets to claim, because they read as official. */
const RESERVED = new Set([
  'admin', 'support', 'goldfelty', 'help', 'root', 'system',
  'security', 'billing', 'api', 'www', 'team', 'official'
])

export function statementFor({ username, email, address, issuedAt }) {
  return [
    'Goldfelty account registration',
    `username: ${username}`,
    `email: ${email}`,
    `address: ${address}`,
    `issued: ${issuedAt}`
  ].join('\n')
}

export function usernameProblem(username) {
  if (typeof username !== 'string') return 'Missing username.'
  if (username.length < 3 || username.length > 24) return 'Usernames are 3 to 24 characters.'
  // Tested as sent, not lowercased first. The signature covers the exact
  // string the client supplied, so normalising it here would mean verifying
  // something the client never signed.
  if (username !== username.toLowerCase()) return 'Usernames must be lowercase.'
  if (!USERNAME_RE.test(username)) return 'Use lowercase letters, numbers, hyphens and underscores.'
  if (RESERVED.has(username)) return 'That username is reserved.'
  return null
}

const SECURITY_HEADERS = {
  'access-control-allow-origin': 'https://goldfelty.com',
  vary: 'origin',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY'
}

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...extra }
  })

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Compare two strings without an early exit, so timing says nothing. */
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearer(request) {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header)
  return match ? match[1] : null
}

/**
 * A fresh token for the app to report with, replacing any earlier one. Only
 * its hash is stored, so a copy of the database can't be used to report.
 */
async function issueToken(db, accountId) {
  const token = randomToken()
  await db.setToken(accountId, await sha256hex(token))
  return token
}

async function accountFromToken(db, request) {
  const token = bearer(request)
  if (!token) return null
  return db.findByTokenHash(await sha256hex(token))
}

/** Returns a 429 response when `kind` is over its limit for this caller, else null. */
async function rateLimit(db, request, kind, now) {
  if (typeof db.hit !== 'function') return null
  const { max, windowMs } = LIMITS[kind]
  const window = Math.floor(now / windowMs)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const count = await db.hit(`${kind}:${await sha256hex(ip)}`, window)
  if (count <= max) return null
  const retryAfter = Math.ceil(((window + 1) * windowMs - now) / 1000)
  return json(429, { message: 'Too many requests. Try again later.' }, { 'retry-after': String(retryAfter) })
}

export async function checkUsername(db, raw) {
  // Typing is not signing, so a lookup may be forgiving about case.
  const username = String(raw ?? '').toLowerCase()
  const problem = usernameProblem(username)
  if (problem) return json(200, { available: false, reason: problem })
  const taken = await db.findByUsername(username)
  return json(200, { available: !taken })
}

export async function register(db, body, now = Date.now()) {
  if (!body || typeof body !== 'object') return json(400, { message: 'Malformed request body.' })

  const problem = usernameProblem(body.username)
  if (problem) return json(400, { message: problem })
  if (typeof body.email !== 'string' || body.email.length > 254 || !EMAIL_RE.test(body.email)) {
    return json(400, { message: 'Enter a valid email address.' })
  }
  if (!isAddress(body.address)) return json(400, { message: 'That is not a valid address.' })
  if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
    return json(400, { message: 'Missing or malformed signature.' })
  }
  // The exact ISO form the app sends; Date.parse alone accepts too much.
  if (typeof body.issuedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(body.issuedAt)) {
    return json(400, { message: 'issuedAt is not a timestamp.' })
  }

  const issued = Date.parse(body.issuedAt)
  if (!Number.isFinite(issued)) return json(400, { message: 'issuedAt is not a timestamp.' })
  if (now - issued > MAX_AGE_MS) return json(400, { message: 'This registration is too old. Try again.' })
  // A minute of slack for clock skew, but not an open door to future-dating.
  if (issued - now > 60_000) return json(400, { message: 'issuedAt is in the future.' })

  // Already known lowercase, so this is the exact string the client signed.
  const username = body.username
  const address = checksumAddress(body.address)

  let signer
  try {
    signer = recoverAddress(statementFor({ ...body, username, address }), body.signature)
  } catch {
    return json(400, { message: 'The signature could not be read.' })
  }
  if (signer !== address) return json(401, { message: 'That signature does not match the address.' })

  // The app re-registers whenever it re-links after being offline, so an
  // address that already has an account gets it back rather than an error.
  const existing = await db.findByAddress(address)
  if (existing) return json(200, { id: existing.id, username: existing.username, token: await issueToken(db, existing.id) })

  if (await db.findByUsername(username)) return json(409, { message: 'That username is taken.' })

  try {
    const account = await db.insert({ username, email: body.email, address })
    return json(201, { id: account.id, username: account.username, token: await issueToken(db, account.id) })
  } catch (error) {
    // Two people claiming the same name at once: the unique index decides,
    // and the loser is told plainly rather than shown a 500.
    if (String(error?.message ?? '').includes('UNIQUE')) {
      return json(409, { message: 'That username was just taken.' })
    }
    throw error
  }
}

/**
 * A user who chose to share it reports their portfolio total: one number, its
 * currency, and how many wallets it spans. No addresses, no holdings.
 */
export async function report(db, request, body, now = Date.now()) {
  const account = await accountFromToken(db, request)
  if (!account) return json(401, { message: 'Not signed in.' })
  if (!body || typeof body !== 'object') return json(400, { message: 'Malformed request body.' })
  const value = body.value
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) return json(400, { message: 'Bad value.' })
  if (!CURRENCIES.has(body.currency)) return json(400, { message: 'Bad currency.' })
  if (!Number.isInteger(body.wallets) || body.wallets < 0 || body.wallets > 256) return json(400, { message: 'Bad wallet count.' })
  await db.upsertReport(account.id, { value, currency: body.currency, wallets: body.wallets, reportedAt: new Date(now).toISOString() })
  return new Response(null, { status: 204, headers: SECURITY_HEADERS })
}

/** Stop sharing: the stored total is deleted, not just hidden. */
export async function withdraw(db, request) {
  const account = await accountFromToken(db, request)
  if (!account) return json(401, { message: 'Not signed in.' })
  await db.deleteReport(account.id)
  return new Response(null, { status: 204, headers: SECURITY_HEADERS })
}

/** For the owner's dashboard. Needs the ADMIN_TOKEN secret, which only the owner holds. */
export async function adminStats(db, request, adminToken) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) return json(503, { message: 'Admin access is not set up.' })
  const supplied = bearer(request)
  if (!supplied || !sameString(await sha256hex(supplied), await sha256hex(adminToken))) {
    return json(401, { message: 'Wrong admin token.' })
  }
  return json(200, await db.stats())
}

export async function handleRequest(db, request, now = Date.now(), options = {}) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': 'https://goldfelty.com',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-max-age': '86400',
        vary: 'origin'
      }
    })
  }

  if (url.pathname === '/health') return json(200, { ok: true })

  if (url.pathname === '/v1/accounts/username-available' && request.method === 'GET') {
    const limited = await rateLimit(db, request, 'check', now)
    if (limited) return limited
    return checkUsername(db, url.searchParams.get('username'))
  }

  if (url.pathname === '/v1/accounts' && request.method === 'POST') {
    if (!String(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return json(415, { message: 'Send JSON.' })
    }
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) return json(413, { message: 'Request too large.' })
    const limited = await rateLimit(db, request, 'register', now)
    if (limited) return limited
    let body
    try {
      const text = await request.text()
      if (text.length > MAX_BODY_BYTES) return json(413, { message: 'Request too large.' })
      body = JSON.parse(text)
    } catch {
      return json(400, { message: 'Malformed request body.' })
    }
    return register(db, body, now)
  }

  if (url.pathname === '/v1/reports' && request.method === 'POST') {
    if (!String(request.headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { message: 'Send JSON.' })
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { message: 'Request too large.' })
    const limited = await rateLimit(db, request, 'report', now)
    if (limited) return limited
    let body
    try {
      const text = await request.text()
      if (text.length > MAX_BODY_BYTES) return json(413, { message: 'Request too large.' })
      body = JSON.parse(text)
    } catch {
      return json(400, { message: 'Malformed request body.' })
    }
    return report(db, request, body, now)
  }

  if (url.pathname === '/v1/reports' && request.method === 'DELETE') {
    return withdraw(db, request)
  }

  if (url.pathname === '/v1/admin/stats' && request.method === 'GET') {
    const limited = await rateLimit(db, request, 'admin', now)
    if (limited) return limited
    return adminStats(db, request, options.adminToken)
  }

  return json(404, { message: 'Not found.' })
}
