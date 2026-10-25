import { useEffect, useState, type JSX } from 'react'
import type { AccountApiStatus } from '@shared/types.ts'
import { useApp } from '../state/app.tsx'
import { ConnectSheet } from '../components/ConnectSheet.tsx'
import { Button, Field, Notice, TextInput, WalletGlyph } from '../components/ui.tsx'
import { shortAddress } from '../lib/format.ts'

const api = window.goldfelty
const TERMS_URL = 'https://goldfelty.com/terms/'

type Step = 'welcome' | 'password' | 'connect' | 'account'
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'password', label: 'Password' },
  { id: 'connect', label: 'Wallets' },
  { id: 'account', label: 'Account' }
]

/**
 * First run, laid out like a setup assistant: a step list on the left, one
 * question at a time on the right. If setup was interrupted after the
 * password, it picks up at the wallet step.
 */
export function Onboarding(): JSX.Element {
  const { status, refreshStatus } = useApp()
  const resumed = !!status?.initialized && !status.locked
  const [step, setStep] = useState<Step>(resumed ? 'connect' : 'welcome')

  const finish = async (): Promise<void> => {
    await api.setup.finish()
    await refreshStatus()
  }

  return (
    <div className="setup">
      <div className="setup-drag" />
      <aside className="setup-steps">
        <div className="setup-brand">
          <span className="brand-mark">G</span> Goldfelty
        </div>
        <ol>
          {STEPS.map((s, i) => {
            const at = STEPS.findIndex((x) => x.id === step)
            return (
              <li key={s.id} className={i === at ? 'current' : i < at ? 'done' : ''}>
                {s.label}
              </li>
            )
          })}
        </ol>
      </aside>
      <main className="setup-main">
        {step === 'welcome' ? <Welcome onNext={() => setStep('password')} /> : null}
        {step === 'password' ? <Password onNext={() => setStep('connect')} /> : null}
        {step === 'connect' ? <ConnectStep onNext={() => setStep('account')} /> : null}
        {step === 'account' ? <AccountStep onDone={() => void finish()} /> : null}
      </main>
    </div>
  )
}

function Welcome({ onNext }: { onNext: () => void }): JSX.Element {
  const [agreed, setAgreed] = useState(false)
  return (
    <section className="setup-panel">
      <h1>Welcome to Goldfelty</h1>
      <p>One view of the crypto wallets you already use: what you hold across all of them, what it’s worth, and a single place to send and receive.</p>
      <ul className="plain-list">
        <li>Goldfelty doesn’t create wallets or hold keys. You connect MetaMask, Rabby, Phantom, Frame, a phone wallet and 30 others.</li>
        <li>Every transfer is approved in your own wallet.</li>
        <li>What Goldfelty knows about your wallets stays on this computer, encrypted with a password you choose next.</li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          I agree to the{' '}
          <button type="button" className="link" onClick={() => void api.app.openExternal(TERMS_URL)}>
            Terms of Service
          </button>
          , including the fee on tokens sent through Goldfelty, which the owner of goldfelty.com can set between 0% and 10%.
        </span>
      </label>
      <div className="setup-actions">
        <Button variant="primary" disabled={!agreed} onClick={onNext}>
          Continue
        </Button>
      </div>
    </section>
  )
}

function Password({ onNext }: { onNext: () => void }): JSX.Element {
  const { refreshStatus } = useApp()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [strength, setStrength] = useState<{ score: number; label: string; problems: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pw) return setStrength(null)
    void api.setup.scorePassword(pw).then((r) => r.ok && setStrength(r.data))
  }, [pw])

  const ok = (strength?.score ?? 0) >= 2 && pw === pw2
  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.setup.create(pw)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setPw('')
    setPw2('')
    await refreshStatus()
    onNext()
  }

  return (
    <form
      className="setup-panel"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) void create()
      }}
    >
      <h1>Choose a password</h1>
      <p>It unlocks Goldfelty on this computer and encrypts what it stores. There’s no way to recover it, but forgetting it never costs you funds: your wallets hold those, and you can set Goldfelty up again.</p>
      <Field label="Password" htmlFor="pw" hint={strength ? `${strength.label}${strength.problems[0] ? `. ${strength.problems[0]}` : ''}` : 'At least 10 characters.'}>
        <TextInput id="pw" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        {strength ? (
          <div className="meter" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={i < strength.score ? `on s${strength.score}` : ''} />
            ))}
          </div>
        ) : null}
      </Field>
      <Field label="Again" htmlFor="pw2" error={pw2 && pw !== pw2 ? 'The passwords don’t match.' : null}>
        <TextInput id="pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </Field>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="setup-actions">
        <Button type="submit" variant="primary" disabled={!ok} busy={busy}>
          {busy ? 'Setting up…' : 'Continue'}
        </Button>
      </div>
    </form>
  )
}

function ConnectStep({ onNext }: { onNext: () => void }): JSX.Element {
  const { wallets, connectOpen, openConnect, refreshData } = useApp()
  useEffect(() => {
    void refreshData()
  }, [refreshData])
  const connected = wallets.filter((w) => w.kind !== 'readonly')
  return (
    <section className="setup-panel">
      <h1>Connect your wallets</h1>
      <p>Pick the wallets you use. Each one asks you to approve the connection, and Goldfelty adds every account it shares.</p>
      {connected.length ? (
        <ul className="setup-wallets">
          {connected.map((w) => (
            <li key={w.id}>
              <WalletGlyph name={w.providerName ?? w.label} color={w.color} size={20} />
              <span>{w.label}</span>
              <span className="muted mono small">{shortAddress(w.address)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="setup-actions">
        <Button onClick={() => openConnect(true)}>{connected.length ? 'Connect another…' : 'Connect a wallet…'}</Button>
        <span className="spacer" />
        <Button variant={connected.length ? 'primary' : 'plain'} onClick={onNext}>
          {connected.length ? 'Continue' : 'Skip for now'}
        </Button>
      </div>
      {connectOpen ? <ConnectSheet onDone={() => void refreshData()} /> : null}
    </section>
  )
}

function AccountStep({ onDone }: { onDone: () => void }): JSX.Element {
  const { wallets, notify, updateSettings } = useApp()
  const [share, setShare] = useState(false)
  const signers = wallets.filter((w) => w.kind !== 'readonly' && (w.family ?? 'evm') === 'evm' && w.connectionId)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [signer, setSigner] = useState(signers[0]?.id ?? '')
  const [problems, setProblems] = useState<{ username: string | null; email: string | null }>({ username: null, email: null })
  const [availability, setAvailability] = useState<string | null>(null)
  const [apiStatus, setApiStatus] = useState<AccountApiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.account.apiStatus().then((r) => r.ok && setApiStatus(r.data))
  }, [])

  useEffect(() => {
    setAvailability(null)
    if (!username) return
    const timer = setTimeout(() => {
      void api.account.checkUsername(username).then((r) => {
        if (!r.ok) return
        setAvailability(r.data.offline ? null : r.data.available ? 'Available' : (r.data.reason ?? 'Taken'))
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [username])

  const submit = async (): Promise<void> => {
    const v = await api.account.validate(username, email)
    if (v.ok && (v.data.username || v.data.email)) return setProblems(v.data)
    setProblems({ username: null, email: null })
    setBusy(true)
    setError(null)
    const r = await api.account.register({ username, email, walletId: signers.length && apiStatus?.reachable ? signer : null })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    if (share) await updateSettings({ shareTotals: true })
    notify({ tone: r.data.linked ? 'good' : 'info', title: r.data.linked ? 'Account created on goldfelty.com' : 'Account saved on this computer', body: r.data.message })
    onDone()
  }

  const signerName = signers.find((w) => w.id === signer)?.providerName ?? 'your wallet'
  return (
    <form
      className="setup-panel"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h1>Your goldfelty.com account</h1>
      <p>Reserves your username on goldfelty.com. It’s optional, and it never holds funds or keys.</p>
      <Field label="Username" htmlFor="username" error={problems.username} hint={availability ?? 'Lowercase letters, numbers, - and _.'}>
        <TextInput id="username" value={username} maxLength={24} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
      </Field>
      <Field label="Email" htmlFor="email" error={problems.email}>
        <TextInput id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {apiStatus?.reachable && signers.length ? (
        <Field label="Prove it’s you" hint={`${signerName} will ask you to sign a short message. Signing costs nothing and moves no funds.`}>
          <select className="input" value={signer} onChange={(e) => setSigner(e.target.value)} aria-label="Sign with">
            {signers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} ({shortAddress(w.address)})
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Notice>
          {apiStatus === null
            ? 'Checking goldfelty.com…'
            : !apiStatus.reachable
              ? 'goldfelty.com can’t be reached right now, so the account will be saved on this computer. Link it later from Settings.'
              : 'With no wallet connected, the account is saved on this computer. Link it later from Settings.'}
        </Notice>
      )}
      <label className="check">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
        <span>
          Share my portfolio total with goldfelty.com. Only the total value, its currency and the number of wallets, never addresses or holdings. You
          can turn this off in Settings, which deletes what was shared.
        </span>
      </label>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="setup-actions">
        <Button variant="plain" onClick={onDone}>
          Skip
        </Button>
        <span className="spacer" />
        <Button type="submit" variant="primary" busy={busy} disabled={!username || !email || apiStatus === null}>
          {busy ? `Waiting for ${signerName}…` : 'Create account'}
        </Button>
      </div>
    </form>
  )
}
