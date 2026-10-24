import type { JSX } from 'react'
import { useApp, type Page } from '../state/app.tsx'
import { ActivityIcon, LockIcon, OverviewIcon, PlusIcon, ReceiveIcon, SendIcon, SettingsIcon } from './Icons.tsx'
import { StatusDot, WalletGlyph } from './ui.tsx'
import { compactMoney } from '../lib/format.ts'

const NAV: Array<{ page: Page; label: string; icon: (p: { size?: number }) => JSX.Element; key: string }> = [
  { page: { name: 'overview' }, label: 'Overview', icon: OverviewIcon, key: '1' },
  { page: { name: 'send' }, label: 'Send', icon: SendIcon, key: '2' },
  { page: { name: 'receive' }, label: 'Receive', icon: ReceiveIcon, key: '3' },
  { page: { name: 'activity' }, label: 'Activity', icon: ActivityIcon, key: '4' }
]

export const NAV_PAGES = NAV.map((n) => n.page)

/** A source list: where you are, then every wallet you've connected. */
export function Sidebar(): JSX.Element {
  const { page, go, wallets, connections, portfolio, settings, status, openConnect, run } = useApp()
  const currency = settings?.currency ?? 'USD'
  const byWallet = new Map<string, number>()
  for (const b of portfolio?.balances ?? []) byWallet.set(b.walletId, (byWallet.get(b.walletId) ?? 0) + b.value)
  const active = new Map(connections.map((c) => [c.id, c.active]))
  const visible = wallets.filter((w) => !w.archived)

  return (
    <nav className="sidebar" aria-label="Goldfelty">
      <div className="sidebar-drag" />
      <ul className="source-list">
        {NAV.map((item) => {
          const Icon = item.icon
          const selected = page.name === item.page.name
          return (
            <li key={item.label}>
              <button type="button" className={selected ? 'selected' : ''} aria-current={selected ? 'page' : undefined} onClick={() => go(item.page)}>
                <Icon />
                <span>{item.label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="source-heading">
        <span>Wallets</span>
        <button type="button" className="icon-btn" aria-label="Connect a wallet" title="Connect a wallet" onClick={() => openConnect(true)}>
          <PlusIcon size={14} />
        </button>
      </div>
      <ul className="source-list wallets">
        {visible.length === 0 ? (
          <li className="source-empty">
            <button type="button" className="link" onClick={() => openConnect(true)}>
              Connect a wallet
            </button>
          </li>
        ) : null}
        {visible.map((w) => {
          const selected = page.name === 'wallet' && page.id === w.id
          const reachable = !!w.connectionId && active.get(w.connectionId) === true
          const value = byWallet.get(w.id) ?? 0
          return (
            <li key={w.id}>
              <button type="button" className={selected ? 'selected' : ''} onClick={() => go({ name: 'wallet', id: w.id })}>
                <WalletGlyph name={w.providerName ?? w.label} color={w.color} size={16} />
                <span className="wallet-name">{w.label}</span>
                {w.kind === 'readonly' ? (
                  <span className="source-meta">Read-only</span>
                ) : (
                  <>
                    <span className="source-meta">{settings?.hideBalances ? '' : compactMoney(value, currency)}</span>
                    <StatusDot on={reachable} label={reachable ? 'Reachable' : 'Not reachable right now'} />
                  </>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="sidebar-foot">
        <button type="button" className={page.name === 'settings' ? 'selected' : ''} onClick={() => go({ name: 'settings' })}>
          <SettingsIcon />
          <span>Settings</span>
        </button>
        <button type="button" title="Lock (Ctrl/Cmd+L)" onClick={() => void run(window.goldfelty.vault.lock())}>
          <LockIcon />
          <span>Lock</span>
        </button>
        {status?.account ? <div className="sidebar-user">{status.account.username}</div> : null}
      </div>
    </nav>
  )
}
