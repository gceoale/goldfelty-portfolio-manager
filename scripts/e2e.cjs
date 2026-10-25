/**
 * End-to-end test of the built app.
 *
 * Runs the real Electron app against:
 *   - fake browser wallets in a separate Chromium page, opened from the app's
 *     own one-time bridge link and backed by keys here in Node: "Rabby
 *     Wallet" (EIP-6963), "Solflare" (Solana Wallet Standard) and "UniSat"
 *     (Bitcoin);
 *   - the real goldfelty.com account API code (api/src/accounts.js) on a
 *     local port, with an in-memory database;
 *   - a mock JSON-RPC node and price feed, so balances are deterministic.
 *
 * It walks setup, connects the wallet, signs up, reads balances, sends ETH,
 * SOL and BTC (checking each transfer and its 0.5% fee go where they
 * should), visits every
 * page, locks and unlocks, and fails on any console error or CSP violation.
 *
 *   npm run build && xvfb-run -a node scripts/e2e.cjs
 *
 * Screenshots land in SHOT_DIR (default: release/e2e).
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const { Wallet, getBytes, Transaction } = require('ethers')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('@bitcoinerlab/secp256k1')
const { ECPairFactory } = require('ecpair')
const { ed25519 } = require('@noble/curves/ed25519')
bitcoin.initEccLib(ecc)

let pw
try {
  pw = require('playwright')
} catch {
  pw = require('playwright-core')
}

const APP = path.resolve(__dirname, '..')
const OUT = process.env.SHOT_DIR ?? path.join(APP, 'release', 'e2e')
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'goldfelty-e2e-'))
const FEE_ADDRESS = '0x8617E340B3D01FA5F11F306F4090FD50E238070D'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const PASSWORD = 'Tr0ubad0ur&Bits'
const ADMIN_TOKEN = 'admin-'.padEnd(48, 'x')
fs.mkdirSync(OUT, { recursive: true })

const userKey = Wallet.createRandom()

// The same person's Solana and Bitcoin keys, held by the fake Solflare and UniSat.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
const solSecret = ed25519.utils.randomPrivateKey()
const solPublic = ed25519.getPublicKey(solSecret)
const SOL_ADDRESS = b58(solPublic)
const SOL_RECIPIENT = b58(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()))
const SOL_FEE_ADDRESS = b58(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()))
const ECPair = ECPairFactory(ecc)
const btcKey = ECPair.makeRandom()
const BTC_ADDRESS = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(btcKey.publicKey) }).address
const someBtc = () => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom().publicKey) }).address
const BTC_RECIPIENT = someBtc()
const BTC_FEE_ADDRESS = someBtc()
const chainLog = { solSent: [], btcSent: [] }
function bs58Bytes(text) {
  let n = 0n
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c))
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
}

/* ---- mock servers ------------------------------------------------------------ */

function listen(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const rpcLog = []
let drift = 0

function rpcAnswer(chainId, call) {
  rpcLog.push(call.method)
  switch (call.method) {
    case 'eth_chainId':
      return '0x' + chainId.toString(16)
    case 'eth_blockNumber':
      return '0x10'
    case 'eth_getBalance': {
      // Ethereum's balance wanders a little between refreshes, so the chart has a shape.
      const wobble = BigInt(Math.round(Math.sin(drift / 2) * 1e17 + drift * 2e16))
      return '0x' + (chainId === 1 ? 15n * 10n ** 17n + wobble : 2n * 10n ** 17n).toString(16)
    }
    case 'eth_call': {
      const to = String(call.params[0].to).toLowerCase()
      return to === USDC ? word(2500n * 10n ** 6n) : word(0)
    }
    case 'eth_gasPrice':
      return '0x3b9aca00'
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00'
    case 'eth_estimateGas':
      return '0x5208'
    case 'eth_getBlockByNumber':
      return {
        number: '0x10',
        hash: '0x' + '11'.repeat(32),
        parentHash: '0x' + '22'.repeat(32),
        timestamp: '0x6553f100',
        nonce: '0x0000000000000000',
        difficulty: '0x0',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        miner: '0x' + '00'.repeat(20),
        extraData: '0x',
        baseFeePerGas: '0x3b9aca00',
        transactions: []
      }
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return null
    default:
      return null
  }
}

async function startMocks() {
  const { handleRequest } = await import(path.join(APP, 'api/src/accounts.js'))
  const accounts = []
  const tokens = new Map()
  const reports = new Map()
  const db = {
    async findByUsername(u) {
      return accounts.find((a) => a.username === u) ?? null
    },
    async findByAddress(a) {
      return accounts.find((x) => x.address === a) ?? null
    },
    async insert({ username, email, address }) {
      const account = { id: `gf_${require('node:crypto').randomUUID()}`, username, email, address, createdAt: new Date().toISOString() }
      accounts.push(account)
      return account
    },
    async setToken(id, hash) {
      for (const [h, v] of tokens) if (v === id) tokens.delete(h)
      tokens.set(hash, id)
    },
    async findByTokenHash(hash) {
      return accounts.find((a) => a.id === tokens.get(hash)) ?? null
    },
    async upsertReport(id, r) {
      reports.set(id, r)
    },
    async deleteReport(id) {
      reports.delete(id)
    },
    async stats() {
      return {
        users: accounts.length,
        sharing: reports.size,
        accounts: accounts.map((a) => ({ username: a.username, ...(reports.get(a.id) ?? {}) }))
      }
    }
  }

  const server = await listen(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks).toString()

    if (req.url.startsWith('/v1') || req.url === '/health') {
      const url = 'https://api.goldfelty.com' + req.url.replace(/^\/v1\/health/, '/health')
      const response = await handleRequest(
        db,
        new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }),
        Date.now(),
        { adminToken: ADMIN_TOKEN }
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      return res.end(Buffer.from(await response.arrayBuffer()))
    }
    if (req.url.startsWith('/fees.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"feeBps":50}')
    }
    if (req.url.startsWith('/simple/price')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          ethereum: { usd: 3000, usd_24h_change: 1.8 },
          'usd-coin': { usd: 1, usd_24h_change: 0.01 },
          'matic-network': { usd: 0.4, usd_24h_change: -2.1 },
          'polygon-ecosystem-token': { usd: 0.4, usd_24h_change: -2.1 },
          weth: { usd: 3000, usd_24h_change: 1.8 },
          solana: { usd: 150, usd_24h_change: 3.2 },
          bitcoin: { usd: 60000, usd_24h_change: -0.6 }
        })
      )
    }
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url.startsWith('/sol')) {
      const call = JSON.parse(body)
      const reply = (result) => json({ jsonrpc: '2.0', id: call.id, result })
      switch (call.method) {
        case 'getBalance':
          return reply({ context: {}, value: call.params[0] === SOL_ADDRESS ? 3_000_000_000 : 1_000_000 })
        case 'getTokenAccountsByOwner':
          return reply({ context: {}, value: [] })
        case 'getAccountInfo':
          return reply({ context: {}, value: { lamports: 1_000_000 } })
        case 'getLatestBlockhash':
          return reply({ context: {}, value: { blockhash: b58(Buffer.alloc(32, 9)), lastValidBlockHeight: 1 } })
        case 'sendTransaction': {
          const bytes = Buffer.from(call.params[0], 'base64')
          chainLog.solSent.push(bytes)
          return reply(b58(bytes.subarray(1, 65)))
        }
        case 'getSignatureStatuses':
          return reply({ context: {}, value: [{ confirmationStatus: 'confirmed', err: null }] })
        default:
          return reply(null)
      }
    }
    if (req.url.startsWith('/btc')) {
      const url = req.url.slice(4)
      if (url === '/fee-estimates') return json({ 1: 9, 3: 5, 6: 3 })
      if (url === `/address/${BTC_ADDRESS}`) return json({ chain_stats: { funded_txo_sum: 5_000_000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })
      if (url === `/address/${BTC_ADDRESS}/utxo`) return json([{ txid: 'ab'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }])
      if (url === '/tx' && req.method === 'POST') {
        const tx = bitcoin.Transaction.fromHex(body)
        chainLog.btcSent.push(tx)
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(tx.getId())
      }
      if (/^\/tx\/[0-9a-f]{64}\/status$/.test(url)) return json({ confirmed: true })
      if (url.startsWith('/address/')) return json({ chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })
    }
    const rpc = /^\/rpc\/(\d+)/.exec(req.url)
    if (rpc) {
      const chainId = Number(rpc[1])
      const parsed = JSON.parse(body)
      const answer = (c) => ({ jsonrpc: '2.0', id: c.id, result: rpcAnswer(chainId, c) })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)))
    }
    res.writeHead(404)
    res.end()
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}`, accounts, reports }
}

/* ---- the fake wallet ------------------------------------------------------------- */

const FAKE_WALLET = `
(() => {
  const listeners = {};
  const provider = {
    isRabby: true,
    request({ method, params }) {
      return window.__walletRequest(method, JSON.stringify(params ?? [])).then((raw) => {
        const out = JSON.parse(raw);
        if (out.error) { const e = new Error(out.error.message); e.code = out.error.code; throw e; }
        return out.result;
      });
    },
    on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeListener() {}
  };
  const info = Object.freeze({
    uuid: '6f3b0bd6-1d1b-4f4a-9a4f-3d6a3b2c1a00',
    name: 'Rabby Wallet',
    rdns: 'io.rabby',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#7084ff"/></svg>')
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  const ask = (method, params) => window.__walletRequest(method, JSON.stringify(params)).then((raw) => {
    const out = JSON.parse(raw);
    if (out.error) { const e = new Error(out.error.message); e.code = out.error.code; throw e; }
    return out.result;
  });

  // Solflare, through the Solana Wallet Standard.
  const solAccount = Object.freeze({ address: SOL_ADDRESS, publicKey: new Uint8Array(SOL_PUBLIC), chains: ['solana:mainnet'], features: ['solana:signTransaction'] });
  const solWallet = {
    version: '1.0.0',
    name: 'Solflare',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#fc7227"/></svg>'),
    chains: ['solana:mainnet'],
    accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { await ask('sol_connect', []); solWallet.accounts = [solAccount]; return { accounts: [solAccount] }; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy'],
        signTransaction: async (...inputs) => {
          const out = [];
          for (const input of inputs) {
            const b64 = btoa(String.fromCharCode(...input.transaction));
            const signed = await ask('sol_sign', [b64]);
            out.push({ signedTransaction: Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)) });
          }
          return out;
        }
      }
    }
  };
  const registerSol = ({ register }) => register(solWallet);
  window.addEventListener('wallet-standard:app-ready', (e) => registerSol(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: registerSol }));

  // UniSat, for Bitcoin.
  window.unisat = {
    requestAccounts: () => ask('btc_connect', []).then(() => [BTC_ADDRESS]),
    getPublicKey: async () => BTC_PUBLIC,
    signPsbt: (hex, options) => ask('btc_sign', [hex, options])
  };
})();
`
  .replace(/SOL_ADDRESS/g, JSON.stringify(SOL_ADDRESS))
  .replace('SOL_PUBLIC', JSON.stringify([...solPublic]))
  .replace(/BTC_ADDRESS/g, JSON.stringify(BTC_ADDRESS))
  .replace('BTC_PUBLIC', JSON.stringify(Buffer.from(btcKey.publicKey).toString('hex')))

function makeWalletBackend() {
  const state = { chainId: 1, sent: [], signed: [], prompts: [], solSigned: [], btcSigned: [] }
  const handler = async (method, paramsJson) => {
    const params = JSON.parse(paramsJson)
    state.prompts.push(method)
    try {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return JSON.stringify({ result: [userKey.address] })
        case 'eth_chainId':
          return JSON.stringify({ result: '0x' + state.chainId.toString(16) })
        case 'wallet_switchEthereumChain':
          state.chainId = Number(params[0].chainId)
          return JSON.stringify({ result: null })
        case 'personal_sign': {
          const signature = await userKey.signMessage(getBytes(params[0]))
          state.signed.push(Buffer.from(getBytes(params[0])).toString('utf8'))
          return JSON.stringify({ result: signature })
        }
        case 'sol_connect':
        case 'btc_connect':
          return JSON.stringify({ result: true })
        case 'sol_sign': {
          const bytes = Buffer.from(params[0], 'base64')
          const message = bytes.subarray(65)
          const signature = ed25519.sign(message, solSecret)
          state.solSigned.push(message)
          return JSON.stringify({ result: Buffer.concat([Buffer.from([1]), Buffer.from(signature), message]).toString('base64') })
        }
        case 'btc_sign': {
          const psbt = bitcoin.Psbt.fromHex(params[0])
          assert.equal(params[1].autoFinalized, false)
          psbt.signAllInputs(btcKey)
          state.btcSigned.push(psbt.txOutputs.map((o) => [o.address, o.value]))
          return JSON.stringify({ result: psbt.toHex() })
        }
        case 'eth_sendTransaction': {
          state.sent.push({ ...params[0], walletChain: state.chainId })
          const hash = '0x' + require('node:crypto').randomBytes(32).toString('hex')
          return JSON.stringify({ result: hash })
        }
        default:
          return JSON.stringify({ error: { code: 4200, message: `Unsupported ${method}` } })
      }
    } catch (error) {
      return JSON.stringify({ error: { code: -32603, message: error.message } })
    }
  }
  return { state, handler }
}

/* ---- run ------------------------------------------------------------------------- */

;(async () => {
  const mocks = await startMocks()
  const problems = []

  const app = await pw._electron.launch({
    // This project's Electron, wherever Playwright itself was installed.
    executablePath: require(require.resolve('electron', { paths: [APP] })),
    args: [path.join(APP, 'out/main/index.js'), '--no-sandbox', `--user-data-dir=${USER_DATA}`],
    cwd: APP,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      GOLDFELTY_API_URL: `${mocks.origin}/v1`,
      GOLDFELTY_FEE_ADDRESS: FEE_ADDRESS,
      GOLDFELTY_FEE_ADDRESS_SOL: SOL_FEE_ADDRESS,
      GOLDFELTY_FEE_ADDRESS_BTC: BTC_FEE_ADDRESS,
      GOLDFELTY_FEE_CONFIG_URL: `${mocks.origin}/fees.json`
    }
  })
  const page = await app.firstWindow()
  let expectBlocked = false
  page.on('console', (msg) => {
    // The probe below is meant to be blocked; anything else is a failure.
    if (expectBlocked && /fees\.json/.test(msg.text())) return
    if (msg.type() === 'error' || /Content Security Policy/i.test(msg.text())) problems.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  await page.setViewportSize({ width: 1240, height: 800 })
  await page.waitForLoadState('domcontentloaded')

  const shot = async (name) => {
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log('  shot', name)
  }
  const step = (text) => console.log(`• ${text}`)

  // ---- setup ---------------------------------------------------------------
  step('welcome and terms')
  await page.getByRole('heading', { name: 'Welcome to Goldfelty' }).waitFor()
  await shot('01-welcome')
  assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), true, 'cannot continue without agreeing to the Terms')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Continue' }).click()

  step('password')
  await page.locator('#pw').fill(PASSWORD)
  await page.locator('#pw2').fill(PASSWORD)
  await shot('02-password')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Connect your wallets' }).waitFor({ timeout: 20_000 })

  // Point balances and prices at the mocks, through the same API the UI uses.
  const rpcFor = (id) => `${mocks.origin}/rpc/${id}`
  const updated = await page.evaluate(
    (patch) => window.goldfelty.settings.update(patch),
    {
      customRpc: { 1: rpcFor(1), 8453: rpcFor(8453), 42161: rpcFor(42161), 10: rpcFor(10), 137: rpcFor(137), [-501]: `${mocks.origin}/sol`, [-1]: `${mocks.origin}/btc` },
      priceProviderUrl: mocks.origin
    }
  )
  assert.equal(updated.ok, true, JSON.stringify(updated))

  step('the renderer cannot reach the network or other channels')
  expectBlocked = true
  const blocked = await page.evaluate(async (origin) => {
    try {
      await fetch(origin + '/fees.json')
      return false
    } catch {
      return true
    }
  }, mocks.origin)
  assert.equal(blocked, true, 'renderer fetch must be refused')
  await page.waitForTimeout(200)
  expectBlocked = false
  const badUrl = await page.evaluate(() => window.goldfelty.app.openExternal('file:///etc/passwd'))
  assert.equal(badUrl.ok, false)
  const badRpc = await page.evaluate(() => window.goldfelty.settings.update({ customRpc: { 1: 'http://evil.example' } }))
  assert.equal(badRpc.ok, false)

  step('open the browser tab with the fake wallet')
  await page.evaluate(() => window.goldfelty.connections.copyBridgeLink())
  const link = await app.evaluate(({ clipboard }) => clipboard.readText())
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/open\?t=/)
  const browser = await pw.chromium.launch()
  const context = await browser.newContext()
  const backend = makeWalletBackend()
  await context.exposeFunction('__walletRequest', backend.handler)
  await context.addInitScript(FAKE_WALLET)
  const tab = await context.newPage()
  tab.on('console', (msg) => msg.type() === 'error' && problems.push(`bridge console: ${msg.text()}`))
  await tab.goto(link)
  assert.ok(!tab.url().includes('t='), 'the ticket is gone from the address bar')
  await tab.getByText('Connected to the app').waitFor({ timeout: 10_000 })
  await tab.screenshot({ path: path.join(OUT, '03-bridge-tab.png') })
  const replay = await (await context.request.get(link)).status()
  assert.equal(replay, 403, 'the one-time link cannot be reused')

  step('connect it')
  await page.getByRole('button', { name: /Connect a wallet/ }).click()
  await page.getByText(/Found in your browser/).first().waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /Solflare\s*Found in your browser · Solana/ }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /UniSat\s*Found in your browser · Bitcoin/ }).waitFor({ timeout: 10_000 })
  await shot('04-connect-sheet')
  await page.getByRole('button', { name: /Rabby Wallet\s*Found in your browser/ }).click()
  await page.getByText(/Rabby Wallet connected/).waitFor({ timeout: 15_000 })
  await shot('05-connected')
  await page.getByRole('button', { name: 'Continue' }).click()

  step('sign up on goldfelty.com, signed by the wallet')
  await page.getByRole('heading', { name: 'Your goldfelty.com account' }).waitFor()
  await page.locator('#username').fill('alice')
  await page.locator('#email').fill('alice@example.com')
  await page.getByText('Prove it’s you').waitFor({ timeout: 10_000 })
  await page.getByRole('checkbox').check()
  await shot('06-account')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 20_000 })
  assert.equal(mocks.accounts.length, 1, 'the account exists on the server')
  assert.equal(mocks.accounts[0].address, userKey.address)
  assert.match(backend.state.signed[0], /^Goldfelty account registration\nusername: alice\n/)

  step('overview')
  await page.locator('table.holdings').waitFor({ timeout: 20_000 })
  await page.getByText('ETH', { exact: true }).first().waitFor()
  await shot('07-overview')
  // Sharing was switched on after the first refresh, so the next one reports.
  await page.getByRole('button', { name: 'Refresh' }).click()
  for (let i = 0; i < 40 && mocks.reports.size === 0; i++) await page.waitForTimeout(250)
  const report = [...mocks.reports.values()][0]
  assert.ok(report, 'the user chose to share, so a total arrived')
  assert.deepEqual(Object.keys(report).sort(), ['currency', 'reportedAt', 'value', 'wallets'])
  const stats = await (await fetch(`${mocks.origin}/v1/admin/stats`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()
  assert.equal(stats.users, 1)
  assert.equal(stats.sharing, 1)

  step('a day of history, by moving the app’s clock forward between refreshes')
  await app.evaluate(() => {
    const real = Date.now.bind(Date)
    globalThis.__gfOffset = 0
    Date.now = () => real() + globalThis.__gfOffset
  })
  for (let hour = 1; hour <= 12; hour++) {
    drift = hour
    await app.evaluate((_electron, ms) => (globalThis.__gfOffset = ms), hour * 2 * 3600_000)
    await page.evaluate(() => window.goldfelty.app.touch())
    await page.evaluate(() => window.goldfelty.portfolio.load('30d'))
  }
  await page.getByRole('button', { name: 'Refresh' }).click()
  if (process.env.E2E_DEBUG) console.log(JSON.stringify((await page.evaluate(() => window.goldfelty.portfolio.load('30d'))).data.history.map((h) => [h.at, h.total])))
  await page.locator('.chart svg path.chart-line').waitFor({ timeout: 10_000 })
  await page.locator('.chart svg').hover({ position: { x: 400, y: 100 } })
  await page.locator('.chart-tip').waitFor()
  await shot('07b-overview-chart')
  await page.mouse.move(5, 790)

  step('send, with a choice of wallet and the fee shown')
  await page.getByRole('button', { name: 'Send', exact: true }).first().click()
  await page.locator('#send-asset').waitFor()
  await page.locator('#send-asset').selectOption('ETH')
  await page.locator('.route').first().waitFor()
  const routes = await page.locator('.route').count()
  assert.ok(routes > 1, 'several wallets hold ETH, so the user must choose')
  assert.equal(await page.getByRole('button', { name: 'Review' }).isDisabled(), true)
  await page.locator('.route', { hasText: 'on Ethereum' }).click()
  await page.locator('#send-to').fill(RECIPIENT)
  await page.locator('#send-amount').fill('0.25')
  await page.getByRole('button', { name: 'Review' }).click()
  await page.getByText('Goldfelty fee (0.5%)').waitFor({ timeout: 15_000 })
  await shot('08-send-review')
  await page.getByRole('button', { name: /Send with Rabby Wallet/ }).click()
  await page.getByRole('heading', { name: 'Sent' }).waitFor({ timeout: 20_000 })
  await shot('09-sent')
  assert.equal(backend.state.sent.length, 2, 'the transfer, then the fee')
  const [main, fee] = backend.state.sent
  assert.equal(main.to.toLowerCase(), RECIPIENT.toLowerCase())
  assert.equal(BigInt(main.value), 25n * 10n ** 16n)
  assert.equal(main.walletChain, 1, 'the wallet was on Ethereum when it sent')
  assert.equal(main.chainId, '0x1', 'and the transaction itself names the chain')
  assert.equal(fee.to, FEE_ADDRESS)
  assert.equal(BigInt(fee.value), 125n * 10n ** 13n, '0.5% of 0.25 ETH')
  await page.getByRole('button', { name: 'Done' }).click()

  step('receive, wallet, activity, settings')
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click()
  await page.locator('#recv-asset').waitFor()
  await page.locator('.route').first().click()
  await page.getByRole('button', { name: /Copy address/ }).waitFor()
  await shot('10-receive')
  await page.locator('.sidebar .wallets button').first().click()
  await page.getByRole('heading', { name: 'Balances' }).waitFor()
  await shot('11-wallet')
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByText('Goldfelty fee').first().waitFor()
  await shot('12-activity')
  await page.locator('.sidebar-foot').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Connected wallets' }).waitFor()
  await shot('13-settings')
  await page.locator('.content').evaluate((el) => el.scrollTo(0, el.scrollHeight / 2))
  await shot('13b-settings-middle')
  await page.locator('.content').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot('13c-settings-end')

  step('track an Exodus wallet, which can’t connect')
  const exodusAddress = Wallet.createRandom().address
  await page.locator('.source-heading').getByRole('button', { name: 'Connect a wallet' }).click()
  await page.getByText('Can’t connect').waitFor()
  await page.getByRole('button', { name: /^Exodus\s*Desktop and phone apps/ }).click()
  await page.locator('#track-address').fill(exodusAddress.toLowerCase())
  await shot('13d-track-exodus')
  await page.getByRole('button', { name: 'Track', exact: true }).click()
  await page.locator('.sidebar .wallets').getByText('Exodus').waitFor({ timeout: 10_000 })
  await page.locator('.sidebar .wallets button', { hasText: 'Exodus' }).click()
  await page.getByText(/send and receive with Exodus/).waitFor()
  await shot('13e-exodus-wallet')
  assert.ok((await page.locator('.wallet-head .mono').textContent()).includes(exodusAddress), 'stored checksummed')

  step('connect Solflare (Solana) and UniSat (Bitcoin) from the same browser tab')
  for (const [name, family] of [
    ['Solflare', 'Solana'],
    ['UniSat', 'Bitcoin']
  ]) {
    await page.locator('.source-heading').getByRole('button', { name: 'Connect a wallet' }).click()
    await page.getByRole('button', { name: new RegExp(`${name}\\s*Found in your browser · ${family}`) }).click()
    await page.getByText(new RegExp(`${name} connected`)).waitFor({ timeout: 15_000 })
  }
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await page.getByText('SOL', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByText('BTC', { exact: true }).first().waitFor({ timeout: 20_000 })
  await shot('13f-overview-multichain')

  step('send SOL: the fee is a second instruction in the same transaction')
  await page.getByRole('button', { name: 'Send', exact: true }).first().click()
  await page.locator('#send-asset').selectOption('SOL')
  await page.locator('.route', { hasText: 'on Solana' }).click()
  await page.locator('#send-to').fill(SOL_RECIPIENT)
  await page.locator('#send-amount').fill('1.5')
  await page.getByRole('button', { name: 'Review' }).click()
  await page.getByText('Goldfelty fee (0.5%)').waitFor({ timeout: 15_000 })
  await page.getByText(/one transaction to approve/).waitFor()
  await shot('13g-send-sol-review')
  await page.getByRole('button', { name: /Send with Solflare/ }).click()
  await page.getByRole('heading', { name: 'Sent' }).waitFor({ timeout: 20_000 })
  assert.equal(backend.state.solSigned.length, 1, 'one signature for transfer and fee together')
  assert.equal(chainLog.solSent.length, 1)
  {
    // The two System Program transfers inside, by data: [2,0,0,0] then the lamports.
    const message = backend.state.solSigned[0]
    const hex = Buffer.from(message).toString('hex')
    const lamports = (n) => '02000000' + Buffer.from(new BigUint64Array([n]).buffer).toString('hex')
    assert.ok(hex.includes(lamports(1_500_000_000n)), 'the recipient gets 1.5 SOL')
    assert.ok(hex.includes(lamports(7_500_000n)), 'the fee is 0.5% of 1.5 SOL')
    assert.ok(hex.includes(Buffer.from(bs58Bytes(SOL_FEE_ADDRESS)).toString('hex')), 'paid to the Solana fee address')
  }
  await page.getByRole('button', { name: 'Done' }).click()

  step('send BTC: the fee is an output of the same transaction')
  await page.locator('#send-asset').selectOption('BTC')
  await page.locator('.route', { hasText: 'on Bitcoin' }).click()
  await page.locator('#send-to').fill(BTC_RECIPIENT)
  await page.locator('#send-amount').fill('0.02')
  await page.getByRole('button', { name: 'Review' }).click()
  await page.getByText('Goldfelty fee (0.5%)').waitFor({ timeout: 15_000 })
  await shot('13h-send-btc-review')
  await page.getByRole('button', { name: /Send with UniSat/ }).click()
  await page.getByRole('heading', { name: 'Sent' }).waitFor({ timeout: 20_000 })
  await shot('13i-sent-btc')
  assert.equal(chainLog.btcSent.length, 1)
  {
    const outs = chainLog.btcSent[0].outs.map((o) => [bitcoin.address.fromOutputScript(o.script), o.value])
    assert.deepEqual(outs[0], [BTC_RECIPIENT, 2_000_000])
    assert.deepEqual(outs[1], [BTC_FEE_ADDRESS, 10_000], '0.5% of 0.02 BTC')
    assert.equal(outs[2][0], BTC_ADDRESS, 'change comes back')
  }
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByText('Sent BTC').first().waitFor()
  await shot('13j-activity-multichain')

  step('dark appearance')
  await page.evaluate(() => window.goldfelty.settings.update({ theme: 'dark' }))
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await page.locator('table.holdings').waitFor()
  await shot('14-overview-dark')
  await page.getByRole('button', { name: 'Send', exact: true }).first().click()
  await page.locator('#send-asset').waitFor()
  await shot('15-send-dark')

  step('lock, a wrong password, unlock')
  await page.locator('.sidebar-foot').getByRole('button', { name: 'Lock' }).click()
  await page.getByRole('button', { name: 'Unlock' }).waitFor()
  await shot('16-locked')
  await page.getByLabel('Password').fill('wrong-password-1A!')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByText('Incorrect password.').waitFor({ timeout: 10_000 })
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Connect a wallet' }).first().click()
  await page.getByText(/Found in your browser/).first().waitFor({ timeout: 10_000 })
  await shot('17-connect-dark')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.goldfelty.settings.update({ theme: 'light' }))
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await page.locator('.chart svg path.chart-line').waitFor()
  await shot('18-overview-light-final')

  step('nothing readable on disk')
  const files = fs.readdirSync(USER_DATA).filter((f) => /^(state|vault|prefs)/.test(f))
  for (const f of files) {
    const raw = fs.readFileSync(path.join(USER_DATA, f), 'utf8')
    assert.ok(!raw.toLowerCase().includes(userKey.address.slice(2).toLowerCase()), `${f} must not contain the wallet address`)
    assert.ok(!raw.includes('alice@example.com'), `${f} must not contain the email`)
  }

  await browser.close()
  await app.close()
  mocks.server.close()

  const real = problems.filter((p) => !/Failed to load resource/.test(p))
  if (real.length) {
    console.error('\nProblems:\n' + real.join('\n'))
    process.exit(1)
  }
  console.log(`\nAll good. Screenshots in ${OUT}`)
  process.exit(0)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
