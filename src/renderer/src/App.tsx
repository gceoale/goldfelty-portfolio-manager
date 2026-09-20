import { useEffect, useState, type JSX } from 'react'
import { Sidebar, TABS, type TabId } from './components/Sidebar.js'
import { Toaster } from './components/ui.js'
import { Home } from './views/Home.js'
import { Send } from './views/Send.js'
import { Receive } from './views/Receive.js'
import { Settings } from './views/Settings.js'
import { Onboarding } from './views/Onboarding.js'
import { Lock } from './views/Lock.js'
import { useApp } from './state/app.js'
import { relativeTime } from './lib/format.js'

export function App(): JSX.Element {
  const { status, loading, toasts, dismiss, portfolio, refreshing } = useApp()
  const [tab, setTab] = useState<TabId>('home')

  // Keyboard shortcuts for the tab rail: ⌘1–⌘4 / Ctrl+1–4.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const index = Number(event.key) - 1
      if (index >= 0 && index < TABS.length) {
        event.preventDefault()
        setTab(TABS[index].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.body.classList.add(`platform-${status?.platform ?? 'unknown'}`)
  }, [status?.platform])

  if (loading || !status) {
    return (
      <div className="gate">
        <div className="gate__inner" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="sidebar__mark gate__brand-mark">G</span>
          <span className="muted">Opening your vault…</span>
        </div>
      </div>
    )
  }

  if (!status.initialized) return <Onboarding />
  if (status.locked) return <Lock />

  const meta = TABS.find((t) => t.id === tab)!

  return (
    <div className="shell">
      <Sidebar active={tab} onChange={setTab} />
      <main className="content">
        <header className="topbar">
          <div>
            <h1 className="topbar__title">{meta.title}</h1>
            <div className="topbar__sub">{meta.subtitle}</div>
          </div>
          <div className="topbar__actions">
            {portfolio && (
              <span className="muted" style={{ fontSize: 12 }}>
                {refreshing ? 'Refreshing…' : `Updated ${relativeTime(portfolio.updatedAt)}`}
              </span>
            )}
          </div>
        </header>

        <div key={tab} className="fade-up" style={{ display: 'contents' }}>
          {tab === 'home' && <Home onNavigate={(next) => setTab(next as TabId)} />}
          {tab === 'send' && <Send onNavigate={(next) => setTab(next as TabId)} />}
          {tab === 'receive' && <Receive onNavigate={(next) => setTab(next as TabId)} />}
          {tab === 'settings' && <Settings />}
        </div>
      </main>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
