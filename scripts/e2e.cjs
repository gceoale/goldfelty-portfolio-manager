/**
 * End-to-end test of the built app.
 *
 * Runs the real Electron app against:
 *   - a fake browser wallet ("Rabby Wallet", EIP-6963) in a separate Chromium
 *     page, opened from the app's own one-time bridge link and backed by an
 *     ethers key here in Node;
 *   - the real goldfelty.com account API code (api/src/accounts.js) on a
 *     local port, with an in-memory database;
 *   - a mock JSON-RPC node and price feed, so balances are deterministic.
 *
 * It walks setup, connects the wallet, signs up, reads balances, sends ETH
 * (checking the transfer and the 0.5% fee go where they should), visits every
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

/* ---- mock servers ------------------------------------------------------------ */

function listen(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const rpcLog = []

function rpcAnswer(chainId, call) {
  rpcLog.push(call.method)
  switch (call.method) {
    case 'eth_chainId':
      return '0x' + chainId.toString(16)
    case 'eth_blockNumber':
      return '0x10'
    case 'eth_getBalance':
      return '0x' + (chainId === 1 ? 15n * 10n ** 17n : 2n * 10n ** 17n).toString(16)
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
          weth: { usd: 3000, usd_24h_change: 1.8 }
        })
      )
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
})();
`

function makeWalletBackend() {
  const state = { chainId: 1, sent: [], signed: [], prompts: [] }
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
        case 'eth_sendTransaction': {
          state.sent.push({ chainId: state.chainId, ...params[0] })
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
      GOLDFELTY_FEE_CONFIG_URL: `${mocks.origin}/fees.json`
    }
  })
  const page = await app.firstWindow()
  page.on('console', (msg) => {
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
    { customRpc: { 1: rpcFor(1), 8453: rpcFor(8453), 42161: rpcFor(42161), 10: rpcFor(10), 137: rpcFor(137) }, priceProviderUrl: mocks.origin }
  )
  assert.equal(updated.ok, true, JSON.stringify(updated))

  step('the renderer cannot reach the network or other channels')
  const blocked = await page.evaluate(async (origin) => {
    try {
      await fetch(origin + '/fees.json')
      return false
    } catch {
      return true
    }
  }, mocks.origin)
  assert.equal(blocked, true, 'renderer fetch must be refused')
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
  await page.getByText('Found in your browser').waitFor({ timeout: 10_000 })
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
  const report = [...mocks.reports.values()][0]
  assert.ok(report, 'the user chose to share, so a total arrived')
  assert.deepEqual(Object.keys(report).sort(), ['currency', 'reportedAt', 'value', 'wallets'])
  const stats = await (await fetch(`${mocks.origin}/v1/admin/stats`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()
  assert.equal(stats.users, 1)
  assert.equal(stats.sharing, 1)

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
  assert.equal(main.chainId, 1)
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
