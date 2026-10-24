import { useEffect, type JSX } from 'react'
import { useApp } from './state/app.tsx'
import { Sidebar, NAV_PAGES } from './components/Sidebar.tsx'
import { ConnectSheet } from './components/ConnectSheet.tsx'
import { Toasts } from './components/ui.tsx'
import { Overview } from './views/Overview.tsx'
import { Activity } from './views/Activity.tsx'
import { Send } from './views/Send.tsx'
import { Receive } from './views/Receive.tsx'
import { WalletDetail } from './views/WalletDetail.tsx'
import { Settings } from './views/Settings.tsx'
import { Onboarding } from './views/Onboarding.tsx'
import { Lock } from './views/Lock.tsx'

export function App(): JSX.Element {
  const { status, page, go, connectOpen, toasts, dismiss } = useApp()

  useEffect(() => {
    if (status?.platform) document.documentElement.dataset.platform = status.platform
  }, [status?.platform])

  // Cmd/Ctrl+1..4 for the main pages, Cmd/Ctrl+, for Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !status || status.locked || !status.onboarded) return
      const index = Number(e.key) - 1
      if (index >= 0 && index < NAV_PAGES.length) {
        e.preventDefault()
        go(NAV_PAGES[index])
      } else if (e.key === ',') {
        e.preventDefault()
        go({ name: 'settings' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, go])

  if (!status) return <div className="blank" />

  let body: JSX.Element
  if (!status.initialized || (!status.onboarded && !status.locked)) body = <Onboarding />
  else if (status.locked) body = <Lock />
  else {
    body = (
      <div className="shell">
        <Sidebar />
        <main className="content">
          {page.name === 'overview' ? <Overview /> : null}
          {page.name === 'activity' ? <Activity /> : null}
          {page.name === 'send' ? <Send key={page.symbol ?? ''} symbol={page.symbol} /> : null}
          {page.name === 'receive' ? <Receive key={page.symbol ?? ''} symbol={page.symbol} /> : null}
          {page.name === 'wallet' ? <WalletDetail key={page.id} id={page.id} /> : null}
          {page.name === 'settings' ? <Settings /> : null}
        </main>
        {connectOpen ? <ConnectSheet /> : null}
      </div>
    )
  }

  return (
    <>
      {body}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  )
}
