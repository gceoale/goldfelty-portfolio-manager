import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readBalances, clearBalanceMemory } from '../src/main/backends/balances.ts'
import { CHAIN_BY_ID, TOKENS } from '../src/shared/chains.ts'
import { DEFAULT_SETTINGS } from '../src/main/settings.ts'

/** One local server playing every chain's API, routed by path prefix. */
let failNext = false
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (failNext) {
      failNext = false
      return json(503, { error: 'down' })
    }
    const url = req.url
    if (url.startsWith('/btc/address/')) {
      return json(200, { chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000 }, mempool_stats: { funded_txo_sum: 2_000, spent_txo_sum: 0 } })
    }
    if (url.startsWith('/doge/dashboards/address/')) {
      const address = decodeURIComponent(url.split('/').pop())
      return json(200, { data: { [address]: { address: { balance: 4_200_000_000 } } } })
    }
    if (url.startsWith('/sol')) {
      const call = JSON.parse(body)
      if (call.method === 'getBalance') return json(200, { jsonrpc: '2.0', id: call.id, result: { context: {}, value: 2_500_000_000 } })
      if (call.method === 'getTokenAccountsByOwner') {
        const usdc = call.params[1].mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        const accounts = usdc
          ? [12_000_000, 3_000_000].map((n) => ({ account: { data: { parsed: { info: { tokenAmount: { amount: String(n) } } } } } }))
          : []
        return json(200, { jsonrpc: '2.0', id: call.id, result: { context: {}, value: accounts } })
      }
    }
    if (url.startsWith('/tron/v1/accounts/')) {
      if (url.includes('TEmpty')) return json(200, { data: [], success: true })
      return json(200, { success: true, data: [{ balance: 77_000_000, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '1500000' }] }] })
    }
    if (url.startsWith('/xrp')) {
      const call = JSON.parse(body)
      if (call.params[0].account === 'rUnfunded') return json(200, { result: { error: 'actNotFound', status: 'error' } })
      return json(200, { result: { account_data: { Balance: '25000000' }, status: 'success' } })
    }
    json(404, {})
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

const settings = {
  ...DEFAULT_SETTINGS,
  customRpc: { [-1]: `${origin}/btc`, [-3]: `${origin}/doge`, [-501]: `${origin}/sol`, [-195]: `${origin}/tron`, [-144]: `${origin}/xrp` }
}
const tokensOn = (chainId) => TOKENS.filter((t) => t.chainId === chainId)
const native = (chainId) => TOKENS.find((t) => t.chainId === chainId && t.address === null).key

test('Bitcoin: settled plus pending, in satoshis', async () => {
  clearBalanceMemory()
  const r = await readBalances(CHAIN_BY_ID.get(-1), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', tokensOn(-1), settings)
  assert.equal(r.get(native(-1)), 102_000n)
})

test('Dogecoin through Blockchair', async () => {
  clearBalanceMemory()
  const r = await readBalances(CHAIN_BY_ID.get(-3), 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', tokensOn(-3), settings)
  assert.equal(r.get(native(-3)), 4_200_000_000n)
})

test('Solana: SOL plus every token account for each mint', async () => {
  clearBalanceMemory()
  const r = await readBalances(CHAIN_BY_ID.get(-501), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokensOn(-501), settings)
  assert.equal(r.get(native(-501)), 2_500_000_000n)
  assert.equal(r.get(TOKENS.find((t) => t.chainId === -501 && t.symbol === 'USDC').key), 15_000_000n)
  assert.equal(r.get(TOKENS.find((t) => t.chainId === -501 && t.symbol === 'USDT').key), 0n)
})

test('Tron: TRX and TRC-20 USDT; an unused address is zero, not an error', async () => {
  clearBalanceMemory()
  const r = await readBalances(CHAIN_BY_ID.get(-195), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', tokensOn(-195), settings)
  assert.equal(r.get(native(-195)), 77_000_000n)
  assert.equal(r.get(TOKENS.find((t) => t.chainId === -195 && t.symbol === 'USDT').key), 1_500_000n)
  const empty = await readBalances(CHAIN_BY_ID.get(-195), 'TEmptyAddressForTests', tokensOn(-195), settings)
  assert.equal(empty.get(native(-195)), 0n)
})

test('XRP: drops, and an unfunded account is zero', async () => {
  clearBalanceMemory()
  const r = await readBalances(CHAIN_BY_ID.get(-144), 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', tokensOn(-144), settings)
  assert.equal(r.get(native(-144)), 25_000_000n)
  const unfunded = await readBalances(CHAIN_BY_ID.get(-144), 'rUnfunded', tokensOn(-144), settings)
  assert.equal(unfunded.get(native(-144)), 0n)
})

test('a failing API throws rather than reporting zero', async () => {
  clearBalanceMemory()
  failNext = true
  const only = { ...settings, customRpc: { [-1]: `${origin}/btc` } }
  // The built-in endpoints are unreachable from tests, so every endpoint fails.
  const chain = { ...CHAIN_BY_ID.get(-1), rpcUrls: [] }
  await assert.rejects(readBalances(chain, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', tokensOn(-1), only))
})

test('rate-limited APIs are not asked twice within their interval', async () => {
  clearBalanceMemory()
  const chain = CHAIN_BY_ID.get(-3)
  const address = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'
  await readBalances(chain, address, tokensOn(-3), settings, 1_000)
  failNext = true
  // Within five minutes: served from memory, so the failure above isn't hit.
  const again = await readBalances(chain, address, tokensOn(-3), settings, 1_000 + 60_000)
  assert.equal(again.get(native(-3)), 4_200_000_000n)
  failNext = false
})
