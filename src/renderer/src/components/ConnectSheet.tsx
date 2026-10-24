import { useEffect, useMemo, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import { FRAME_ID, TRACK_ONLY_WALLETS, providerIdFor, type RegistryWallet } from '@shared/walletRegistry.ts'
import type { BridgeStatus, ConnectStage, DetectedWallet, PendingConnection, Wallet } from '@shared/types.ts'
import { useApp } from '../state/app.tsx'
import { Button, Field, Notice, Sheet, Spinner, TextInput, WalletGlyph } from './ui.tsx'
import { CheckIcon, CopyIcon, SearchIcon } from './Icons.tsx'

const api = window.goldfelty

type Busy =
  | { kind: 'browser'; providerId: string; name: string; stage: ConnectStage | null }
  | { kind: 'frame'; stage: ConnectStage | null }
  | { kind: 'phone'; pending: PendingConnection; qr: string }
  | null

/**
 * Connect a wallet the user already has. Three ways in, no wallet created:
 * a browser extension through Goldfelty's own local bridge, the Frame desktop
 * app over its local socket, or a phone over WalletConnect.
 */
export function ConnectSheet({ onDone }: { onDone?: (wallets: Wallet[]) => void }): JSX.Element {
  const { registry, openConnect, notify, run } = useApp()
  const [query, setQuery] = useState('')
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [frameUp, setFrameUp] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<{ text: string; homepage?: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const [track, setTrack] = useState<{ providerId: string | null; name: string; why: string | null } | null>(null)

  const close = (): void => openConnect(false)

  useEffect(() => {
    let live = true
    const poll = async (): Promise<void> => {
      const b = await api.connections.bridge()
      if (live && b.ok) setBridge(b.data)
    }
    void poll()
    void api.connections.detectFrame().then((r) => live && r.ok && setFrameUp(r.data))
    const timer = setInterval(() => void poll(), 1500)
    const offProgress = api.events.onConnectProgress((stage) =>
      setBusy((b) => (b && (b.kind === 'browser' || b.kind === 'frame') ? { ...b, stage } : b))
    )
    const offApproved = api.events.onConnectionApproved(({ connection, wallets }) => {
      notify({ tone: 'good', title: `${connection.name} connected`, body: `${wallets.length} account${wallets.length === 1 ? '' : 's'} added.` })
      onDone?.(wallets)
      close()
    })
    const offFailed = api.events.onConnectionFailed((message) => {
      setBusy(null)
      setError({ text: message })
    })
    return () => {
      live = false
      clearInterval(timer)
      offProgress()
      offApproved()
      offFailed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const detected: DetectedWallet[] = bridge?.detected ?? []
  const detectedIds = new Set(detected.map((d) => d.providerId))
  const q = query.trim().toLowerCase()
  const matches = (name: string): boolean => !q || name.toLowerCase().includes(q)
  const browserWallets = useMemo(
    () => registry.filter((w) => w.id !== FRAME_ID && !detectedIds.has(w.id) && matches(w.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, bridge, q]
  )

  const finish = (wallets: Wallet[], name: string): void => {
    notify({ tone: 'good', title: `${name} connected`, body: `${wallets.length} account${wallets.length === 1 ? '' : 's'} added.` })
    onDone?.(wallets)
    close()
  }

  const connectBrowser = async (providerId: string, name: string, homepage?: string): Promise<void> => {
    setError(null)
    setBusy({ kind: 'browser', providerId, name, stage: null })
    const result = await api.connections.connectBrowser(providerId)
    if (result.ok) return finish(result.data.wallets, result.data.connection.name)
    setBusy(null)
    setError({ text: result.error, homepage: result.code === 'NOT_INSTALLED' ? homepage : null })
  }

  const connectFrame = async (): Promise<void> => {
    setError(null)
    setBusy({ kind: 'frame', stage: null })
    const result = await api.connections.connectFrame()
    if (result.ok) return finish(result.data.wallets, 'Frame')
    setBusy(null)
    setError({ text: result.error })
  }

  const connectPhone = async (): Promise<void> => {
    setError(null)
    const pending = await run(api.connections.connectWalletConnect(), 'Couldn’t start a phone connection')
    if (!pending) return
    const qr = await QRCode.toDataURL(pending.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
    setBusy({ kind: 'phone', pending, qr })
  }

  const copyLink = async (): Promise<void> => {
    if (await run(api.connections.copyBridgeLink())) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (track) {
    return (
      <TrackForm
        target={track}
        onBack={() => setTrack(null)}
        onDone={(w) => {
          notify({ tone: 'good', title: `Tracking ${w.label}`, body: 'Its balances now count in your portfolio. Send from it in the wallet itself.' })
          onDone?.([w])
          close()
        }}
      />
    )
  }

  if (busy?.kind === 'phone') {
    return (
      <Sheet title="Connect a phone wallet" onClose={close}>
        <div className="phone-connect">
          <img src={busy.qr} width={220} height={220} alt="WalletConnect pairing code" />
          <ol className="steps">
            <li>Open your wallet app on your phone.</li>
            <li>Find its scanner (often under WalletConnect).</li>
            <li>Scan this code and approve the connection.</li>
          </ol>
          <p className="muted small">
            This one way in uses the WalletConnect relay, because a phone can’t reach this computer directly. Everything is still approved on
            your phone.
          </p>
          <div className="waiting">
            <Spinner /> Waiting for your phone…
          </div>
        </div>
      </Sheet>
    )
  }

  const stageText = (stage: ConnectStage | null, fallback: string): string => {
    if (!stage) return fallback
    if (stage.stage === 'opening-browser') return 'Opening a Goldfelty tab in your browser…'
    if (stage.stage === 'waiting-for-tab') return `Looking for ${stage.wallet} in your browser…`
    return `Approve the connection in ${stage.wallet}.`
  }

  return (
    <Sheet
      title="Connect a wallet"
      onClose={close}
      wide
      footer={
        <span className="muted small">Goldfelty never sees your keys. Your wallet asks you to approve every transfer and signature.</span>
      }
    >
      {busy ? (
        <div className="connect-progress">
          <Spinner />
          <div>
            <strong>{busy.kind === 'browser' ? busy.name : 'Frame'}</strong>
            <div className="muted">{stageText(busy.stage, 'Starting…')}</div>
          </div>
          <Button small onClick={() => setBusy(null)}>
            Hide
          </Button>
        </div>
      ) : null}

      {error ? (
        <Notice tone="warn">
          {error.text}{' '}
          {error.homepage ? (
            <button type="button" className="link" onClick={() => void api.app.openExternal(error.homepage!)}>
              Get it
            </button>
          ) : null}
        </Notice>
      ) : null}

      <div className="search">
        <SearchIcon />
        <TextInput placeholder="Search 30+ wallets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search wallets" />
      </div>

      <div className="connect-columns">
        <div>
          <h3 className="list-title">Browser extensions</h3>
          <p className="muted small">
            {bridge?.pages
              ? `${bridge.pages} Goldfelty tab${bridge.pages === 1 ? '' : 's'} open. Wallets found there are listed first.`
              : 'Pick your wallet and Goldfelty opens a tab in your default browser to reach it.'}
          </p>
          <ul className="pick-list">
            {detected.filter((d) => matches(d.name)).map((d) => (
              <PickRow
                key={d.rdns}
                name={d.name}
                color="#8e8e93"
                icon={d.icon}
                note="Found in your browser"
                disabled={!!busy}
                onClick={() => void connectBrowser(providerIdFor(d.rdns, d.name), d.name)}
              />
            ))}
            {browserWallets.map((w: RegistryWallet) => (
              <PickRow key={w.id} name={w.name} color={w.color} disabled={!!busy} onClick={() => void connectBrowser(w.id, w.name, w.homepage)} />
            ))}
          </ul>
          <div className="list-foot">
            <span className="muted small">Wallet in another browser?</span>
            <Button small onClick={() => void copyLink()}>
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />} {copied ? 'Copied' : 'Copy a one-time link'}
            </Button>
          </div>
        </div>

        <div>
          <h3 className="list-title">On this computer</h3>
          <ul className="pick-list">
            <PickRow
              name="Frame"
              color="#16a085"
              note={frameUp === null ? 'Checking…' : frameUp ? 'Running' : 'Not running. Open Frame first.'}
              disabled={!!busy}
              onClick={() => void connectFrame()}
            />
          </ul>
          <p className="muted small">Frame also connects Ledger, Trezor and GridPlus hardware wallets.</p>

          <h3 className="list-title">On your phone</h3>
          <ul className="pick-list">
            <PickRow name="Phone wallet" color="#3b99fc" note="Scan a code with any WalletConnect wallet" disabled={!!busy} onClick={() => void connectPhone()} />
          </ul>

          <h3 className="list-title">Can’t connect</h3>
          <ul className="pick-list">
            {TRACK_ONLY_WALLETS.filter((w) => matches(w.name)).map((w) => (
              <PickRow
                key={w.id}
                name={w.name}
                color={w.color}
                note="Desktop and phone apps: track the balance, send from Exodus"
                disabled={!!busy}
                onClick={() => setTrack({ providerId: w.id, name: w.name, why: w.why })}
              />
            ))}
            <PickRow
              name="Another wallet"
              color="#8e8e93"
              note="Track any address, read-only"
              disabled={!!busy}
              onClick={() => setTrack({ providerId: null, name: 'Another wallet', why: null })}
            />
          </ul>
        </div>
      </div>
    </Sheet>
  )
}

/** Track an address from a wallet that can't connect. Read-only by design. */
function TrackForm({
  target,
  onBack,
  onDone
}: {
  target: { providerId: string | null; name: string; why: string | null }
  onBack: () => void
  onDone: (wallet: Wallet) => void
}): JSX.Element {
  const { openConnect } = useApp()
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState(target.providerId ? target.name : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const app = target.providerId ? target.name : 'the wallet'

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.wallets.track({ address, label, providerId: target.providerId })
    setBusy(false)
    if (r.ok) onDone(r.data)
    else setError(r.error)
  }

  return (
    <Sheet
      title={target.providerId ? `Track ${target.name}` : 'Track an address'}
      onClose={() => openConnect(false)}
      footer={
        <>
          <Button onClick={onBack}>Back</Button>
          <Button variant="primary" busy={busy} disabled={!address.trim()} onClick={() => void submit()}>
            Track
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (address.trim()) void submit()
        }}
      >
        {target.why ? <Notice>{target.why}</Notice> : null}
        <p className="muted">
          Goldfelty will show this address’s balances in your portfolio. It can’t send from it, and it won’t offer it as a place to receive:
          do both in {app}.
        </p>
        {target.providerId === 'exodus-desktop' ? (
          <p className="muted small">In Exodus, open Ethereum (or any network you use), choose Receive, and copy the address. One address covers every network Goldfelty tracks.</p>
        ) : null}
        <Field label="Address" htmlFor="track-address" error={error}>
          <TextInput id="track-address" mono autoFocus placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
        </Field>
        <Field label="Name" htmlFor="track-label">
          <TextInput id="track-label" maxLength={48} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </form>
    </Sheet>
  )
}

function PickRow({
  name,
  color,
  icon,
  note,
  disabled,
  onClick
}: {
  name: string
  color: string
  icon?: string | null
  note?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <li>
      <button type="button" className="pick-row" disabled={disabled} onClick={onClick}>
        <WalletGlyph name={name} color={color} icon={icon} size={22} />
        <span className="pick-text">
          <span>{name}</span>
          {note ? <span className="muted small">{note}</span> : null}
        </span>
      </button>
    </li>
  )
}
