import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { Wallet as EthersWallet, verifyMessage } from 'ethers'
import { FrameConnector, FrameUnavailableError } from '../src/main/connections/frame.ts'
import { ConnectionManager, ChainMismatchError } from '../src/main/connections/index.ts'
import { Store } from '../src/main/store.ts'

const ACCOUNT = '0x52908400098527886E0F7030069857D2E4169EE7'

/**
 * A stand-in for Frame's local socket. `chain` is the network it is on; the
 * test decides whether it agrees to switch.
 */
async function mockFrame(t, { allowSwitch = true, signer = null } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.once('listening', r))
  const state = { chain: 1, origins: [], sent: [] }
  wss.on('connection', (socket, req) => {
    state.origins.push(req.headers.origin)
    socket.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString())
      const reply = (result) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      const fail = (code, message) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }))
      switch (msg.method) {
        case 'eth_subscribe':
          return reply(`sub-${msg.params[0]}`)
        case 'eth_requestAccounts':
          return reply([ACCOUNT.toLowerCase()])
        case 'eth_chainId':
          return reply(`0x${state.chain.toString(16)}`)
        case 'wallet_switchEthereumChain':
          if (!allowSwitch) return reply(null) // claims success, stays put
          state.chain = Number(msg.params[0].chainId)
          return reply(null)
        case 'eth_sendTransaction':
          state.sent.push({ chain: state.chain, tx: msg.params[0] })
          return reply('0x' + 'cd'.repeat(32))
        case 'personal_sign':
          return reply(await signer.signMessage(Buffer.from(msg.params[0].slice(2), 'hex')))
        default:
          return fail(-32601, 'not supported')
      }
    })
  })
  t.after(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((r) => wss.close(r))
  })
  return { url: `ws://127.0.0.1:${wss.address().port}`, state }
}

function setup(t, frameUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-conn-'))
  const frame = new FrameConnector(frameUrl)
  const manager = new ConnectionManager(dir, async () => {}, frame)
  const store = new Store(dir)
  store.open(randomBytes(32))
  manager.attach(store)
  t.after(async () => {
    await manager.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  return { manager, store }
}

test('Frame: connects over its local socket, presenting goldfelty.com as the origin', async (t) => {
  const { url, state } = await mockFrame(t)
  const { manager, store } = setup(t, url)
  const connection = await manager.connectFrame(() => {})
  assert.deepEqual(connection.accounts, [ACCOUNT])
  assert.equal(state.origins[0], 'https://goldfelty.com')
  assert.equal(store.connection('frame').name, 'Frame')
  assert.equal(manager.isActive(connection), true)
})

test('Frame: says plainly when it is not running', async (t) => {
  const { manager } = setup(t, 'ws://127.0.0.1:1')
  assert.equal(await manager.detectFrame(), false)
  await assert.rejects(manager.connectFrame(() => {}), FrameUnavailableError)
})

test('switches the wallet to the right network before sending, and says which', async (t) => {
  const { url, state } = await mockFrame(t)
  const { manager } = setup(t, url)
  await manager.connectFrame(() => {})
  const hash = await manager.sendTransaction('frame', 8453, { from: ACCOUNT, to: ACCOUNT, value: '0x1' })
  assert.match(hash, /^0x[0-9a-f]{64}$/)
  assert.equal(state.sent[0].chain, 8453, 'sent on Base, not on whatever the wallet was on')
  assert.equal(state.sent[0].tx.chainId, '0x2105')
})

test('refuses to send if the wallet does not actually switch', async (t) => {
  const { url, state } = await mockFrame(t, { allowSwitch: false })
  const { manager } = setup(t, url)
  await manager.connectFrame(() => {})
  await assert.rejects(manager.sendTransaction('frame', 8453, { from: ACCOUNT, to: ACCOUNT, value: '0x1' }), ChainMismatchError)
  assert.equal(state.sent.length, 0, 'nothing reached the network')
})

test('signs as UTF-8 text that recovers to the account', async (t) => {
  const signer = EthersWallet.createRandom()
  const { url } = await mockFrame(t, { signer })
  const { manager } = setup(t, url)
  await manager.connectFrame(() => {})
  const message = 'Goldfelty account registration\nusername: zoë'
  const signature = await manager.signMessage('frame', signer.address, message)
  assert.equal(verifyMessage(message, signature), signer.address)
})

/* ---- goldfelty.com client --------------------------------------------- */

async function mockApi(t, handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${server.address().port}/v1`
}

async function loadClient(apiUrl) {
  process.env.GOLDFELTY_API_URL = apiUrl
  // A fresh copy per API URL, since the module reads it once.
  return import(`../src/main/goldfelty.ts?api=${encodeURIComponent(apiUrl)}`)
}

function signerFor(wallet, onSign = () => {}) {
  return {
    address: wallet.address,
    name: 'Test',
    sign: async (m) => {
      onSign(m)
      return wallet.signMessage(m)
    }
  }
}

test('signs up: the server receives a signature it can verify, and nothing else secret', async (t) => {
  const wallet = EthersWallet.createRandom()
  let received
  const api = await mockApi(t, (req, res) => {
    if (req.url === '/v1/health') return res.end('{"ok":true}')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received = JSON.parse(body)
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'gf_123e4567-e89b-12d3-a456-426614174000', username: received.username }))
    })
  })
  const client = await loadClient(api)
  const result = await client.registerAccount({ username: ' Alice ', email: 'Alice@Example.com' }, signerFor(wallet))
  assert.equal(result.linked, true)
  assert.equal(result.account.username, 'alice')
  assert.deepEqual(Object.keys(received).sort(), ['address', 'email', 'issuedAt', 'signature', 'username'])
  const statement = client.registrationStatement(received)
  assert.equal(verifyMessage(statement, received.signature), wallet.address)
})

test('signs up: an unreachable server keeps the account local and asks for no signature', async (t) => {
  const client = await loadClient('http://127.0.0.1:1/v1')
  let signed = false
  const result = await client.registerAccount({ username: 'bob', email: 'b@example.com' }, signerFor(EthersWallet.createRandom(), () => (signed = true)))
  assert.equal(result.linked, false)
  assert.match(result.account.goldfeltyId, /^local-/)
  assert.equal(signed, false)
})

test('signs up: a taken name is an error the user can fix, not a silent local account', async (t) => {
  const api = await mockApi(t, (req, res) => {
    if (req.url === '/v1/health') return res.end('{"ok":true}')
    req.resume()
    req.on('end', () => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end('{"message":"That username is taken."}')
    })
  })
  const client = await loadClient(api)
  await assert.rejects(
    client.registerAccount({ username: 'carol', email: 'c@example.com' }, signerFor(EthersWallet.createRandom())),
    (e) => e instanceof client.ApiRefusedError && e.status === 409 && /taken/.test(e.message)
  )
})

test('signs up: a parked page or proxy error is treated as unreachable', async (t) => {
  const api = await mockApi(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>Domain for sale</html>')
  })
  const client = await loadClient(api)
  assert.equal((await client.apiStatus()).reachable, false)
})

test('signs up: refuses to follow a redirect with a signed body', async (t) => {
  let posted = false
  const api = await mockApi(t, (req, res) => {
    if (req.url === '/v1/health') return res.end('{"ok":true}')
    if (req.url === '/elsewhere') posted = true
    res.writeHead(307, { location: '/elsewhere' })
    res.end()
  })
  const client = await loadClient(api)
  const result = await client.registerAccount({ username: 'dave', email: 'd@example.com' }, signerFor(EthersWallet.createRandom()))
  assert.equal(result.linked, false)
  assert.equal(posted, false)
})

test('sharing a total sends exactly three fields, with the account token', async (t) => {
  let seen
  const api = await mockApi(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null }
      res.writeHead(204)
      res.end()
    })
  })
  const client = await loadClient(api)
  const token = 'T'.repeat(43)
  await client.reportTotals(token, { value: 1234.567, currency: 'USD', wallets: 3 })
  assert.equal(seen.method, 'POST')
  assert.equal(seen.url, '/v1/reports')
  assert.equal(seen.auth, `Bearer ${token}`)
  assert.deepEqual(seen.body, { value: 1234.57, currency: 'USD', wallets: 3 })
  await client.withdrawTotals(token)
  assert.equal(seen.method, 'DELETE')
})

test('sign-up keeps the reporting token out of what the account holds', async (t) => {
  const wallet = EthersWallet.createRandom()
  const api = await mockApi(t, (req, res) => {
    if (req.url === '/v1/health') return res.end('{"ok":true}')
    req.resume()
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'gf_123e4567-e89b-12d3-a456-426614174000', username: 'gus', token: 'A'.repeat(43) }))
    })
  })
  const client = await loadClient(api)
  const result = await client.registerAccount({ username: 'gus', email: 'g@example.com' }, signerFor(wallet))
  assert.equal(result.token, 'A'.repeat(43))
  assert.equal(JSON.stringify(result.account).includes('AAAA'), false)
})
