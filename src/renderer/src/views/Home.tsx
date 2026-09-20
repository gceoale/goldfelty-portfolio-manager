import { useMemo, useState, type JSX } from 'react'
import type { AssetHolding, HistoryRange } from '@shared/types.js'
import { AreaChart } from '../components/Chart.js'
import { Banner, Button, Card, Coin, EmptyState, Segmented } from '../components/ui.js'
import { IconExternal, IconLayers, IconRefresh, IconWallet } from '../components/Icons.js'
import { useApp } from '../state/app.js'
import { compactMoney, dateTime, money, percent, relativeTime, shortAddress, signedMoney, tokenAmount } from '../lib/format.js'

const RANGES: Array<{ value: HistoryRange; label: string }> = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' }
]

export function Home({ onNavigate }: { onNavigate: (tab: string) => void }): JSX.Element {
  const { portfolio, settings, wallets, transfers, range, setRange, refreshing, refreshPortfolio, chains } = useApp()
  const [selected, setSelected] = useState<AssetHolding | null>(null)
  const currency = settings?.currency ?? 'USD'
  const hidden = settings?.hideBalances ?? false

  const total = portfolio?.total ?? 0
  const change = portfolio?.change ?? 0
  const changePct = portfolio?.changePct ?? 0
  const positive = change >= 0

  const holdings = portfolio?.holdings ?? []
  const topWallets = useMemo(() => {
    const snapshot = portfolio?.history[portfolio.history.length - 1]
    if (!snapshot) return []
    return wallets
      .filter((w) => !w.archived)
      .map((w) => ({ wallet: w, value: snapshot.byWallet[w.id] ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
  }, [portfolio, wallets])

  const veil = (text: string): string => (hidden ? '••••••' : text)

  const chainCount = useMemo(() => new Set(wallets.flatMap((w) => w.chainIds)).size, [wallets])

  if (wallets.length === 0) {
    return (
      <div className="view">
        <div className="view__inner">
          <Card>
            <EmptyState
              icon={<IconWallet size={20} />}
              title="No wallets connected yet"
              action={
                <Button variant="primary" onClick={() => onNavigate('settings')}>
                  Connect a wallet
                </Button>
              }
            >
              Connect a smart account in Settings and your balances, growth and allocation will appear here.
            </EmptyState>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view__inner">
        {portfolio?.degraded && (
          <Banner tone="warning" title="Some figures could not be refreshed">
            At least one network or the price feed did not answer. The numbers below include the last values
            Goldfelty was able to read, and the growth chart is paused until a clean refresh comes through.
          </Banner>
        )}

        <section className="hero">
          <div className="hero__top">
            <div>
              <div className="hero__label">Total portfolio value</div>
              <div className="hero__total">{veil(money(total, currency))}</div>
              <div className="hero__delta">
                <span className={`tag ${positive ? 'tag--positive' : 'tag--negative'}`}>
                  {positive ? '▲' : '▼'} {percent(changePct)}
                </span>
                <span className={positive ? 'positive' : 'negative'}>{veil(signedMoney(change, currency))}</span>
                <span className="muted">
                  · {RANGES.find((r) => r.value === range)?.label.toLowerCase()} · updated{' '}
                  {portfolio ? relativeTime(portfolio.updatedAt) : '—'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Segmented value={range} options={RANGES} onChange={setRange} />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Refresh"
                busy={refreshing}
                onClick={() => void refreshPortfolio()}
              >
                {!refreshing && <IconRefresh size={15} />}
              </Button>
            </div>
          </div>
          <div className="hero__chart">
            <AreaChart data={portfolio?.history ?? []} currency={currency} positive={positive} />
          </div>
        </section>

        <div className="stat-row">
          <div className="stat">
            <div className="stat__label">Wallets connected</div>
            <div className="stat__value num">{wallets.filter((w) => !w.archived).length}</div>
            <div className="stat__foot">
              {wallets.filter((w) => w.kind === 'smart' && !w.archived).length} smart ·{' '}
              {wallets.filter((w) => w.kind === 'watch' && !w.archived).length} watch-only
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Distinct assets</div>
            <div className="stat__value num">{holdings.length}</div>
            <div className="stat__foot">across {chainCount} {chainCount === 1 ? 'network' : 'networks'}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Best performer · 24h</div>
            {(() => {
              const best = [...holdings].sort((a, b) => b.change24h - a.change24h)[0]
              return best ? (
                <>
                  <div className="stat__value" style={{ color: best.change24h >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                    {best.symbol}
                  </div>
                  <div className="stat__foot">{percent(best.change24h)}</div>
                </>
              ) : (
                <>
                  <div className="stat__value">—</div>
                  <div className="stat__foot">No priced assets yet</div>
                </>
              )
            })()}
          </div>
          <div className="stat">
            <div className="stat__label">Largest holding</div>
            <div className="stat__value">{holdings[0]?.symbol ?? '—'}</div>
            <div className="stat__foot">
              {holdings[0] && total > 0 ? `${((holdings[0].value / total) * 100).toFixed(1)}% of portfolio` : '—'}
            </div>
          </div>
        </div>

        <div className="grid-2">
          <Card
            flush
            title="Assets"
            description="Every token, pooled across the wallets holding it. Select one to see the breakdown."
          >
            {holdings.length === 0 ? (
              <EmptyState icon={<IconLayers size={20} />} title="No balances found">
                Once any connected wallet holds a token Goldfelty tracks, it shows up here. Use the Receive tab to
                get an address.
              </EmptyState>
            ) : (
              <div className="rows">
                {holdings.map((holding) => (
                  <button
                    key={holding.symbol}
                    className="row row--interactive"
                    onClick={() => setSelected(selected?.symbol === holding.symbol ? null : holding)}
                  >
                    <Coin symbol={holding.symbol} color={holding.color} />
                    <div style={{ minWidth: 0 }}>
                      <div className="row__name">{holding.name}</div>
                      <div className="row__meta">
                        <span>{holding.symbol}</span>
                        {holding.price > 0 && <span>· {money(holding.price, currency)}</span>}
                        {holding.change24h !== 0 && (
                          <span className={holding.change24h >= 0 ? 'positive' : 'negative'}>
                            {percent(holding.change24h)}
                          </span>
                        )}
                        <span>
                          · {holding.sources.length} {holding.sources.length === 1 ? 'source' : 'sources'}
                        </span>
                      </div>
                    </div>
                    <div className="row__right">
                      <div className="row__value">{veil(money(holding.value, currency))}</div>
                      <div className="row__amount">{veil(tokenAmount(holding.amount, holding.symbol))}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '14px 16px', background: 'var(--bg-sunken)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Where your {selected.symbol} sits</div>
                  <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                </div>
                <div className="route-list">
                  {selected.sources.map((source) => (
                    <div key={`${source.walletId}-${source.tokenKey}`} className="route" style={{ cursor: 'default' }}>
                      <span className="route__swatch" style={{ background: source.walletColor }} />
                      <div>
                        <div className="route__title">{source.walletLabel}</div>
                        <div className="route__meta">
                          <span className="dot" style={{ background: chains.find((c) => c.id === source.chainId)?.color }} />
                          {source.chainName} · <span className="mono">{shortAddress(source.address)}</span>
                        </div>
                      </div>
                      <div className="route__balance">
                        <div style={{ fontSize: 13, fontWeight: 570 }}>{veil(tokenAmount(source.amount, selected.symbol))}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{veil(money(source.value, currency))}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => onNavigate('send')}>
                        Send
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title="Allocation">
              {holdings.length === 0 || total === 0 ? (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  Allocation appears once your wallets hold something with a price.
                </p>
              ) : (
                <>
                  <div className="allocation">
                    {holdings.slice(0, 8).map((holding) => (
                      <span
                        key={holding.symbol}
                        className="allocation__seg"
                        title={`${holding.symbol} · ${((holding.value / total) * 100).toFixed(1)}%`}
                        style={{ background: holding.color, width: `${Math.max((holding.value / total) * 100, 0.6)}%` }}
                      />
                    ))}
                  </div>
                  <div className="legend">
                    {holdings.slice(0, 6).map((holding) => (
                      <div key={holding.symbol} className="legend__item">
                        <span className="dot" style={{ background: holding.color }} />
                        <span className="legend__name">{holding.symbol}</span>
                        <span className="legend__pct">{((holding.value / total) * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <Card title="Top wallets" description="By value held.">
              {topWallets.length === 0 ? (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  Wallet totals appear after the first successful refresh.
                </p>
              ) : (
                <div className="legend">
                  {topWallets.map(({ wallet, value }) => (
                    <div key={wallet.id} className="legend__item">
                      <span className="dot" style={{ background: wallet.color }} />
                      <span className="legend__name">{wallet.label}</span>
                      <span className="legend__pct">{veil(compactMoney(value, currency))}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Recent activity">
              {transfers.length === 0 ? (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  Transfers you make from Goldfelty are listed here.
                </p>
              ) : (
                <div className="legend">
                  {transfers.slice(0, 6).map((transfer) => {
                    const chain = chains.find((c) => c.id === transfer.chainId)
                    return (
                      <div key={transfer.id} className="legend__item" style={{ alignItems: 'flex-start' }}>
                        <span
                          className="dot"
                          style={{
                            marginTop: 6,
                            background:
                              transfer.status === 'failed'
                                ? 'var(--negative)'
                                : transfer.status === 'pending'
                                  ? 'var(--warning)'
                                  : 'var(--positive)'
                          }}
                        />
                        <div className="legend__name">
                          <div style={{ fontWeight: 550 }}>
                            {transfer.direction === 'out' ? 'Sent' : 'Received'} {tokenAmount(transfer.amount, transfer.symbol)}
                          </div>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {shortAddress(transfer.counterparty)} · {dateTime(transfer.at)} · {transfer.status}
                          </div>
                        </div>
                        {chain && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="View on explorer"
                            onClick={() => void window.goldfelty.app.openExternal(`${chain.explorer}/tx/${transfer.hash}`)}
                          >
                            <IconExternal size={13} />
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
