import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionBridge } from '../src/main/extensionBridge.ts'

const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'

async function bridge(t) {
  const b = new ExtensionBridge()
  const { url, connected } = await b.start([1, 8453])
  t.after(() => b.stop())
  const token = new URL(url).searchParams.get('token')
  const origin = new URL(url).origin
  return { b, url, token, origin, connected }
}

const post = (origin, path, token, body) =>
  fetch(`${origin}${path}?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

test('binds to loopback only, never a public interface', async (t) => {
  const { url } = await bridge(t)
  // A signing endpoint reachable from the LAN would be a serious hole.
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//)
})

test('issues a long, unguessable token per session', async (t) => {
  const { token } = await bridge(t)
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]+$/)
})

test('serves the connect page to a correct token', async (t) => {
  const { url } = await bridge(t)
  const res = await fetch(url)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('window.ethereum'), 'page must talk to the injected provider')
  assert.ok(html.includes('[1,8453]'), 'page must receive the chain list')
  assert.ok(res.headers.get('content-security-policy'), 'page must carry a CSP')
})

test('refuses every request without the token', async (t) => {
  const { origin } = await bridge(t)
  for (const path of ['/', '/api/poll', '/api/connect']) {
    const res = await fetch(`${origin}${path}`)
    assert.equal(res.status, 403, `${path} must be refused`)
  }
})

test('refuses a wrong token', async (t) => {
  const { origin } = await bridge(t)
  const res = await fetch(`${origin}/?token=${'0'.repeat(64)}`)
  assert.equal(res.status, 403)
})

test('refuses a request from another origin even with the token', async (t) => {
  const { origin, token } = await bridge(t)
  const res = await fetch(`${origin}/?token=${token}`, { headers: { origin: 'https://evil.example' } })
  assert.equal(res.status, 403, 'a hostile page must not drive the bridge')
})

test('records the accounts the wallet shares', async (t) => {
  const { b, origin, token, connected } = await bridge(t)
  await post(origin, '/api/connect', token, {
    accounts: [ADDRESS.toLowerCase()],
    chainIds: [1],
    providerName: 'MetaMask'
  })
  const connection = await connected
  assert.equal(connection.kind, 'extension')
  assert.equal(connection.name, 'MetaMask')
  assert.deepEqual(connection.accounts, [ADDRESS], 'address must be checksummed')
  assert.equal(connection.active, true)
  assert.equal(b.current.id, connection.id)
})

test('ignores junk that is not an address', async (t) => {
  const { origin, token } = await bridge(t)
  const res = await post(origin, '/api/connect', token, { accounts: ['not-an-address'], providerName: 'X' })
  assert.equal(res.status, 400)
})

test('relays a request to the page and resolves with its result', async (t) => {
  const { b, origin, token, connected } = await bridge(t)
  await post(origin, '/api/connect', token, { accounts: [ADDRESS], providerName: 'MetaMask' })
  await connected

  const sending = b.request('eth_sendTransaction', [{ from: ADDRESS, to: ADDRESS, value: '0x1' }])

  const job = await (await fetch(`${origin}/api/poll?token=${token}`)).json()
  assert.equal(job.method, 'eth_sendTransaction')
  assert.equal(job.params[0].from, ADDRESS)

  await post(origin, '/api/result', token, { id: job.id, result: '0xdeadbeef' })
  assert.equal(await sending, '0xdeadbeef')
})

test('surfaces a rejection in the wallet as an error', async (t) => {
  const { b, origin, token, connected } = await bridge(t)
  await post(origin, '/api/connect', token, { accounts: [ADDRESS], providerName: 'MetaMask' })
  await connected

  // Attach the handler up front: the rejection lands before assert.rejects
  // would otherwise subscribe, which Node reports as an unhandled rejection.
  const settled = b.request('eth_sendTransaction', [{}]).then(
    () => null,
    (error) => error
  )
  const job = await (await fetch(`${origin}/api/poll?token=${token}`)).json()
  await post(origin, '/api/result', token, { id: job.id, error: 'User rejected the request' })

  const error = await settled
  assert.ok(error, 'the request must reject, not resolve')
  assert.match(error.message, /User rejected the request/)
})

test('refuses to sign once the browser tab is gone', async (t) => {
  const { b, origin, token, connected } = await bridge(t)
  await post(origin, '/api/connect', token, { accounts: [ADDRESS], providerName: 'MetaMask' })
  await connected

  await post(origin, '/api/disconnect', token, {})
  await assert.rejects(() => b.request('eth_sendTransaction', [{}]), /page is closed/)
})

test('rejects in-flight requests when the bridge stops', async (t) => {
  const { b, origin, token, connected } = await bridge(t)
  await post(origin, '/api/connect', token, { accounts: [ADDRESS], providerName: 'MetaMask' })
  await connected

  const sending = b.request('eth_sendTransaction', [{}])
  // Swallow here so stopping does not surface as an unhandled rejection.
  const settled = sending.catch((error) => error)
  await b.stop()
  assert.match((await settled).message, /closed/)
})

test('a stopped bridge releases its port', async (t) => {
  const b = new ExtensionBridge()
  const { url } = await b.start([1])
  await b.stop()
  await assert.rejects(() => fetch(url), 'nothing should still be listening')
})
