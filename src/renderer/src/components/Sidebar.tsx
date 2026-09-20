import type { JSX, ReactNode } from 'react'
import { IconHome, IconLock, IconReceive, IconSend, IconSettings } from './Icons.js'
import { Avatar, Button } from './ui.js'
import { useApp } from '../state/app.js'
import { compactMoney } from '../lib/format.js'

export type TabId = 'home' | 'send' | 'receive' | 'settings'

export const TABS: Array<{ id: TabId; label: string; icon: ReactNode; title: string; subtitle: string }> = [
  {
    id: 'home',
    label: 'Home',
    icon: <IconHome size={17} />,
    title: 'Home',
    subtitle: 'Your portfolio across every connected wallet'
  },
  {
    id: 'send',
    label: 'Send',
    icon: <IconSend size={17} />,
    title: 'Send',
    subtitle: 'Move tokens out of any wallet you control'
  },
  {
    id: 'receive',
    label: 'Receive',
    icon: <IconReceive size={17} />,
    title: 'Receive',
    subtitle: 'Get an address for the wallet of your choice'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: <IconSettings size={17} />,
    title: 'Settings',
    subtitle: 'Wallets, security, networks and your account'
  }
]

export function Sidebar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }): JSX.Element {
  const { status, wallets, portfolio, settings } = useApp()
  const activeWallets = wallets.filter((w) => !w.archived).length
  const currency = settings?.currency ?? 'USD'

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">G</span>
        <div>
          <div className="sidebar__name">Goldfelty</div>
          <div className="sidebar__sub">Portfolio Manager</div>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="Main">
        <div className="sidebar__label">Wallet</div>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`navitem ${active === tab.id ? 'navitem--active' : ''}`}
            aria-current={active === tab.id ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
          >
            <span className="navitem__icon">{tab.icon}</span>
            {tab.label}
            {tab.id === 'settings' && activeWallets > 0 && <span className="navitem__badge">{activeWallets}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar__spacer" />

      <div className="sidebar__footer">
        {portfolio && (
          <div style={{ padding: '2px 10px 6px' }}>
            <div className="sidebar__sub">Total value</div>
            <div style={{ fontSize: 17, fontWeight: 620, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
              {settings?.hideBalances ? '••••••' : compactMoney(portfolio.total, currency)}
            </div>
          </div>
        )}

        <button className="account-chip" onClick={() => onChange('settings')}>
          <Avatar name={status?.account?.username ?? 'Goldfelty'} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="account-chip__name">{status?.account?.username ?? 'Not signed in'}</div>
            <div className="account-chip__meta">
              {status?.account?.linked ? 'goldfelty.com' : 'Local account'}
            </div>
          </div>
        </button>

        <Button
          variant="ghost"
          size="sm"
          block
          icon={<IconLock size={14} />}
          onClick={() => void window.goldfelty.vault.lock()}
        >
          Lock vault
        </Button>
      </div>
    </aside>
  )
}
