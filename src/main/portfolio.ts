import { formatUnits } from 'ethers'
import type { Store } from './store.ts'
import { fetchPrices } from './prices.ts'
import { rpcBatch } from './rpc.ts'
import { erc20Interface } from './erc20.ts'
import { CHAIN_BY_ID, TOKENS, getChain } from '../shared/chains.ts'
import type {
  AssetHolding,
  Balance,
  HistoryRange,
  Portfolio,
  PortfolioSnapshot,
  TokenDef,
  Wallet
} from '../shared/types.ts'

const RANGE_MS: Record<HistoryRange, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  '1y': 365 * 24 * 3600_000,
  all: Number.POSITIVE_INFINITY
}

interface PlannedCall {
  walletId: string
  token: TokenDef
  method: string
  params: unknown[]
}

/** Which tokens a wallet should be scanned for on a given chain. */
function tokensForWallet(wallet: Wallet, chainId: number): TokenDef[] {
  return TOKENS.filter(
    (token) =>
      token.chainId === chainId &&
      (token.address === null || wallet.enabledTokens.length === 0 || wallet.enabledTokens.includes(token.key))
  )
}

function decodeBalance(raw: string | null, token: TokenDef): bigint | null {
  if (!raw || raw === '0x') return null
  try {
    if (token.address === null) return BigInt(raw)
    const [value] = erc20Interface.decodeFunctionResult('balanceOf', raw)
    return BigInt(value as bigint)
  } catch {
    return null
  }
}

/**
 * Read every balance for every connected wallet, across every enabled chain,
 * and fold it into a portfolio. Chains are queried in parallel and a chain that
 * fails degrades to cached figures instead of failing the whole refresh.
 */
export async function loadPortfolio(store: Store, range: HistoryRange = '24h'): Promise<Portfolio> {
  const settings = store.settings
  const wallets = store.activeWallets()
  const chainIds = settings.enabledChains.filter((id) => CHAIN_BY_ID.has(id))

  const balances: Balance[] = []
  let degraded = wallets.length > 0 && chainIds.length === 0

  const perChain = await Promise.all(
    chainIds.map(async (chainId) => {
      const relevant = wallets.filter((w) => w.chainIds.includes(chainId))
      if (relevant.length === 0) return { chainId, planned: [], results: [], failed: false }

      const planned: PlannedCall[] = []
      for (const wallet of relevant) {
        for (const token of tokensForWallet(wallet, chainId)) {
          planned.push(
            token.address === null
              ? { walletId: wallet.id, token, method: 'eth_getBalance', params: [wallet.address, 'latest'] }
              : {
                  walletId: wallet.id,
                  token,
                  method: 'eth_call',
                  params: [
                    { to: token.address, data: erc20Interface.encodeFunctionData('balanceOf', [wallet.address]) },
                    'latest'
                  ]
                }
          )
        }
      }
      try {
        const results = await rpcBatch(chainId, planned.map((p) => ({ method: p.method, params: p.params })), settings)
        return { chainId, planned, results, failed: false }
      } catch {
        return { chainId, planned, results: [], failed: true }
      }
    })
  )

  for (const chain of perChain) {
    if (chain.failed) degraded = true
    for (let i = 0; i < chain.planned.length; i++) {
      const { walletId, token } = chain.planned[i]
      const decoded = chain.failed ? null : decodeBalance(chain.results[i] ?? null, token)
      let raw: string
      let stale: boolean
      if (decoded !== null) {
        raw = decoded.toString()
        stale = false
        store.cacheBalance(walletId, token.key, raw)
      } else {
        const cached = store.cachedBalance(walletId, token.key)
        raw = cached?.raw ?? '0'
        stale = true
      }
      if (raw === '0') continue
      balances.push({
        walletId,
        tokenKey: token.key,
        chainId: token.chainId,
        symbol: token.symbol,
        raw,
        amount: Number(formatUnits(raw, token.decimals)),
        value: 0,
        stale
      })
    }
  }

  const priceIds = [...new Set(balances.map((b) => TOKENS.find((t) => t.key === b.tokenKey)?.priceId).filter((id): id is string => !!id))]
  const prices = await fetchPrices(priceIds, settings, store)
  if (priceIds.some((id) => prices[id]?.stale)) degraded = true

  const holdings = rollUp(balances, wallets, prices)
  for (const balance of balances) {
    const token = TOKENS.find((t) => t.key === balance.tokenKey)
    const price = token?.priceId ? (prices[token.priceId]?.price ?? 0) : 0
    balance.value = balance.amount * price
  }

  const total = holdings.reduce((sum, h) => sum + h.value, 0)
  const snapshot: PortfolioSnapshot = {
    at: Date.now(),
    total,
    byWallet: Object.fromEntries(
      wallets.map((w) => [w.id, balances.filter((b) => b.walletId === w.id).reduce((s, b) => s + b.value, 0)])
    )
  }
  // A degraded refresh would poison the growth chart with a fake dip.
  if (!degraded) store.pushSnapshot(snapshot)

  const history = store.history
  const { change, changePct } = computeChange(history, total, range)

  return {
    total,
    change,
    changePct,
    holdings,
    balances,
    history: sliceHistory(history, range),
    updatedAt: snapshot.at,
    degraded
  }
}

function rollUp(
  balances: Balance[],
  wallets: Wallet[],
  prices: Record<string, { price: number; change24h: number }>
): AssetHolding[] {
  const bySymbol = new Map<string, AssetHolding>()
  const walletById = new Map(wallets.map((w) => [w.id, w]))

  for (const balance of balances) {
    const token = TOKENS.find((t) => t.key === balance.tokenKey)
    const wallet = walletById.get(balance.walletId)
    if (!token || !wallet) continue
    const quote = token.priceId ? prices[token.priceId] : undefined
    const price = quote?.price ?? 0
    const value = balance.amount * price

    let holding = bySymbol.get(token.symbol)
    if (!holding) {
      holding = {
        symbol: token.symbol,
        name: token.name,
        color: token.color,
        amount: 0,
        value: 0,
        priceId: token.priceId,
        price,
        change24h: quote?.change24h ?? 0,
        sources: []
      }
      bySymbol.set(token.symbol, holding)
    }
    holding.amount += balance.amount
    holding.value += value
    holding.price = price || holding.price
    holding.sources.push({
      walletId: wallet.id,
      walletLabel: wallet.label,
      walletColor: wallet.color,
      chainId: token.chainId,
      chainName: getChain(token.chainId).name,
      tokenKey: token.key,
      address: wallet.address,
      amount: balance.amount,
      value
    })
  }

  return [...bySymbol.values()]
    .map((h) => ({ ...h, sources: h.sources.sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.value - a.value || b.amount - a.amount)
}

export function computeChange(
  history: PortfolioSnapshot[],
  total: number,
  range: HistoryRange
): { change: number; changePct: number } {
  if (history.length === 0) return { change: 0, changePct: 0 }
  const window = RANGE_MS[range]
  const cutoff = Number.isFinite(window) ? Date.now() - window : 0
  const baseline = history.find((s) => s.at >= cutoff) ?? history[0]
  if (!baseline || baseline.total === 0) return { change: 0, changePct: 0 }
  const change = total - baseline.total
  return { change, changePct: (change / baseline.total) * 100 }
}

export function sliceHistory(history: PortfolioSnapshot[], range: HistoryRange): PortfolioSnapshot[] {
  const window = RANGE_MS[range]
  if (!Number.isFinite(window)) return history
  const cutoff = Date.now() - window
  const sliced = history.filter((s) => s.at >= cutoff)
  // Always give the chart a left-hand anchor so short ranges still draw a line.
  if (sliced.length < 2 && history.length >= 2) return history.slice(-2)
  return sliced
}
