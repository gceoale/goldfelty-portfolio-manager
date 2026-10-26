import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { BrowserBridge, BridgeClosedError } from '../src/main/connections/browserBridge.ts'
import { BRIDGE_PAGE } from '../src/main/connections/bridgePage.ts'

/** Raw HTTP, so tests can set Host, Origin and Cookie the way a browser or attacker would. */
function http(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, origin)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { host: url.host, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

async function started(t) {
  const bridge = new BrowserBridge()
  await bridge.start()
  t.after(() => bridge.stop())
  return bridge
}

/** Open a one-time link the way a browser would and return the session cookie. */
async function session(bridge) {
  const link = new URL(bridge.issueLink())
  const res = await http(link.origin, link.pathname + link.search)
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
  const cookie = res.headers['set-cookie'][0]
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  return cookie.split(';')[0]
}

const json = (cookie, extra = {}) => ({ cookie, 'content-type': 'application/json', ...extra })

test('a one-time link works once, then grants nothing', async (t) => {
  const bridge = await started(t)
  const link = new URL(bridge.issueLink())
  assert.equal((await http(link.origin, link.pathname + link.search)).status, 303)
  const reused = await http(link.origin, link.pathname + link.search)
  assert.equal(reused.status, 403, 'a link copied from browser history is dead')
  assert.equal(reused.headers['set-cookie'], undefined)
})

test('the page and API need the session cookie', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  assert.equal((await http(bridge.origin, '/')).status, 403)
  assert.equal((await http(bridge.origin, '/', { headers: { cookie: 'gf_bridge_1=guess' } })).status, 403)
  const page = await http(bridge.origin, '/', { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.equal(page.text, BRIDGE_PAGE)
})

test('DNS rebinding and cross-site requests are refused even with the cookie', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const port = new URL(bridge.origin).port
  const rebound = await http(bridge.origin, '/', { headers: { cookie, host: `evil.example:${port}` } })
  assert.equal(rebound.status, 403)
  const crossOrigin = await http(bridge.origin, '/api/hello', {
    method: 'POST',
    headers: json(cookie, { origin: 'https://evil.example' }),
    body: { pageId: 'page-0001', providers: [] }
  })
  assert.equal(crossOrigin.status, 403)
  const crossSite = await http(bridge.origin, '/', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
})

test('POSTs must be JSON, which a cross-site form cannot send', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const form = await http(bridge.origin, '/api/hello', {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: '{"pageId":"page-0001","providers":[]}'
  })
  assert.equal(form.status, 415)
})

test('the page is locked down: hashed script, no framing, no sniffing', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const page = await http(bridge.origin, '/', { headers: { cookie } })
  const csp = page.headers['content-security-policy']
  const script = BRIDGE_PAGE.slice(BRIDGE_PAGE.indexOf('<script>') + 8, BRIDGE_PAGE.indexOf('</script>'))
  const hash = createHash('sha256').update(script).digest('base64')
  assert.ok(csp.includes(`'sha256-${hash}'`), 'the exact inline script is pinned')
  // Scripts are what matter: only this page's own may run. Styles and network
  // are open so wallets' in-page code can work (Coinbase Wallet needs both).
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
  assert.equal(scriptSrc, `script-src 'sha256-${hash}'`)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /connect-src 'self' https: wss:/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(page.headers['x-frame-options'], 'DENY')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.ok(!BRIDGE_PAGE.includes('innerHTML'), 'the page builds its DOM without HTML strings')
  assert.ok(!BRIDGE_PAGE.includes('location.search'), 'the page reads nothing from its URL')
})

test('carries a request to the tab that has the wallet, and its answer back', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const pageId = 'page-0001-abcdef'
  const hello = await http(bridge.origin, '/api/hello', {
    method: 'POST',
    headers: json(cookie),
    body: { pageId, providers: [{ uuid: 'u', rdns: 'io.rabby', name: 'Rabby Wallet', icon: 'data:image/png;base64,AAAA' }] }
  })
  assert.equal(hello.status, 200)
  assert.deepEqual(bridge.detected().map((d) => [d.rdns, d.providerId]), [['io.rabby', 'rabby']])

  const pending = bridge.request('io.rabby', 'Rabby', 'eth_requestAccounts', [])
  const job = (await http(bridge.origin, `/api/poll?pageId=${pageId}`, { headers: { cookie } })).json()
  assert.equal(job.method, 'eth_requestAccounts')
  await http(bridge.origin, '/api/result', { method: 'POST', headers: json(cookie), body: { pageId, id: job.id, result: ['0xabc'] } })
  assert.deepEqual(await pending, ['0xabc'])
})

test('a different tab cannot answer a request meant for another', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  for (const pageId of ['page-aaaa-0001', 'page-bbbb-0002']) {
    await http(bridge.origin, '/api/hello', {
      method: 'POST',
      headers: json(cookie),
      body: { pageId, providers: [{ uuid: 'u', rdns: pageId === 'page-aaaa-0001' ? 'io.metamask' : 'io.rabby', name: 'X' }] }
    })
  }
  const pending = bridge.request('io.metamask', 'MetaMask', 'eth_chainId', [], 2_000)
  const job = (await http(bridge.origin, '/api/poll?pageId=page-aaaa-0001', { headers: { cookie } })).json()
  await http(bridge.origin, '/api/result', { method: 'POST', headers: json(cookie), body: { pageId: 'page-bbbb-0002', id: job.id, result: '0x1' } })
  await http(bridge.origin, '/api/result', { method: 'POST', headers: json(cookie), body: { pageId: 'page-aaaa-0001', id: job.id, result: '0x2105' } })
  assert.equal(await pending, '0x2105')
})

test('no tab, no request: the user is told to open one', async (t) => {
  const bridge = await started(t)
  await assert.rejects(bridge.request('io.metamask', 'MetaMask', 'eth_accounts', []), BridgeClosedError)
})

test('closing the tab fails what it was holding', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const pageId = 'page-close-0001'
  await http(bridge.origin, '/api/hello', { method: 'POST', headers: json(cookie), body: { pageId, providers: [{ rdns: 'io.metamask', name: 'MetaMask' }] } })
  const settled = assert.rejects(bridge.request('io.metamask', 'MetaMask', 'eth_sendTransaction', [{}]), /closed/)
  await http(bridge.origin, '/api/bye', { method: 'POST', headers: json(cookie), body: { pageId } })
  await settled
})

test('rejects icons that are not images, and oversize bodies', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  await http(bridge.origin, '/api/hello', {
    method: 'POST',
    headers: json(cookie),
    body: { pageId: 'page-icon-0001', providers: [{ rdns: 'x.y', name: 'X', icon: 'javascript:alert(1)' }] }
  })
  assert.equal(bridge.detected()[0].icon, null)
  const huge = await http(bridge.origin, '/api/hello', { method: 'POST', headers: json(cookie), body: 'x'.repeat(1_100_000) })
  assert.equal(huge.status, 413)
})

test('tells the tab which wallet is wanted, over the authenticated channel', async (t) => {
  const bridge = await started(t)
  const cookie = await session(bridge)
  const pageId = 'page-want-0001'
  await http(bridge.origin, '/api/hello', { method: 'POST', headers: json(cookie), body: { pageId, providers: [] } })
  bridge.setWanted({ rdns: ['app.phantom'], name: 'Phantom', homepage: 'https://phantom.com' })
  const want = (await http(bridge.origin, `/api/want?pageId=${pageId}`, { headers: { cookie } })).json()
  assert.equal(want.name, 'Phantom')
})

test('stopping invalidates the session', async (t) => {
  const bridge = new BrowserBridge()
  await bridge.start()
  const cookie = await session(bridge)
  const origin = bridge.origin
  await bridge.stop()
  await bridge.start()
  t.after(() => bridge.stop())
  // New port, new secret: an old tab's cookie means nothing.
  assert.equal((await http(bridge.origin, '/', { headers: { cookie } })).status, 403)
  assert.notEqual(bridge.origin, null)
  void origin
})
