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

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': 'https://goldfelty.com',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  })

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
  if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email)) {
    return json(400, { message: 'Enter a valid email address.' })
  }
  if (!isAddress(body.address)) return json(400, { message: 'That is not a valid address.' })
  if (typeof body.signature !== 'string') return json(400, { message: 'Missing signature.' })

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
  if (existing) return json(200, { id: existing.id, username: existing.username })

  if (await db.findByUsername(username)) return json(409, { message: 'That username is taken.' })

  try {
    const account = await db.insert({ username, email: body.email, address })
    return json(201, { id: account.id, username: account.username })
  } catch (error) {
    // Two people claiming the same name at once: the unique index decides,
    // and the loser is told plainly rather than shown a 500.
    if (String(error?.message ?? '').includes('UNIQUE')) {
      return json(409, { message: 'That username was just taken.' })
    }
    throw error
  }
}

export async function handleRequest(db, request, now = Date.now()) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': 'https://goldfelty.com',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400'
      }
    })
  }

  if (url.pathname === '/health') return json(200, { ok: true })

  if (url.pathname === '/v1/accounts/username-available' && request.method === 'GET') {
    return checkUsername(db, url.searchParams.get('username'))
  }

  if (url.pathname === '/v1/accounts' && request.method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { message: 'Malformed request body.' })
    }
    return register(db, body, now)
  }

  return json(404, { message: 'Not found.' })
}
