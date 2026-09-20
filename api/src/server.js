import { createServer } from 'node:http'
import { verifyMessage, getAddress } from 'ethers'
import { Store } from './store.js'

/**
 * api.goldfelty.com — account registration.
 *
 * The desktop app calls this to claim a username. It proves control of an
 * address by signing a statement; there are no passwords here and nothing
 * secret is ever posted, so a compromise of this service cannot cost anyone
 * funds. The worst it can do is hand out the wrong username.
 */

const PORT = Number(process.env.PORT ?? 8080)
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** How stale a signed registration may be. Limits replay of a captured body. */
const MAX_AGE_MS = 10 * 60_000

const store = new Store(process.env.DATA_DIR ?? './data')

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // The desktop app is not a browser origin, but a stray browser should not
    // be able to drive this on somebody's behalf.
    'access-control-allow-origin': 'https://goldfelty.com',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Rebuild the exact statement the app signed, so signatures cannot be reused. */
function statementFor({ username, email, address, issuedAt }) {
  return [
    'Goldfelty account registration',
    `username: ${username}`,
    `email: ${email}`,
    `address: ${address}`,
    `issued: ${issuedAt}`
  ].join('\n')
}

function validate(body) {
  if (!body) return 'Malformed request body.'
  const { username, email, address, signature, issuedAt } = body
  if (typeof username !== 'string' || username.length < 3 || username.length > 24) {
    return 'Usernames are 3 to 24 characters.'
  }
  if (!USERNAME_RE.test(username)) return 'Use lowercase letters, numbers, hyphens and underscores.'
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return 'Enter a valid email address.'
  if (typeof address !== 'string' || typeof signature !== 'string') return 'Missing address or signature.'
  if (typeof issuedAt !== 'string') return 'Missing issuedAt.'
  const age = Date.now() - Date.parse(issuedAt)
  if (!Number.isFinite(age)) return 'issuedAt is not a timestamp.'
  if (age > MAX_AGE_MS) return 'This registration is too old. Try again.'
  // A little slack for clock skew, but not an open door to future-dating.
  if (age < -60_000) return 'issuedAt is in the future.'
  return null
}

export function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': 'https://goldfelty.com',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    })
    return res.end()
  }

  if (url.pathname === '/health') return json(res, 200, { ok: true })

  if (url.pathname === '/v1/accounts/username-available' && req.method === 'GET') {
    const username = (url.searchParams.get('username') ?? '').toLowerCase()
    if (username.length < 3 || username.length > 24 || !USERNAME_RE.test(username)) {
      return json(res, 200, { available: false, reason: 'That username is not allowed.' })
    }
    return json(res, 200, { available: !store.hasUsername(username) })
  }

  if (url.pathname === '/v1/accounts' && req.method === 'POST') {
    return void (async () => {
      let body
      try {
        body = await readBody(req)
      } catch {
        return json(res, 413, { message: 'Request too large.' })
      }

      const problem = validate(body)
      if (problem) return json(res, 400, { message: problem })

      const username = body.username.toLowerCase()
      let address
      try {
        address = getAddress(body.address)
      } catch {
        return json(res, 400, { message: 'That is not a valid address.' })
      }

      // The signature is the whole authentication story: recover the signer
      // and require it to be the address being claimed.
      let signer
      try {
        signer = verifyMessage(statementFor({ ...body, username, address }), body.signature)
      } catch {
        return json(res, 400, { message: 'The signature could not be read.' })
      }
      if (getAddress(signer) !== address) {
        return json(res, 401, { message: 'That signature does not match the address.' })
      }

      const existing = store.byAddress(address)
      if (existing) {
        // Re-registering the same address is how the app re-links after being
        // offline, so hand back what it already has rather than erroring.
        return json(res, 200, { id: existing.id, username: existing.username })
      }
      if (store.hasUsername(username)) {
        return json(res, 409, { message: 'That username is taken.' })
      }

      const account = store.create({ username, email: body.email, address })
      return json(res, 201, { id: account.id, username: account.username })
    })()
  }

  json(res, 404, { message: 'Not found.' })
}

if (process.env.NODE_ENV !== 'test') {
  createServer(handle).listen(PORT, () => {
    console.log(`goldfelty api listening on :${PORT}`)
  })
}
