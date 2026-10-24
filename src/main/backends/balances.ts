import { BackendRefusal, getJson, jsonRpc, postJson } from './http.ts'
import type { Chain, Settings, TokenDef } from '../../shared/types.ts'

/**
 * Balances on chains that aren't EVM, one reader per family. Each returns
 * base units per token key. Tokens a reader can't see come back as 0n only
 * when the chain says so; a failed request throws, so the portfolio can fall
 * back to cached figures and mark itself degraded instead of showing zero.
 */

/** Public APIs here are rate-limited; don't ask about the same address more often than this. */
const MIN_INTERVAL_MS: Record<string, number> = { dogecoin: 5 * 60_000 }
const DEFAULT_INTERVAL_MS = 60_000
const recent = new Map<string, { at: number; result: Map<string, bigint> }>()

export function clearBalanceMemory(): void {
  recent.clear()
}

export async function readBalances(chain: Chain, address: string, tokens: TokenDef[], settings: Settings, now = Date.now()): Promise<Map<string, bigint>> {
  const key = `${chain.id}|${address}`
  const hit = recent.get(key)
  if (hit && now - hit.at < (MIN_INTERVAL_MS[chain.key] ?? DEFAULT_INTERVAL_MS)) return hit.result

  let result: Map<string, bigint>
  switch (chain.family) {
    case 'utxo':
      result = await readUtxo(chain, address, tokens, settings)
      break
    case 'solana':
      result = await readSolana(chain, address, tokens, settings)
      break
    case 'tron':
      result = await readTron(chain, address, tokens, settings)
      break
    case 'xrp':
      result = await readXrp(chain, address, tokens, settings)
      break
    default:
      throw new Error(`No balance reader for ${chain.name}.`)
  }
  recent.set(key, { at: now, result })
  return result
}

function nativeOnly(tokens: TokenDef[], value: bigint): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const t of tokens) if (t.address === null) out.set(t.key, value)
  return out
}

/* ---- Bitcoin, Litecoin (Esplora) and Dogecoin (Blockchair) --------------------- */

interface EsploraStats {
  funded_txo_sum: number
  spent_txo_sum: number
}

async function readUtxo(chain: Chain, address: string, tokens: TokenDef[], settings: Settings): Promise<Map<string, bigint>> {
  if (chain.key === 'dogecoin') {
    const body = await getJson<{ data?: Record<string, { address?: { balance?: number | string } }> }>(
      chain.id,
      settings,
      `/dashboards/address/${encodeURIComponent(address)}`
    )
    const entry = body.data?.[address]?.address
    if (!entry) throw new Error('Unexpected answer from the Dogecoin API.')
    return nativeOnly(tokens, BigInt(String(entry.balance ?? 0)))
  }
  const body = await getJson<{ chain_stats?: EsploraStats; mempool_stats?: EsploraStats }>(chain.id, settings, `/address/${encodeURIComponent(address)}`)
  if (!body.chain_stats) throw new Error(`Unexpected answer from the ${chain.name} API.`)
  const settled = BigInt(body.chain_stats.funded_txo_sum) - BigInt(body.chain_stats.spent_txo_sum)
  const pending = body.mempool_stats ? BigInt(body.mempool_stats.funded_txo_sum) - BigInt(body.mempool_stats.spent_txo_sum) : 0n
  return nativeOnly(tokens, settled + pending)
}

/* ---- Solana ------------------------------------------------------------------------ */

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } }
}

async function readSolana(chain: Chain, address: string, tokens: TokenDef[], settings: Settings): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  for (const token of tokens) {
    if (token.address === null) {
      const r = await jsonRpc<{ value: number }>(chain.id, settings, 'getBalance', [address, { commitment: 'confirmed' }])
      out.set(token.key, BigInt(r.value))
      continue
    }
    const r = await jsonRpc<{ value: ParsedTokenAccount[] }>(chain.id, settings, 'getTokenAccountsByOwner', [
      address,
      { mint: token.address },
      { encoding: 'jsonParsed', commitment: 'confirmed' }
    ])
    let sum = 0n
    for (const acct of r.value ?? []) sum += BigInt(acct.account.data.parsed.info.tokenAmount.amount)
    out.set(token.key, sum)
  }
  return out
}

/* ---- Tron (TronGrid) ------------------------------------------------------------------ */

interface TronAccount {
  balance?: number
  trc20?: Array<Record<string, string>>
}

async function readTron(chain: Chain, address: string, tokens: TokenDef[], settings: Settings): Promise<Map<string, bigint>> {
  const body = await getJson<{ data?: TronAccount[]; success?: boolean }>(chain.id, settings, `/v1/accounts/${encodeURIComponent(address)}`)
  if (body.success === false || !Array.isArray(body.data)) throw new Error('Unexpected answer from TronGrid.')
  // An address that has never received anything has no account yet: that is a zero balance.
  const account = body.data[0] ?? {}
  const trc20 = new Map<string, string>()
  for (const entry of account.trc20 ?? []) for (const [contract, amount] of Object.entries(entry)) trc20.set(contract, amount)
  const out = new Map<string, bigint>()
  for (const token of tokens) {
    out.set(token.key, token.address === null ? BigInt(account.balance ?? 0) : BigInt(trc20.get(token.address) ?? '0'))
  }
  return out
}

/* ---- XRP Ledger --------------------------------------------------------------------- */

async function readXrp(chain: Chain, address: string, tokens: TokenDef[], settings: Settings): Promise<Map<string, bigint>> {
  try {
    const body = await postJson<{ result?: { account_data?: { Balance?: string }; error?: string; status?: string } }>(chain.id, settings, '', {
      method: 'account_info',
      params: [{ account: address, ledger_index: 'validated' }]
    })
    const result = body.result
    // An address that was never funded doesn't exist on the ledger yet: zero.
    if (result?.error === 'actNotFound') return nativeOnly(tokens, 0n)
    if (!result?.account_data?.Balance) throw new Error('Unexpected answer from the XRP Ledger.')
    return nativeOnly(tokens, BigInt(result.account_data.Balance))
  } catch (error) {
    if (error instanceof BackendRefusal && /actNotFound/.test(error.body)) return nativeOnly(tokens, 0n)
    throw error
  }
}
