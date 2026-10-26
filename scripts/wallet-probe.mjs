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
import { BrowserBridge } from '../src/main/connections/browserBridge.ts'
import { WALLET_REGISTRY } from '../src/shared/walletRegistry.ts'

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
  zeal: 'heamnjbnflcikcggoiplibfommfbkjpj',
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

async function download(storeId, dir) {
  const url =
    'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=134.0.0.0' +
    `&acceptformat=crx2,crx3&x=id%3D${storeId}%26installsource%3Dondemand%26uc`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Chrome Web Store answered ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error(`not a CRX (${buf.length} bytes)`)
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
  return { dir: unpacked, version: manifest.version, mv: manifest.manifest_version }
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
        // Some wallets open a window and also reject at once (not set up yet).
        const opened = ctx.pages().filter((p) => !before.has(p))
        outcome = { rdns: d.rdns, method, ok: first.ok || opened.length > 0, value: first.value + (opened.length ? ' (and opened a window)' : '') }
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
