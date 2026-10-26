/**
 * Checks every wallet in the registry against the real extension.
 *
 * For each wallet that ships as a Chrome extension, this downloads it from the
 * Chrome Web Store, loads it into Chromium, opens Goldfelty's real bridge page
 * (served by the app's own BrowserBridge) and records:
 *   - what the wallet announced (rdns, name, chain family),
 *   - whether Goldfelty maps it to the right registry entry and chains,
 *   - whether a request makes it through the bridge to the wallet (a read
 *     call for EVM wallets, then a connect request that should make the
 *     wallet answer or open its own window),
 *   - any Content-Security-Policy violation or error on the bridge page.
 *
 * The wallets are fresh installs with no account, so a connect request is
 * expected to open the wallet's onboarding or approval window rather than
 * return addresses. What matters is that it reaches the wallet.
 *
 *   xvfb-run -a node scripts/wallet-probe.mjs [walletId ...]
 *
 * Needs network access to the Chrome Web Store, so it runs in CI
 * (.github/workflows/wallet-probe.yml). Results go to WALLET_PROBE_OUT
 * (default: release/wallet-probe) as results.json, a Markdown summary and a
 * screenshot per wallet.
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { BrowserBridge, PAGE_CSP, SECURITY_HEADERS } from '../src/main/connections/browserBridge.ts'
import { WALLET_REGISTRY } from '../src/shared/walletRegistry.ts'
import { BRIDGE_PAGE } from '../src/main/connections/bridgePage.ts'

const require = createRequire(import.meta.url)
let pw
try {
  pw = require('playwright')
} catch {
  pw = require('playwright-core')
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.WALLET_PROBE_OUT ?? join(ROOT, 'release', 'wallet-probe')
mkdirSync(OUT, { recursive: true })

/** Chrome Web Store ids. null: built into a browser, not an extension. */
const STORE_IDS = {
  metamask: 'nkbihfbeogaeaoehlefnkodbefgpgknn',
  rabby: 'acmacodkjbdgmoleebolmdjonilkdbch',
  coinbase: 'hnfanknocfeofbddgcijnmhnfnkdnaad',
  phantom: 'bfnaelmomeimhlpmgjnjophhpkkoljpa',
  brave: null,
  trust: 'egjidjbpglichdcondbcbdnbeeppgdph',
  okx: 'mcohilncbfahbmgdjkbpemcciiolgcge',
  rainbow: 'opfgelmcmbiajamepnmloijbpoleiama',
  zerion: 'klghhnkeealcohjjanjjdaeeggmfmlpl',
  'frame-extension': 'ldcoohedfbjoobcadoglnnmmfbdlmmhf',
  taho: 'eajafomhmkipbjmfmhebemolkcicgfmd',
  enkrypt: 'kkpllkodjeloidieedojogacfhpaihoh',
  exodus: 'aholpfdialjgjfhomihkjbmgjidlcdno',
  backpack: 'aflkmfhebedbjioipglgcbcmnbpgliof',
  bitget: 'jiidiaalihmmhddjgbnbgdfflelocpak',
  uniswap: 'nnpmfplkfogfpmcngplhnbdnnilmcdcg',
  core: 'agoakfejjabomempkjlepdflaleeobhb',
  talisman: 'fijngjgcjhjmmpcmkeiomlglpeiijkld',
  subwallet: 'onhogfjeacnfoofkfgppdlbmlmnplgbn',
  ronin: 'fnjhmkhhmkbjkkabndcnnogagogbneec',
  tokenpocket: 'mfgccjchihfkkindfppnaooecgfneiii',
  coin98: 'aeachknmefphepccionboohckonoeemg',
  safepal: 'lgmpcpglpngdoalbgeoldeajfclnhafa',
  ctrl: 'hmeobnfnfcmdkdcmlblgagmfpfboieaf',
  onekey: 'jnmbobjmhlngoefaiojfljckilhhlhcj',
  magiceden: 'mkpegjkblkkefacfnmkajcjmabijhclg',
  wigwam: 'lccbohhgfkdikahanoclbdmaolidjdfl',
  fordefi: 'hcmehenccjdmfbojapcbcofkgdpbnlle',
  ambire: 'ehgjhhccekdedpbkifaojjaefeohnoea',
  gate: 'cpmkedoipcpimgecpmgpldfpohjplkpp',
  opera: null,
  solflare: 'bhhhlbepdkbapadjdnnojkbgioiodbic',
  unisat: 'ppbibelpcjmhbdihakflkdcoccbgbkpo',
  xverse: 'idnnbdplmphpflfnlkomgpfbpcgelopg',
  leather: 'ldinpeekobnhjjdofggfgjlcehhmanlj',
  tronlink: 'ibnejdfjmmkpcnlpebklmnkoeoihofec',
  cryptocom: 'hifafgmccdpekplomjjkcfgodnhcellj'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, sleep(ms).then(() => { throw Object.assign(new Error(`${label}: no answer in ${ms / 1000}s`), { code: 'PROBE_TIMEOUT' }) })])

async function fetchCrx(storeId) {
  let last = ''
  // An empty answer can mean the item needs a newer Chrome, or isn't offered in this region.
  for (const prod of ['134.0.0.0', '141.0.0.0', '120.0.0.0']) {
    const url =
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${prod}` +
      `&acceptformat=crx2,crx3&x=id%3D${storeId}%26installsource%3Dondemand%26uc`
    const res = await fetch(url, { redirect: 'follow' })
    const buf = Buffer.from(await res.arrayBuffer())
    if (res.ok && buf.length >= 16 && buf.toString('latin1', 0, 4) === 'Cr24') return buf
    last = `HTTP ${res.status}, ${buf.length} bytes`
  }
  throw new Error(`the Chrome Web Store wouldn't serve it (${last}); it may not be offered in the runner's region`)
}

async function download(storeId, dir) {
  const buf = await fetchCrx(storeId)
  const version = buf.readUInt32LE(4)
  // CRX3: magic, version, header length, header, zip. CRX2: magic, version, key length, sig length, key, sig, zip.
  const start = version === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12)
  const zip = join(dir, 'ext.zip')
  writeFileSync(zip, buf.subarray(start))
  const unpacked = join(dir, 'unpacked')
  mkdirSync(unpacked, { recursive: true })
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', unpacked], { stdio: 'pipe' })
  } catch (error) {
    // unzip exits 1 on warnings; only a missing manifest is fatal.
    if (!existsSync(join(unpacked, 'manifest.json'))) throw new Error(`unzip failed: ${String(error.stderr || error.message).slice(0, 200)}`)
  }
  // Chrome refuses to load an unpacked extension that keeps the store's signature folder.
  rmSync(join(unpacked, '_metadata'), { recursive: true, force: true })
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'))
  const injection = (manifest.content_scripts ?? []).map((c) => ({
    matches: c.matches, exclude: c.exclude_matches, world: c.world ?? 'ISOLATED', allFrames: !!c.all_frames
  }))
  return { dir: unpacked, version: manifest.version, mv: manifest.manifest_version, injection, hosts: manifest.host_permissions ?? manifest.permissions?.filter((p) => /[:*]/.test(p)) ?? [] }
}

/** Objects wallets inject, and which "isX" flags each carries, so we can tell who injected it. */
const GLOBALS = ['ethereum', 'solana', 'phantom', 'coinbaseSolana', 'coinbaseWalletExtension', 'okxwallet', 'bitkeep', 'tronLink', 'tronWeb', 'tron', 'unisat',
  'XverseProviders', 'BitcoinProvider', 'LeatherProvider', '$onekey', 'zerionWallet', 'tally', 'taho', 'exodus', 'xfi', 'ctrl', 'zeal', 'trustwallet',
  'backpack', 'coin98', 'safepal', 'tokenpocket', 'gatewallet', 'enkrypt', 'talismanEth', 'SubWallet', 'ronin', 'fordefi', 'ambire', 'magicEden', 'wigwamEthereum']

function snapshotGlobals(names) {
  const out = {}
  for (const k of names) {
    let v
    try { v = window[k] } catch { continue }
    if (v == null) continue
    const flags = []
    try { for (const p in v) if (/^is[A-Z]/.test(p) && v[p] === true) flags.push(p) } catch {}
    out[k] = flags.slice(0, 10)
  }
  return out
}

/** What a plain page (no Goldfelty code, no CSP) sees: EIP-6963, the Wallet Standard and globals. */
async function plainDetect(names) {
  const found = { eip6963: [], standard: [] }
  window.addEventListener('eip6963:announceProvider', (e) => {
    try { found.eip6963.push(`${e.detail.info.rdns} (${e.detail.info.name})`) } catch {}
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  const api = { register: (...ws) => { for (const w of ws) found.standard.push(String(w && w.name)); return () => {} } }
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(api) } catch {} })
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })) } catch {}
  await new Promise((r) => setTimeout(r, 3000))
  found.eip6963 = [...new Set(found.eip6963)]
  found.standard = [...new Set(found.standard)]
  found.globals = {}
  for (const k of names) {
    let v
    try { v = window[k] } catch { continue }
    if (v != null) found.globals[k] = true
  }
  return found
}

let blank = null
async function blankServer() {
  if (blank) return blank
  const { createServer } = await import('node:http')
  // /csp carries the bridge page's CSP and nothing else; /headers its other
  // security headers without the CSP. Comparing the two finds what stops a wallet.
  // /bridge-html is the real bridge page with its headers but no bridge
  // behind it; /bridge-noscript the same without its script; /redirect the
  // 303 hop the real link takes. Together they find what a wallet reacts to.
  const noScript = BRIDGE_PAGE.replace(/<script>[\s\S]*<\/script>/, '')
  const server = createServer((req, res) => {
    if (req.url.startsWith('/redirect')) {
      res.writeHead(303, { location: '/', ...SECURITY_HEADERS })
      return res.end()
    }
    const all = { ...SECURITY_HEADERS, 'content-security-policy': PAGE_CSP }
    const extra = req.url.startsWith('/csp') ? { 'content-security-policy': PAGE_CSP }
      : req.url.startsWith('/headers') ? SECURITY_HEADERS
      : req.url.startsWith('/bridge') ? all : {}
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra })
    res.end(req.url.startsWith('/bridge-html') ? BRIDGE_PAGE : req.url.startsWith('/bridge-noscript') ? noScript : '<!doctype html><title>blank</title><p>blank</p>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.unref()
  blank = server.address().port
  return blank
}

function describe(value) {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value).slice(0, 160)
  } catch {
    return String(value).slice(0, 160)
  }
}

async function probe(entry, extDirs) {
  const result = {
    id: entry.id,
    name: entry.name,
    expectedFamilies: entry.families ?? ['evm'],
    store: STORE_IDS[entry.id] ?? null,
    version: null,
    announced: [],
    matchedFamilies: [],
    missingFamilies: [],
    requests: [],
    cspViolations: [],
    pageErrors: [],
    error: null,
    verdict: 'unknown'
  }
  const bridge = new BrowserBridge()
  await bridge.start()
  const profile = mkdtempSync(join(tmpdir(), 'gf-probe-profile-'))
  let ctx
  try {
    ctx = await pw.chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1100, height: 800 },
      args: [`--disable-extensions-except=${extDirs.join(',')}`, `--load-extension=${extDirs.join(',')}`, '--no-first-run']
    })
    // Let service workers start and any welcome tab open.
    await sleep(4000)

    const page = await ctx.newPage()
    page.on('console', (m) => {
      const text = m.text()
      if (/Content Security Policy|Refused to/i.test(text)) result.cspViolations.push(text.slice(0, 300))
      else if (m.type() === 'error') result.pageErrors.push(text.slice(0, 300))
    })
    page.on('pageerror', (e) => result.pageErrors.push(String(e).slice(0, 300)))
    await page.goto(bridge.issueLink(), { waitUntil: 'load' })
    // The page scans at once, at 0.6 s and at 2.5 s, and some wallets inject late.
    const deadline = Date.now() + 9000
    while (Date.now() < deadline) {
      await sleep(500)
      if (bridge.status().pages > 0 && Date.now() > deadline - 4000) break
    }
    await sleep(1500)

    const detected = bridge.detected()
    result.announced = detected.map((d) => ({ rdns: d.rdns, name: d.name, family: d.family, providerId: d.providerId }))
    const mine = detected.filter((d) => d.providerId === entry.id)
    result.matchedFamilies = [...new Set(mine.map((d) => d.family))]
    result.missingFamilies = result.expectedFamilies.filter((f) => !result.matchedFamilies.includes(f))
    result.globals = await page.evaluate(snapshotGlobals, GLOBALS).catch((e) => ({ error: String(e.message) }))

    // Not (fully) found: is it our page, the 127.0.0.1 host, or http itself?
    if (result.missingFamilies.length) {
      const port = await blankServer()
      result.compare = {}
      for (const [label, url] of [
        ['http://localhost (plain page)', `http://localhost:${port}/`],
        ['http://localhost + bridge CSP only', `http://localhost:${port}/csp`],
        ['http://localhost + bridge security headers, no CSP', `http://localhost:${port}/headers`],
        ['real bridge HTML + headers, no bridge', `http://localhost:${port}/bridge-html`],
        ['bridge HTML without its script', `http://localhost:${port}/bridge-noscript`],
        ['plain page reached by a 303 redirect', `http://localhost:${port}/redirect`],
        ['http://127.0.0.1 (plain page)', `http://127.0.0.1:${port}/`],
        ['https://example.com', 'https://example.com/']
      ]) {
        const other = await ctx.newPage()
        try {
          await other.goto(url, { waitUntil: 'load', timeout: 20_000 })
          await sleep(2500)
          result.compare[label] = await other.evaluate(plainDetect, GLOBALS)
        } catch (error) {
          result.compare[label] = { error: String(error.message).slice(0, 160) }
        }
        await other.close().catch(() => {})
      }
      // Fresh installs can be slow to start: does a reload of the bridge tab, a bit later, find it?
      await page.reload({ waitUntil: 'load' }).catch(() => {})
      await sleep(8000)
      const again = bridge.detected().filter((d) => d.providerId === entry.id)
      result.afterReload = [...new Set(again.map((d) => d.family))]
    }

    for (const d of mine) {
      if (d.family === 'evm') {
        for (const method of ['eth_chainId', 'eth_accounts']) {
          try {
            const value = await withTimeout(bridge.request(d.rdns, d.name, method, [], 15_000), 15_000, method)
            result.requests.push({ rdns: d.rdns, method, ok: true, value: describe(value) })
          } catch (error) {
            result.requests.push({ rdns: d.rdns, method, ok: false, value: String(error.message).slice(0, 160) })
          }
        }
      }
      // The connect request: on a fresh install the wallet should answer or open its own window.
      const method = d.family === 'evm' ? 'eth_requestAccounts' : 'gf_connect'
      const before = new Set(ctx.pages())
      const popup = ctx.waitForEvent('page', { timeout: 12_000 }).catch(() => null)
      const answer = bridge.request(d.rdns, d.name, method, [], 12_000).then(
        (value) => ({ ok: true, value: describe(value) }),
        (error) => ({ ok: false, value: String(error.message).slice(0, 160) })
      )
      const first = await Promise.race([answer.then((a) => ({ kind: 'answer', ...a })), popup.then((p) => (p ? { kind: 'popup', page: p } : null))])
      let outcome
      if (first?.kind === 'popup') {
        await sleep(1500)
        const url = first.page.url()
        outcome = { rdns: d.rdns, method, ok: true, value: `wallet opened ${url.replace(/^(chrome-extension:\/\/[a-p]{32}).*$/, '$1/…')}` }
      } else if (first?.kind === 'answer') {
        // A wallet that answers, even "not set up yet", got the request: on a
        // fresh install that is the right answer. Only silence, or the bridge
        // itself failing, means the request didn't reach it.
        const opened = ctx.pages().filter((p) => !before.has(p))
        const bridgeFailure = /did not answer|isn’t in this browser|is not in this browser|can’t do that|tab is closed/i.test(first.value)
        outcome = { rdns: d.rdns, method, ok: first.ok || opened.length > 0 || !bridgeFailure, answered: !first.ok, value: first.value + (opened.length ? ' (and opened a window)' : '') }
      } else {
        const opened = ctx.pages().filter((p) => !before.has(p))
        outcome = { rdns: d.rdns, method, ok: opened.length > 0, value: opened.length ? 'wallet opened a window' : 'no answer and no window' }
      }
      result.requests.push(outcome)
      for (const p of ctx.pages()) if (!before.has(p)) await p.close().catch(() => {})
    }

    await page.screenshot({ path: join(OUT, `${entry.id}.png`) }).catch(() => {})
  } catch (error) {
    result.error = String(error.message).slice(0, 300)
  } finally {
    await ctx?.close().catch(() => {})
    await bridge.stop()
    rmSync(profile, { recursive: true, force: true })
  }

  const connectOk = result.requests.filter((r) => r.method === 'eth_requestAccounts' || r.method === 'gf_connect')
  if (result.error) result.verdict = 'error'
  else if (!result.matchedFamilies.length) result.verdict = 'not detected'
  else if (result.cspViolations.length) result.verdict = 'blocked by CSP'
  else if (result.missingFamilies.length) result.verdict = 'partial'
  else if (connectOk.length && connectOk.every((r) => r.ok)) result.verdict = 'works'
  else result.verdict = 'connect failed'
  return result
}

function markdown(results) {
  const lines = [
    '## Wallet connection probe',
    '',
    'Each wallet is the real Chrome extension, fresh from the Chrome Web Store, loaded into Chromium with Goldfelty’s bridge page.',
    '',
    '| Wallet | Version | Verdict | Announced as | Missing chains | Connect request | CSP |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const r of results) {
    const announced = r.announced.map((a) => `\`${a.rdns}\` ${a.name}${a.providerId === r.id ? '' : ` → ${a.providerId}`}`).join('<br>') || '–'
    const connect = r.requests.filter((q) => q.method === 'eth_requestAccounts' || q.method === 'gf_connect').map((q) => `${q.ok ? '✅' : '❌'} ${q.rdns}: ${q.value}`).join('<br>') || (r.error ? `error: ${r.error}` : '–')
    lines.push(
      `| ${r.name} | ${r.version ?? '–'} | **${r.verdict}** | ${announced} | ${r.missingFamilies.join(', ') || '–'} | ${connect.replace(/\|/g, '\\|')} | ${r.cspViolations.length ? `${r.cspViolations.length} blocked` : '–'} |`
    )
  }
  lines.push('', '### Injected objects on the bridge page', '', '| Wallet | Objects and their is… flags |', '| --- | --- |')
  for (const r of results) {
    if (!r.globals || !Object.keys(r.globals).length) continue
    lines.push(`| ${r.name} | ${Object.entries(r.globals).map(([k, f]) => `${k}${Array.isArray(f) && f.length ? ` (${f.join(', ')})` : ''}`).join('; ')} |`)
  }
  const odd = results.filter((r) => r.compare || (r.verdict !== 'works' && r.verdict !== 'built into its browser'))
  if (odd.length) {
    lines.push('', '### Diagnostics', '')
    for (const r of odd) {
      lines.push(`**${r.name}** (${r.verdict})`, '')
      if (r.injection) lines.push(`- content scripts: ${JSON.stringify(r.injection).slice(0, 400)}`)
      if (r.globals) lines.push(`- globals on the bridge page: ${JSON.stringify(r.globals).slice(0, 400)}`)
      for (const [label, c] of Object.entries(r.compare ?? {})) lines.push(`- ${label}: ${JSON.stringify(c).slice(0, 400)}`)
      if (r.afterReload) lines.push(`- after reloading the bridge tab: ${r.afterReload.length ? `found (${r.afterReload.join(', ')})` : 'still missing'}`)
      if (r.error) lines.push(`- error: ${r.error}`)
      lines.push('')
    }
  }
  const csp = results.filter((r) => r.cspViolations.length)
  if (csp.length) {
    lines.push('', '### CSP violations', '')
    for (const r of csp) for (const v of r.cspViolations.slice(0, 3)) lines.push(`- **${r.name}**: ${v.replace(/\|/g, '\\|')}`)
  }
  return lines.join('\n') + '\n'
}

const only = process.argv.slice(2)
const entries = WALLET_REGISTRY.filter((w) => !only.length || only.includes(w.id))
const results = []
for (const entry of entries) {
  const storeId = STORE_IDS[entry.id]
  if (storeId === undefined) {
    results.push({ id: entry.id, name: entry.name, verdict: 'no store id', announced: [], missingFamilies: [], requests: [], cspViolations: [] })
    continue
  }
  if (storeId === null) {
    results.push({ id: entry.id, name: entry.name, verdict: 'built into its browser', announced: [], missingFamilies: [], requests: [], cspViolations: [] })
    continue
  }
  const work = mkdtempSync(join(tmpdir(), `gf-probe-${entry.id}-`))
  // For checking this script itself: WALLET_PROBE_LOCAL='{"rabby":"/path/to/unpacked"}'.
  const local = JSON.parse(process.env.WALLET_PROBE_LOCAL || '{}')[entry.id]
  let ext
  try {
    ext = local ? { dir: local, version: 'local', mv: 3 } : await download(storeId, work)
  } catch (error) {
    results.push({ id: entry.id, name: entry.name, verdict: 'download failed', error: error.message, announced: [], missingFamilies: [], requests: [], cspViolations: [] })
    console.log(`${entry.name}: download failed (${error.message})`)
    continue
  }
  const r = await withTimeout(probe(entry, [ext.dir]), 120_000, entry.name).catch((error) => ({
    id: entry.id, name: entry.name, verdict: 'error', error: error.message, announced: [], missingFamilies: [], requests: [], cspViolations: []
  }))
  r.version = ext.version
  r.injection = ext.injection
  r.hosts = ext.hosts
  results.push(r)
  console.log(`${entry.name} ${ext.version}: ${r.verdict}  ${r.announced?.map((a) => a.rdns).join(', ') ?? ''}`)
  rmSync(work, { recursive: true, force: true })
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
const md = markdown(results)
writeFileSync(join(OUT, 'summary.md'), md)
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
console.log(md)
process.exit(0)
