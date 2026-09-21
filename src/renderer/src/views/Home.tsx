import { useMemo, useState, type JSX } from 'react'
import type { AssetHolding, HistoryRange } from '@shared/types.js'
import { AreaChart } from '../components/Chart.js'
import { Banner, Button, Coin, EmptyState, Segmented } from '../components/ui.js'
import { IconExternal, IconRefresh, IconWallet } from '../components/Icons.js'
import { useApp } from '../state/app.js'
import { dateTime, money, percent, relativeTime, shortAddress, signedMoney, tokenAmount } from '../lib/format.js'

const RANGES: Array<{ value: HistoryRange; label: string }> = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' }
]

const RANGE_WORDS: Record<HistoryRange, string> = {
  '24h': 'past 24 hours',
  '7d': 'past week',
  '30d': 'past month',
  '1y': 'past year',
  all: 'all time'
}

/**
 * One number, one line about it, one chart, then the holdings.
 *
 * Everything else — allocation, activity — sits below with enough space that
 * it never competes for the eye. The four-metric row and the column of side
 * panels that used to live here were the most template-looking thing in the
 * app; the figures they showed are now one quiet line under the total.
 */
export function Home({ onNavigate }: { onNavigate: (tab: string) => void }): JSX.Element {
  const { portfolio, settings, wallets, transfers, range, setRange, refreshing, refreshPortfolio, chains } = useApp()
  const [selected, setSelected] = useState<AssetHolding | null>(null)

  const currency = settings?.currency ?? 'USD'
  const hidden = settings?.hideBalances ?? false
  const veil = (text: string): string => (hidden ? '••••••' : text)

  const total = portfolio?.total ?? 0
  const change = portfolio?.change ?? 0
  const changePct = portfolio?.changePct ?? 0
  const positive = change >= 0
  const holdings = portfolio?.holdings ?? []
  const active = wallets.filter((w) => !w.archived)
  const chainCount = useMemo(() => new Set(active.flatMap((w) => w.chainIds)).size, [active])

  if (wallets.length === 0) {
    return (
      <div className="view">
        <div className="view__inner">
          <EmptyState
            icon={<IconWallet size={20} />}
            title="No wallets yet"
            action={
              <Button variant="primary" onClick={() => onNavigate('settings')}>
                Connect a wallet
              </Button>
            }
          >
            Connect one in Settings and it shows up here.
          </EmptyState>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view__inner">
        {portfolio?.degraded && (
          <Banner tone="warning" title="Some figures could not be refreshed">
            A network or the price feed did not answer. Figures below are the last known good ones.
          </Banner>
        )}

        {/* ---- the number ------------------------------------------------ */}
        <section className="headline">
          <div className="headline__label">Total value</div>
          <div className="headline__figure">{veil(money(total, currency))}</div>
          <div className="headline__meta">
            <span className={positive ? 'positive' : 'negative'}>
              {positive ? '↑' : '↓'} {percent(changePct, false)} {veil(signedMoney(change, currency))}
            </span>
            <span className="muted">{RANGE_WORDS[range]}</span>
          </div>

          <div className="headline__chart">
            <AreaChart data={portfolio?.history ?? []} currency={currency} positive={positive} minimal height={168} />
          </div>

          <div className="headline__controls">
            <Segmented value={range} options={RANGES} onChange={setRange} />
            <span className="headline__stamp">
              {active.length} {active.length === 1 ? 'wallet' : 'wallets'} · {holdings.length}{' '}
              {holdings.length === 1 ? 'asset' : 'assets'} · {chainCount}{' '}
              {chainCount === 1 ? 'network' : 'networks'}
              {portfolio && ` · ${refreshing ? 'refreshing' : relativeTime(portfolio.updatedAt)}`}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Refresh"
                busy={refreshing}
                onClick={() => void refreshPortfolio()}
              >
                {!refreshing && <IconRefresh size={14} />}
              </Button>
            </span>
          </div>
        </section>

        {/* ---- holdings --------------------------------------------------- */}
        <section>
          <h2 className="section__title">Assets</h2>
          {holdings.length === 0 ? (
            <p className="section__empty">Nothing held yet. Grab an address from Receive.</p>
          ) : (
            <div className="ledger">
              {holdings.map((holding) => {
                const open = selected?.symbol === holding.symbol
                return (
                  <div key={holding.symbol}>
                    <button
                      className={`ledger__row ${open ? 'ledger__row--open' : ''}`}
                      onClick={() => setSelected(open ? null : holding)}
                    >
                      <Coin symbol={holding.symbol} color={holding.color} />
                      <span className="ledger__name">
                        {holding.name}
                        <span className="ledger__sub">
                          {holding.symbol}
                          {holding.price > 0 && ` · ${money(holding.price, currency)}`}
                          {holding.change24h !== 0 && (
                            <span className={holding.change24h >= 0 ? 'positive' : 'negative'}>
                              {' '}
                              {percent(holding.change24h)}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="ledger__figure">
                        {veil(money(holding.value, currency))}
                        <span className="ledger__sub">{veil(tokenAmount(holding.amount, holding.symbol))}</span>
                      </span>
                    </button>

                    {open && (
                      <div className="ledger__detail">
                        {holding.sources.map((source) => (
                          <div key={`${source.walletId}-${source.tokenKey}`} className="ledger__source">
                            <span className="dot" style={{ background: source.walletColor }} />
                            <span className="ledger__name">
                              {source.walletLabel}
                              <span className="ledger__sub">
                                {source.chainName} · <span className="mono">{shortAddress(source.address)}</span>
                              </span>
                            </span>
                            <span className="ledger__figure">
                              {veil(tokenAmount(source.amount, holding.symbol))}
                              <span className="ledger__sub">{veil(money(source.value, currency))}</span>
                            </span>
                          </div>
                        ))}
                        <Button variant="ghost" size="sm" onClick={() => onNavigate('send')}>
                          Send {holding.symbol}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ---- allocation -------------------------------------------------- */}
        {holdings.length > 0 && total > 0 && (
          <section>
            <h2 className="section__title">Allocation</h2>
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
            <div className="allocation__key">
              {holdings.slice(0, 6).map((holding) => (
                <span key={holding.symbol} className="allocation__item">
                  <span className="dot" style={{ background: holding.color }} />
                  {holding.symbol}
                  <span className="muted">{((holding.value / total) * 100).toFixed(1)}%</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ---- activity ---------------------------------------------------- */}
        <section>
          <h2 className="section__title">Activity</h2>
          {transfers.length === 0 ? (
            <p className="section__empty">Nothing sent yet.</p>
          ) : (
            <div className="ledger">
              {transfers.slice(0, 8).map((transfer) => {
                const chain = chains.find((c) => c.id === transfer.chainId)
                return (
                  <div key={transfer.id} className="ledger__row ledger__row--static">
                    <span
                      className="dot"
                      style={{
                        background:
                          transfer.status === 'failed'
                            ? 'var(--negative)'
                            : transfer.status === 'pending'
                              ? 'var(--warning)'
                              : 'var(--positive)'
                      }}
                    />
                    <span className="ledger__name">
                      {transfer.direction === 'out' ? 'Sent' : 'Received'}{' '}
                      {tokenAmount(transfer.amount, transfer.symbol)}
                      <span className="ledger__sub">
                        {shortAddress(transfer.counterparty)} · {dateTime(transfer.at)} · {transfer.status}
                      </span>
                    </span>
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
        </section>
      </div>
    </div>
  )
}
