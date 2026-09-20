import { useMemo, useState, type JSX } from 'react'
import type { RouteOption } from '@shared/types.js'
import { Banner, Button } from './ui.js'
import { IconCheck, IconSearch } from './Icons.js'
import { money, shortAddress, tokenAmount } from '../lib/format.js'

/**
 * The route step, shared by Send and Receive.
 *
 * A 50-wallet vault on five networks produces 250 candidate routes for a token
 * like USDC, so the list needs filtering to stay usable — but the choice itself
 * is never made automatically. Picking a wallet on the user's behalf is how
 * funds leave from the wrong account, or arrive on a chain they cannot reach.
 */
export function RouteChooser({
  routes,
  selected,
  onSelect,
  symbol,
  mode,
  currency,
  requiredAmount = 0
}: {
  routes: RouteOption[]
  selected: RouteOption | null
  onSelect: (route: RouteOption) => void
  symbol: string
  mode: 'send' | 'receive'
  currency: string
  requiredAmount?: number
}): JSX.Element {
  const [chainFilter, setChainFilter] = useState<number | 'all'>('all')
  const [query, setQuery] = useState('')

  const chains = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; color: string; count: number }>()
    for (const route of routes) {
      const entry = seen.get(route.chainId) ?? {
        id: route.chainId,
        name: route.chainName,
        color: route.chainColor,
        count: 0
      }
      entry.count++
      seen.set(route.chainId, entry)
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [routes])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return routes.filter((route) => {
      if (chainFilter !== 'all' && route.chainId !== chainFilter) return false
      if (!needle) return true
      return route.walletLabel.toLowerCase().includes(needle) || route.address.toLowerCase().includes(needle)
    })
  }, [routes, chainFilter, query])

  const showFilters = routes.length > 6
  const single = routes.length <= 1

  return (
    <>
      {!single && (
        <Banner tone="info">
          {mode === 'send'
            ? `${routes.length} of your wallets hold ${symbol}. Pick the one to route this transfer through — the fee, the network and the remaining balance all depend on it.`
            : `${routes.length} of your wallets can accept ${symbol}. Choose one before you copy an address — sending ${symbol} to the right wallet on the wrong network can put it out of reach.`}
        </Banner>
      )}

      {showFilters && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <div className="chain-chips">
            <button
              className={`chain-chip ${chainFilter === 'all' ? 'chain-chip--on' : ''}`}
              onClick={() => setChainFilter('all')}
            >
              All networks
              <span className="muted">{routes.length}</span>
            </button>
            {chains.map((chain) => (
              <button
                key={chain.id}
                className={`chain-chip ${chainFilter === chain.id ? 'chain-chip--on' : ''}`}
                onClick={() => setChainFilter(chain.id)}
              >
                <span className="dot" style={{ background: chain.color }} />
                {chain.name}
                <span className="muted">{chain.count}</span>
              </button>
            ))}
          </div>

          {routes.length > 12 && (
            <div className="input-group">
              <input
                className="input"
                placeholder="Filter by wallet name or address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingLeft: 34 }}
              />
              <span style={{ position: 'absolute', left: 11, color: 'var(--text-muted)', display: 'flex' }}>
                <IconSearch size={15} />
              </span>
            </div>
          )}
        </div>
      )}

      <div
        className="route-list"
        style={{
          marginTop: single ? 0 : 12,
          maxHeight: filtered.length > 6 ? 420 : undefined,
          overflowY: filtered.length > 6 ? 'auto' : undefined,
          paddingRight: filtered.length > 6 ? 4 : undefined
        }}
      >
        {filtered.map((route) => {
          const isSelected = selected?.walletId === route.walletId && selected?.tokenKey === route.tokenKey
          const tooLow = mode === 'send' && requiredAmount > 0 && !route.sufficient
          return (
            <button
              key={`${route.walletId}-${route.tokenKey}`}
              className={`route ${isSelected ? 'route--selected' : ''}`}
              disabled={tooLow}
              onClick={() => onSelect(route)}
            >
              <span className="route__swatch" style={{ background: route.walletColor }} />
              <div style={{ minWidth: 0 }}>
                <div className="route__title">{route.walletLabel}</div>
                <div className="route__meta">
                  <span className="dot" style={{ background: route.chainColor }} />
                  {route.chainName}
                  <span className="mono">{shortAddress(route.address)}</span>
                  {route.requiresDeployment && (
                    <span className="tag tag--warning">{mode === 'send' ? 'First use' : 'Not deployed'}</span>
                  )}
                  {route.walletKind === 'watch' && <span className="tag">Watch-only</span>}
                  {tooLow && <span className="tag tag--negative">Too low</span>}
                </div>
              </div>
              <div className="route__balance">
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {mode === 'send' ? 'Balance' : 'Holds'}
                </div>
                <div style={{ fontSize: 13, fontWeight: 570 }}>{tokenAmount(route.amount, symbol)}</div>
                {mode === 'send' && route.value > 0 && (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {money(route.value, currency)}
                  </div>
                )}
              </div>
              {isSelected && <IconCheck size={16} className="picker__check" />}
            </button>
          )
        })}

        {filtered.length === 0 && (
          <p className="muted" style={{ fontSize: 12.5, padding: '12px 2px' }}>
            No wallet matches that filter.{' '}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChainFilter('all')
                setQuery('')
              }}
            >
              Clear filters
            </Button>
          </p>
        )}
      </div>
    </>
  )
}
