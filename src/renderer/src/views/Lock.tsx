import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../state/app.tsx'
import { Button, TextInput } from '../components/ui.tsx'

const api = window.goldfelty

export function Lock(): JSX.Element {
  const { status, refreshStatus } = useApp()
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const retryAt = status?.unlockRetryAt ?? null
  const waiting = retryAt !== null && retryAt > now

  useEffect(() => {
    if (!retryAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAt])

  const unlock = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.vault.unlock(pw)
    setBusy(false)
    if (r.ok) {
      setPw('')
      await refreshStatus()
      return
    }
    setError(r.code === 'CORRUPT_DATA' ? `${r.error} Your wallets and funds are unaffected.` : r.error)
    await refreshStatus()
  }

  return (
    <div className="lock">
      <div className="setup-drag" />
      <form
        className="lock-panel"
        onSubmit={(e) => {
          e.preventDefault()
          if (pw && !waiting) void unlock()
        }}
      >
        <span className="brand-mark large">G</span>
        <h1>{status?.greetingName ? `Welcome back, ${status.greetingName}` : 'Goldfelty is locked'}</h1>
        <TextInput type="password" placeholder="Password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" />
        {waiting ? (
          <div className="field-error">Too many wrong passwords. Try again in {Math.ceil((retryAt! - now) / 1000)} s.</div>
        ) : error ? (
          <div className="field-error">{error}</div>
        ) : null}
        <Button type="submit" variant="primary" busy={busy} disabled={!pw || waiting}>
          Unlock
        </Button>
      </form>
    </div>
  )
}
