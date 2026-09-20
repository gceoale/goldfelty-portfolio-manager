import { useState, type JSX } from 'react'
import { Button, Field, PasswordInput } from '../components/ui.js'
import { IconLock } from '../components/Icons.js'
import { useApp } from '../state/app.js'

export function Lock(): JSX.Element {
  const { refreshStatus, status } = useApp()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const unlock = async (): Promise<void> => {
    if (!password) return
    setBusy(true)
    setError(null)
    const result = await window.goldfelty.vault.unlock(password)
    setBusy(false)
    if (!result.ok) {
      setError(result.code === 'WRONG_PASSWORD' ? 'That password is not right.' : result.error)
      setPassword('')
      return
    }
    setPassword('')
    await refreshStatus()
  }

  return (
    <div className="gate">
      <div className="gate__inner" style={{ maxWidth: 400 }}>
        <div className="gate__brand" style={{ justifyContent: 'center' }}>
          <span className="sidebar__mark gate__brand-mark">G</span>
        </div>
        <div style={{ textAlign: 'center' }}>
          <h1 className="gate__title" style={{ fontSize: 21 }}>
            {status?.account ? `Welcome back, ${status.account.username}` : 'Welcome back'}
          </h1>
          <p className="gate__lede" style={{ marginTop: 6, fontSize: 13.5 }}>
            Enter your password to unlock your vault.
          </p>
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Password" id="unlock-pw" error={error}>
            <PasswordInput id="unlock-pw" value={password} onChange={setPassword} autoFocus onEnter={() => void unlock()} />
          </Field>
          <Button
            variant="primary"
            block
            busy={busy}
            disabled={!password}
            icon={<IconLock size={15} />}
            onClick={() => void unlock()}
          >
            Unlock
          </Button>
        </div>
        <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          Forgotten your password? Reinstall Goldfelty and restore from your 24-word recovery phrase.
        </p>
      </div>
    </div>
  )
}
