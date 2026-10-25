import type { JSX } from 'react'
import type { TransferRecord } from '@shared/types.ts'
import { txUrl } from '@shared/chains.ts'
import { useApp } from '../state/app.tsx'
import { Empty, Toolbar } from '../components/ui.tsx'
import { ExternalIcon, WarningIcon } from '../components/Icons.tsx'
import { dateTime, money, shortAddress, tokenAmount } from '../lib/format.ts'

export function Activity(): JSX.Element {
  const { transfers } = useApp()
  return (
    <div className="page">
      <Toolbar title="Activity" subtitle="Transfers sent from Goldfelty" />
      <div className="page-body">
        <ActivityTable rows={transfers} />
      </div>
    </div>
  )
}

const STATUS: Record<TransferRecord['status'], string> = { pending: 'Pending', confirmed: 'Confirmed', failed: 'Failed' }

export function ActivityTable({ rows, compact = false }: { rows: TransferRecord[]; compact?: boolean }): JSX.Element {
  const { wallets, chains, settings } = useApp()
  const currency = settings?.currency ?? 'USD'
  const hidden = settings?.hideBalances ?? false
  if (rows.length === 0) {
    return compact ? <p className="muted">Nothing sent yet.</p> : <Empty title="Nothing sent yet">Transfers you send from Goldfelty show up here.</Empty>
  }
  const walletName = (id: string): string => wallets.find((w) => w.id === id)?.label ?? 'Removed wallet'
  return (
    <table className="table activity">
      <thead>
        <tr>
          <th>Date</th>
          <th>What</th>
          <th className="num">Amount</th>
          {compact ? null : <th>From</th>}
          <th>To</th>
          <th>Status</th>
          <th aria-label="Explorer" />
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const chain = chains.find((c) => c.id === t.chainId)
          return (
            <tr key={t.id} className={t.warning ? 'flagged' : ''}>
              <td className="nowrap">{dateTime(t.at)}</td>
              <td>
                {t.kind === 'fee' ? 'Goldfelty fee' : `Sent ${t.symbol}`} <span className="muted">on {chain?.name ?? t.chainId}</span>
                {t.warning ? (
                  <div className="row-warning">
                    <WarningIcon size={12} /> {t.warning}
                  </div>
                ) : null}
              </td>
              <td className="num">
                {hidden ? '•••' : tokenAmount(t.amount, t.symbol)}
                {!hidden && t.value ? <div className="muted small">{money(t.value, currency)}</div> : null}
              </td>
              {compact ? null : <td>{walletName(t.walletId)}</td>}
              <td className="mono">{shortAddress(t.counterparty)}</td>
              <td>
                <span className={`status status-${t.status}`}>{STATUS[t.status]}</span>
              </td>
              <td>
                {chain ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Open in block explorer"
                    title="Open in block explorer"
                    onClick={() => void window.goldfelty.app.openExternal(txUrl(chain, t.hash))}
                  >
                    <ExternalIcon size={13} />
                  </button>
                ) : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
