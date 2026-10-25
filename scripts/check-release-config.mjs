/**
 * Checks the repository's release secrets without revealing them.
 *
 * Fee addresses are validated with the app's own address rules and shown
 * shortened (first and last characters), so the owner can confirm each is
 * theirs. Addresses are public anyway; the shortened form also gets past
 * GitHub's masking of the full secret. The admin token and Cloudflare
 * credentials are never printed: the token's length is checked, and the
 * Cloudflare pair is checked by asking Cloudflare.
 *
 *   node scripts/check-release-config.mjs
 *
 * Exits non-zero if anything is missing or wrong.
 */
import { appendFileSync } from 'node:fs'
import { detectAddress, validateFor } from '../src/main/addresses.ts'

const rows = []
let failed = false
const ok = (name, detail) => rows.push(['✅', name, detail])
const bad = (name, detail) => {
  rows.push(['❌', name, detail])
  failed = true
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

const FEES = [
  ['GOLDFELTY_FEE_ADDRESS', 'evm', 'ethereum', 'Ethereum (and every EVM network)'],
  ['GOLDFELTY_FEE_ADDRESS_BTC', 'utxo', 'bitcoin', 'Bitcoin'],
  ['GOLDFELTY_FEE_ADDRESS_SOL', 'solana', 'solana', 'Solana'],
  ['GOLDFELTY_FEE_ADDRESS_TRX', 'tron', 'tron', 'Tron']
]

for (const [name, family, key, label] of FEES) {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) {
    bad(name, `Not set: no fee would be charged on ${label}.`)
    continue
  }
  try {
    const address = validateFor(family, key, raw)
    if (family === 'evm' && /^0x0{40}$/i.test(address)) throw new Error('the zero address')
    ok(name, `A valid ${label} address: ${short(address)}`)
  } catch (error) {
    let hint = ''
    try {
      const seen = detectAddress(raw)
      const names = { evm: 'an Ethereum', utxo: 'a Bitcoin-family', solana: 'a Solana', tron: 'a Tron', xrp: 'an XRP' }
      hint = ` It looks like ${names[seen.family] ?? 'another kind of'} address instead.`
    } catch {
      // not an address at all
    }
    bad(name, `Not a valid ${label} address (${raw.length} characters).${hint}`)
  }
}

const admin = process.env.GOLDFELTY_ADMIN_TOKEN ?? ''
if (!admin) bad('GOLDFELTY_ADMIN_TOKEN', 'Not set: the owner dashboard stays off.')
else if (admin.length < 16) bad('GOLDFELTY_ADMIN_TOKEN', `Too short: ${admin.length} characters, needs 16 or more.`)
else if (/^(.)\1+$/.test(admin)) bad('GOLDFELTY_ADMIN_TOKEN', 'One character repeated; use a random value.')
else ok('GOLDFELTY_ADMIN_TOKEN', `Set, ${admin.length} characters.`)

async function cloudflare(path, token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const token = process.env.CLOUDFLARE_API_TOKEN ?? ''
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()
if (!token) bad('CLOUDFLARE_API_TOKEN', 'Not set: the account API can’t deploy.')
if (!account) bad('CLOUDFLARE_ACCOUNT_ID', 'Not set: the account API can’t deploy.')
else if (!/^[0-9a-f]{32}$/.test(account)) bad('CLOUDFLARE_ACCOUNT_ID', 'Should be 32 lowercase hex characters; check you copied the Account ID, not the Zone ID or an email.')
if (token) {
  try {
    // User tokens verify at /user/tokens/verify; account-owned tokens at /accounts/<id>/tokens/verify.
    let v = await cloudflare('/user/tokens/verify', token)
    if (!v.body.success && account) v = await cloudflare(`/accounts/${account}/tokens/verify`, token)
    if (v.body.success && v.body.result?.status === 'active') ok('CLOUDFLARE_API_TOKEN', 'Cloudflare says the token is active.')
    else bad('CLOUDFLARE_API_TOKEN', `Cloudflare doesn’t accept it (${v.status}${v.body.errors?.[0]?.message ? `: ${v.body.errors[0].message}` : ''}).`)
    if (account && /^[0-9a-f]{32}$/.test(account)) {
      // Exactly what the deploy does: Workers and D1 on this account.
      const [workers, d1] = await Promise.all([cloudflare(`/accounts/${account}/workers/scripts`, token), cloudflare(`/accounts/${account}/d1/database`, token)])
      if (workers.body.success && d1.body.success) {
        ok('CLOUDFLARE_ACCOUNT_ID', 'Right account: the token can manage its Workers and D1 databases.')
      } else if (!workers.body.success && !d1.body.success) {
        bad('CLOUDFLARE_ACCOUNT_ID', `The token can’t reach that account (${workers.status}). Either the ID is wrong, or the token’s Account Resources don’t include this account.`)
      } else {
        const missing = workers.body.success ? 'Account > D1 > Edit' : 'Account > Workers Scripts > Edit'
        ok('CLOUDFLARE_ACCOUNT_ID', 'Right account.')
        bad('CLOUDFLARE_API_TOKEN', `Active, but missing the ${missing} permission.`)
      }
    }
  } catch (error) {
    bad('CLOUDFLARE_API_TOKEN', `Couldn’t reach Cloudflare to check: ${error.message}`)
  }
}

const table = ['| | Secret | Result |', '|---|---|---|', ...rows.map((r) => `| ${r[0]} | \`${r[1]}\` | ${r[2]} |`)].join('\n')
console.log(rows.map((r) => `${r[0]} ${r[1]}: ${r[2]}`).join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release secrets\n\n${table}\n`)
process.exit(failed ? 1 : 0)
