import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { RecoveryMaterial } from '@shared/types.js'
import { Banner, Button, CopyButton, Field, PasswordInput } from '../components/ui.js'
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconEye,
  IconLock,
  IconShield,
  IconWallet
} from '../components/Icons.js'
import { useApp } from '../state/app.js'

type Step = 'welcome' | 'password' | 'account' | 'recovery' | 'confirm' | 'username' | 'wallets' | 'done'

const ORDER: Step[] = ['welcome', 'password', 'account', 'recovery', 'confirm', 'username', 'wallets', 'done']

const BACKUP_CHECKS = [
  'I have written down my 24-word recovery phrase and stored it somewhere only I can reach.',
  'I understand Goldfelty cannot recover my phrase, my password, or my funds if I lose them.',
  'I know anyone who sees this phrase can take everything in every wallet it controls.',
  'I did not store the phrase in a screenshot, a photo, a note app, or a password manager sync.'
]

export function Onboarding(): JSX.Element {
  const { notify, refreshStatus, refreshWallets, run } = useApp()
  const [step, setStep] = useState<Step>('welcome')
  const [busy, setBusy] = useState(false)

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [strength, setStrength] = useState<{ score: number; label: string; problems: string[] } | null>(null)

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)

  const [ticket, setTicket] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<RecoveryMaterial | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [checks, setChecks] = useState<boolean[]>(BACKUP_CHECKS.map(() => false))

  const [username, setUsername] = useState('')
  const [usernameState, setUsernameState] = useState<{ checking: boolean; ok: boolean | null; reason?: string; offline?: boolean }>({
    checking: false,
    ok: null
  })

  const [walletCount, setWalletCount] = useState(5)

  const index = ORDER.indexOf(step)

  // ---- password ----------------------------------------------------------
  useEffect(() => {
    if (!password) {
      setStrength(null)
      return
    }
    let cancelled = false
    void window.goldfelty.onboarding.scorePassword(password).then((result) => {
      if (!cancelled && result.ok) setStrength(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [password])

  const passwordsMatch = password.length > 0 && password === confirmPassword
  const passwordReady = (strength?.score ?? 0) >= 2 && passwordsMatch

  const createVault = useCallback(async () => {
    setBusy(true)
    const result = await run(window.goldfelty.onboarding.createVault(password), 'Could not create your vault')
    setBusy(false)
    if (!result) return
    setTicket(result.ticket)
    setRecovery(result.recovery)
    // The password has done its job; drop it from renderer memory.
    setPassword('')
    setConfirmPassword('')
    setStep('account')
  }, [password, run])

  // ---- username ----------------------------------------------------------
  useEffect(() => {
    if (username.trim().length < 3) {
      setUsernameState({ checking: false, ok: null })
      return
    }
    setUsernameState({ checking: true, ok: null })
    const timer = setTimeout(() => {
      void window.goldfelty.onboarding.checkUsername(username).then((result) => {
        if (!result.ok) {
          setUsernameState({ checking: false, ok: false, reason: result.error })
          return
        }
        setUsernameState({
          checking: false,
          ok: result.data.available,
          reason: result.data.reason,
          offline: result.data.offline
        })
      })
    }, 420)
    return () => clearTimeout(timer)
  }, [username])

  const register = useCallback(async () => {
    setBusy(true)
    const result = await run(window.goldfelty.onboarding.register(username, email), 'Could not create your account')
    setBusy(false)
    if (!result) return
    if (!result.linked) {
      notify({ tone: 'info', title: 'Account created offline', text: result.message })
    } else {
      notify({ tone: 'success', title: `Welcome, ${result.account.username}` })
    }
    setStep('wallets')
  }, [username, email, run, notify])

  const finish = useCallback(async () => {
    setBusy(true)
    const created = await run(window.goldfelty.onboarding.finish(walletCount), 'Could not connect your wallets')
    setBusy(false)
    if (!created) return
    setRecovery(null)
    setTicket(null)
    await refreshWallets()
    await refreshStatus()
  }, [walletCount, run, refreshWallets, refreshStatus])

  const seedWords = useMemo(() => recovery?.mnemonic.split(' ') ?? [], [recovery])

  return (
    <div className="gate">
      <div className="gate__inner">
        <div className="gate__brand">
          <span className="sidebar__mark gate__brand-mark">G</span>
          <div>
            <div className="sidebar__name" style={{ fontSize: 15 }}>
              Goldfelty
            </div>
            <div className="sidebar__sub">Portfolio Manager</div>
          </div>
        </div>

        {step !== 'welcome' && (
          <div className="progress" aria-label={`Step ${index} of ${ORDER.length - 2}`}>
            {ORDER.slice(1, -1).map((s, i) => (
              <span
                key={s}
                className={`progress__tick ${i < index - 1 ? 'progress__tick--done' : i === index - 1 ? 'progress__tick--current' : ''}`}
              />
            ))}
          </div>
        )}

        {step === 'welcome' && (
          <>
            <div>
              <h1 className="gate__title">A home for every wallet you hold.</h1>
              <p className="gate__lede" style={{ marginTop: 10 }}>
                Connect up to 256 smart-contract wallets across seven networks, watch them grow in one place, and
                send or receive on any of them. Setting up takes about two minutes.
              </p>
            </div>
            <Banner tone="warning" title="Read this before you put real money here">
              This is independent software that has not been through a third-party security audit. Try it with an
              amount you would not mind losing until it has been.
            </Banner>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { icon: <IconLock size={16} />, title: 'Your password never leaves this computer', body: 'It is stretched with scrypt and used to encrypt your vault. There is no copy on any server.' },
                { icon: <IconShield size={16} />, title: 'One phrase restores everything', body: 'Every wallet you connect is derived from a single recovery phrase you will write down in a moment.' },
                { icon: <IconWallet size={16} />, title: 'Smart accounts, not bare keys', body: 'Each wallet is a contract account with one owner key, so it can send, receive and batch calls.' }
              ].map((item) => (
                <div key={item.title} style={{ display: 'flex', gap: 12 }}>
                  <span style={{ color: 'var(--accent)', marginTop: 2 }}>{item.icon}</span>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 570 }}>{item.title}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {item.body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Button variant="primary" size="lg" block onClick={() => setStep('password')}>
              Get started
            </Button>
          </>
        )}

        {step === 'password' && (
          <>
            <div>
              <h1 className="gate__title">Choose a password</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                This unlocks Goldfelty on this computer and encrypts everything it stores. Nobody can reset it for
                you — not even us.
              </p>
            </div>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Field label="Password" id="pw">
                <PasswordInput id="pw" value={password} onChange={setPassword} autoFocus placeholder="At least 10 characters" />
                {password && strength && (
                  <>
                    <div className="strength">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={`strength__bar ${i < strength.score ? `strength__bar--${strength.score}` : ''}`} />
                      ))}
                    </div>
                    <span className="field__hint">
                      {strength.label}
                      {strength.problems[0] ? ` — ${strength.problems[0]}` : ''}
                    </span>
                  </>
                )}
              </Field>
              <Field
                label="Confirm password"
                id="pw2"
                error={confirmPassword && !passwordsMatch ? 'The two passwords do not match.' : null}
              >
                <PasswordInput
                  id="pw2"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Type it again"
                  onEnter={() => passwordReady && void createVault()}
                />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <Button onClick={() => setStep('welcome')}>Back</Button>
              <Button variant="primary" block busy={busy} disabled={!passwordReady} onClick={() => void createVault()}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 'account' && (
          <>
            <div>
              <h1 className="gate__title">Create your goldfelty.com account</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                Your email links this vault to goldfelty.com for release notes and support. Your password and
                recovery phrase are never sent — the account is proved with a signature from your wallet key.
              </p>
            </div>
            <div className="card">
              <Field label="Email address" id="email" error={emailError}>
                <input
                  id="email"
                  className="input"
                  type="email"
                  value={email}
                  autoFocus
                  spellCheck={false}
                  placeholder="you@example.com"
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setEmailError(null)
                  }}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              size="lg"
              block
              onClick={() => {
                void window.goldfelty.onboarding.validateIdentity('placeholder', email).then((result) => {
                  if (result.ok && result.data.email) {
                    setEmailError(result.data.email)
                    return
                  }
                  setStep('recovery')
                })
              }}
            >
              Continue
            </Button>
          </>
        )}

        {step === 'recovery' && recovery && (
          <>
            <div>
              <h1 className="gate__title">Write down your recovery phrase</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                These 24 words rebuild every wallet in this vault on any computer. This is the only time Goldfelty
                will ever show them to you.
              </p>
            </div>

            <Banner tone="danger" title="This screen never comes back">
              Once you continue, the phrase and private key are sealed inside the encrypted vault. There is no
              &ldquo;show me again&rdquo; anywhere in the app.
            </Banner>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="seed-grid">
                <div className={revealed ? '' : 'blurred'} style={{ display: 'contents' }}>
                  {seedWords.map((word, i) => (
                    <span key={`${word}-${i}`} className="seed-word">
                      <span className="seed-word__i">{i + 1}</span>
                      {word}
                    </span>
                  ))}
                </div>
                {!revealed && (
                  <div className="reveal-veil">
                    <Button variant="primary" icon={<IconEye size={15} />} onClick={() => setRevealed(true)}>
                      Reveal phrase
                    </Button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Make sure nobody is looking at your screen.
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <CopyButton
                  value={recovery.mnemonic}
                  label="Copy phrase"
                  clearAfterMs={90_000}
                  onCopied={() =>
                    notify({
                      tone: 'info',
                      title: 'Phrase copied',
                      text: 'The clipboard clears itself in 90 seconds. Paste it somewhere offline.'
                    })
                  }
                />
                <CopyButton
                  value={recovery.privateKey}
                  label="Copy private key"
                  clearAfterMs={90_000}
                  onCopied={() =>
                    notify({ tone: 'info', title: 'Private key copied', text: 'The clipboard clears itself in 90 seconds.' })
                  }
                />
                <Button
                  icon={<IconDownload size={14} />}
                  size="sm"
                  onClick={() => {
                    const text = [
                      'GOLDFELTY RECOVERY SHEET',
                      'Keep this on paper. Anyone holding it controls your funds.',
                      '',
                      `Created:         ${new Date().toISOString()}`,
                      `Derivation path: ${recovery.derivationPath}`,
                      `Owner address:   ${recovery.ownerAddress}`,
                      '',
                      'Recovery phrase (24 words):',
                      recovery.mnemonic,
                      '',
                      'Owner private key:',
                      recovery.privateKey,
                      ''
                    ].join('\n')
                    const blob = new Blob([text], { type: 'text/plain' })
                    const url = URL.createObjectURL(blob)
                    const anchor = document.createElement('a')
                    anchor.href = url
                    anchor.download = 'goldfelty-recovery-sheet.txt'
                    anchor.click()
                    URL.revokeObjectURL(url)
                    notify({
                      tone: 'info',
                      title: 'Recovery sheet saved',
                      text: 'Print it, then delete the file. A file on disk is not a backup.'
                    })
                  }}
                >
                  Save sheet
                </Button>
              </div>

              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 13 }}>
                <div className="field__label" style={{ marginBottom: 5 }}>
                  Owner private key
                </div>
                <div className="mono" style={{ wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                  <span className={revealed ? '' : 'blurred'}>{recovery.privateKey}</span>
                </div>
                <div className="field__hint" style={{ marginTop: 6 }}>
                  Path {recovery.derivationPath} · owner {recovery.ownerAddress}
                </div>
              </div>
            </div>

            <Button variant="primary" size="lg" block disabled={!revealed} onClick={() => setStep('confirm')}>
              I have written it down
            </Button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div>
              <h1 className="gate__title">Confirm your backup</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                Four statements. Tick them only if each one is genuinely true.
              </p>
            </div>
            <div className="checklist">
              {BACKUP_CHECKS.map((text, i) => (
                <button
                  key={text}
                  className={`check ${checks[i] ? 'check--on' : ''}`}
                  onClick={() => setChecks((current) => current.map((value, j) => (i === j ? !value : value)))}
                >
                  <span className="check__box">{checks[i] && <IconCheck size={12} />}</span>
                  <span className="check__text">{text}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <Button onClick={() => setStep('recovery')}>Back</Button>
              <Button
                variant="primary"
                block
                busy={busy}
                disabled={!checks.every(Boolean)}
                onClick={() => {
                  if (!ticket) return
                  setBusy(true)
                  void run(window.goldfelty.onboarding.confirmBackup(ticket), 'Could not confirm your backup').then(
                    (ok) => {
                      setBusy(false)
                      if (!ok) return
                      // Purge the phrase from the renderer the moment it is sealed.
                      setRecovery(null)
                      setStep('username')
                    }
                  )
                }}
              >
                Seal my vault
              </Button>
            </div>
          </>
        )}

        {step === 'username' && (
          <>
            <div>
              <h1 className="gate__title">Pick your username</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                This is how you appear on goldfelty.com. Lowercase letters, numbers, hyphens and underscores.
              </p>
            </div>
            <div className="card">
              <Field
                label="Username"
                id="username"
                error={usernameState.ok === false ? (usernameState.reason ?? 'That username is taken.') : null}
                hint={
                  usernameState.checking
                    ? 'Checking availability…'
                    : usernameState.ok
                      ? usernameState.offline
                        ? 'goldfelty.com is unreachable — the name will be claimed when you next connect.'
                        : `${username.toLowerCase()} is available.`
                      : 'Three characters or more.'
                }
              >
                <input
                  id="username"
                  className="input"
                  value={username}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="satoshi"
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              size="lg"
              block
              busy={busy}
              disabled={usernameState.ok !== true || usernameState.checking}
              onClick={() => void register()}
            >
              Create my account
            </Button>
          </>
        )}

        {step === 'wallets' && (
          <>
            <div>
              <h1 className="gate__title">Connect your first wallets</h1>
              <p className="gate__lede" style={{ marginTop: 8 }}>
                Each one is a separate smart account with its own address, all recoverable from the phrase you just
                wrote down. You can add more — up to 256 — at any time in Settings.
              </p>
            </div>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="count-grid">
                {[1, 3, 5, 10, 25, 50].map((count) => (
                  <button
                    key={count}
                    className={`count-option ${walletCount === count ? 'count-option--on' : ''}`}
                    onClick={() => setWalletCount(count)}
                  >
                    <div className="count-option__n">{count}</div>
                    <div className="count-option__l">{count === 1 ? 'wallet' : 'wallets'}</div>
                  </button>
                ))}
              </div>
              <Field label="Or choose an exact number" hint="Between 1 and 256.">
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={256}
                  value={walletCount}
                  onChange={(e) => setWalletCount(Math.max(1, Math.min(256, Number(e.target.value) || 1)))}
                />
              </Field>
              {walletCount > 50 && (
                <Banner tone="info">
                  Connecting {walletCount} wallets means {walletCount} addresses to scan on every refresh. It works,
                  but expect refreshes to take a few seconds longer.
                </Banner>
              )}
            </div>
            <Button variant="primary" size="lg" block busy={busy} onClick={() => void finish()}>
              Connect {walletCount} {walletCount === 1 ? 'wallet' : 'wallets'} and open Goldfelty
            </Button>
          </>
        )}

        {step === 'recovery' && !recovery && (
          <Banner tone="danger" title="Recovery material is no longer available">
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <IconAlert size={14} /> Restart the app to begin setup again.
            </span>
          </Banner>
        )}
      </div>
    </div>
  )
}
