import { Fragment, useState, type JSX } from 'react'
import type { HistoryRange } from '@shared/types.ts'
import { useApp } from '../state/app.tsx'
import { ValueChart } from '../components/Chart.tsx'
import { AssetGlyph, Button, Empty, Notice, Segmented, Toolbar } from '../components/ui.tsx'
import { ChevronIcon, RefreshIcon } from '../components/Icons.tsx'
import { money, percent, relativeTime, shortAddress, signedMoney, tokenAmount } from '../lib/format.ts'
import { ActivityTable } from './Activity.tsx'

const RANGES: Array<{ value: HistoryRange; label: string }> = [
  { value: '24h', label: '1D' },
  { value: '7d', label: '1W' },
  { value: '30d', label: '1M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' }
]

export function Overview(): JSX.Element {
  const { portfolio, settings, wallets, range, setRange, refreshing, refreshPortfolio, status, go, openConnect, transfers, run, refreshStatus } = useApp()
  const [open, setOpen] = useState<string | null>(null)
  const currency = settings?.currency ?? 'USD'
  const hidden = settings?.hideBalances ?? false
  const show = (v: number): string => (hidden ? '•••••' : money(v, currency))
  const total = portfolio?.total ?? 0
  const up = (portfolio?.change ?? 0) >= 0
  const active = wallets.filter((w) => !w.archived)
  const notice = status?.upgradeNotice

  return (
    <div className="page">
      <Toolbar title="Overview" subtitle={portfolio ? `Updated ${relativeTime(portfolio.updatedAt)}` : undefined}>
        <Segmented label="Period" value={range} options={RANGES} onChange={setRange} />
        <Button small onClick={() => void refreshPortfolio()} busy={refreshing} aria-label="Refresh">
          {!refreshing ? <RefreshIcon size={13} /> : null}
          Refresh
        </Button>
      </Toolbar>

      <div className="page-body">
        {notice && notice.createdAddresses.length > 0 ? (
          <Notice tone="warn">
            <strong>Goldfelty no longer creates wallets.</strong> {notice.createdAddresses.length} address
            {notice.createdAddresses.length === 1 ? '' : 'es'} made by an earlier version {notice.createdAddresses.length === 1 ? 'is' : 'are'} now
            listed as read-only. Don’t send anything to {notice.createdAddresses.length === 1 ? 'it' : 'them'}. Your old encrypted vault is kept
            unchanged.{' '}
            <button type="button" className="link" onClick={() => void run(window.goldfelty.app.showBackup())}>
              Show it
            </button>{' '}
            ·{' '}
            <button
              type="button"
              className="link"
              onClick={() => void run(window.goldfelty.app.dismissUpgradeNotice()).then(() => refreshStatus())}
            >
              Dismiss
            </button>
          </Notice>
        ) : null}

        {active.length === 0 ? (
          <Empty title="No wallets yet">
            <p>Connect the wallets you already use, such as MetaMask, Rabby, Phantom, Frame or a phone wallet. Goldfelty reads balances and asks the wallet to approve anything you send.</p>
            <Button variant="primary" onClick={() => openConnect(true)}>
              Connect a wallet
            </Button>
          </Empty>
        ) : (
          <>
            <div className="summary">
              <div>
                <div className="summary-label">Total value</div>
                <div className="summary-value">{show(total)}</div>
              </div>
              <div>
                <div className="summary-label">Change, {RANGES.find((r) => r.value === range)?.label}</div>
                <div className={`summary-change ${up ? 'up' : 'down'}`}>
                  {hidden ? '•••' : signedMoney(portfolio?.change ?? 0, currency)} <span>{percent(portfolio?.changePct ?? 0)}</span>
                </div>
              </div>
              <div>
                <div className="summary-label">Wallets</div>
                <div className="summary-small">{active.length}</div>
              </div>
              <div>
                <div className="summary-label">Assets</div>
                <div className="summary-small">{portfolio?.holdings.length ?? 0}</div>
              </div>
            </div>

            {portfolio?.degraded ? (
              <Notice>Some networks or prices didn’t answer, so a few figures are from the last successful refresh.</Notice>
            ) : null}

            <ValueChart data={portfolio?.history ?? []} currency={currency} range={range} hidden={hidden} />

            <h2 className="section-title">Holdings</h2>
            {portfolio && portfolio.holdings.length > 0 ? (
              <table className="table holdings">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="num">Price</th>
                    <th className="num">24h</th>
                    <th className="num">Balance</th>
                    <th className="num">Value</th>
                    <th className="alloc-col">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.holdings.map((h) => {
                    const share = total > 0 ? (h.value / total) * 100 : 0
                    const expanded = open === h.symbol
                    return (
                      <Fragment key={h.symbol}>
                        <tr className="clickable" onClick={() => setOpen(expanded ? null : h.symbol)} aria-expanded={expanded}>
                          <td>
                            <span className="asset-cell">
                              <ChevronIcon size={11} className={`disclosure${expanded ? ' open' : ''}`} />
                              <AssetGlyph symbol={h.symbol} color={h.color} size={20} />
                              <span>
                                <strong>{h.symbol}</strong> <span className="muted">{h.name}</span>
                              </span>
                            </span>
                          </td>
                          <td className="num">{h.price ? money(h.price, currency) : '–'}</td>
                          <td className={`num ${h.change24h >= 0 ? 'up' : 'down'}`}>{h.price ? percent(h.change24h) : '–'}</td>
                          <td className="num">{hidden ? '•••' : tokenAmount(h.amount)}</td>
                          <td className="num">{show(h.value)}</td>
                          <td className="alloc-col">
                            <span className="alloc">
                              <span className="alloc-bar" style={{ width: `${Math.max(1, share)}%` }} />
                            </span>
                            <span className="alloc-text">{share.toFixed(1)}%</span>
                          </td>
                        </tr>
                        {expanded
                          ? h.sources.map((s) => (
                              <tr key={`${s.walletId}:${s.tokenKey}`} className="subrow">
                                <td>
                                  <span className="sub-cell">
                                    {s.walletLabel} <span className="muted">on {s.chainName} · {shortAddress(s.address)}</span>
                                  </span>
                                </td>
                                <td />
                                <td />
                                <td className="num">{hidden ? '•••' : tokenAmount(s.amount)}</td>
                                <td className="num">{show(s.value)}</td>
                                <td className="alloc-col">
                                  <button type="button" className="link small" onClick={() => go({ name: 'send', symbol: h.symbol })}>
                                    Send
                                  </button>
                                </td>
                              </tr>
                            ))
                          : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <p className="muted">{refreshing ? 'Reading balances…' : 'No balances found on the networks you have turned on.'}</p>
            )}

            <div className="section-head">
              <h2 className="section-title">Recent activity</h2>
              {transfers.length > 5 ? (
                <button type="button" className="link small" onClick={() => go({ name: 'activity' })}>
                  Show all
                </button>
              ) : null}
            </div>
            <ActivityTable rows={transfers.slice(0, 5)} compact />
          </>
        )}
      </div>
    </div>
  )
}
