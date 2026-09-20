import { useCallback, useEffect, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { PendingConnection } from '@shared/types.ts'
import { Banner, Button, CopyButton, Field, Modal } from './ui.js'
import { IconExternal, IconLink, IconSearch, IconWallet } from './Icons.js'
import { useApp } from '../state/app.js'

type Method = 'choose' | 'walletconnect' | 'extension' | 'create' | 'watch'

/**
 * Connecting a wallet the user already owns.
 *
 * Two routes, because no single one reaches everything: WalletConnect covers
 * phone and desktop wallet apps, while browser extensions are only reachable
 * through a page served to the user's own browser.
 */
export function ConnectWalletModal({
  open,
  onClose,
  onCreateOwn,
  onWatch
}: {
  open: boolean
  onClose: () => void
  onCreateOwn: () => void
  onWatch: () => void
}): JSX.Element {
  const { settings, updateSettings, notify, run, refreshWallets, refreshPortfolio } = useApp()
  const [method, setMethod] = useState<Method>('choose')
  const [pending, setPending] = useState<PendingConnection | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [projectId, setProjectId] = useState('')

  useEffect(() => {
    if (settings) setProjectId(settings.walletConnectProjectId)
  }, [settings])

  useEffect(() => {
    if (!open) {
      setMethod('choose')
      setPending(null)
      setQr(null)
    }
  }, [open])

  // A wallet approving on the other end closes this for us.
  useEffect(() => {
    const off = window.goldfelty.events.onConnectionApproved(({ connection, wallets }) => {
      notify({
        tone: 'success',
        title: `${connection.name} connected`,
        text: `${wallets.length} ${wallets.length === 1 ? 'account' : 'accounts'} added`
      })
      void refreshWallets()
      void refreshPortfolio()
      onClose()
    })
    const offFail = window.goldfelty.events.onConnectionFailed((message) =>
      notify({ tone: 'error', title: 'Connection failed', text: message })
    )
    return () => {
      off()
      offFail()
    }
  }, [notify, refreshWallets, refreshPortfolio, onClose])

  useEffect(() => {
    if (!pending?.uri || method !== 'walletconnect') {
      setQr(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(pending.uri, {
      errorCorrectionLevel: 'M',
      margin: 0,
      scale: 8,
      color: { dark: '#0b0c10', light: '#ffffff' }
    }).then((url) => !cancelled && setQr(url))
    return () => {
      cancelled = true
    }
  }, [pending, method])

  const startWalletConnect = useCallback(async () => {
    setMethod('walletconnect')
    // Without a project ID the relay call fails immediately. Show the one-time
    // setup form rather than an error the user cannot act on.
    if (!settings?.walletConnectProjectId) return
    setBusy(true)
    const result = await run(window.goldfelty.connections.connectWalletConnect(), 'Could not start WalletConnect')
    setBusy(false)
    if (!result) {
      setMethod('choose')
      return
    }
    setPending(result)
  }, [run, settings?.walletConnectProjectId])

  const startExtension = useCallback(async () => {
    setBusy(true)
    setMethod('extension')
    const result = await run(window.goldfelty.connections.connectExtension(), 'Could not start the browser bridge')
    setBusy(false)
    if (!result) {
      setMethod('choose')
      return
    }
    setPending(result)
  }, [run])

  const needsProjectId = !settings?.walletConnectProjectId

  return (
    <Modal
      open={open}
      title="Connect a wallet"
      description={
        method === 'choose'
          ? 'Use a wallet you already have, or let Goldfelty create one for you.'
          : undefined
      }
      onClose={onClose}
      wide={method === 'choose'}
    >
      {method === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <MethodCard
            icon={<IconLink size={17} />}
            title="Wallet app"
            body="MetaMask, Rainbow, Trust, Phantom, Coinbase Wallet and 500+ others. Scan a QR code from your phone, or open a wallet installed on this computer."
            badge="Recommended"
            onClick={() => void startWalletConnect()}
          />
          <MethodCard
            icon={<IconExternal size={17} />}
            title="Browser extension"
            body="MetaMask, Rabby or Phantom running in your browser. Opens a page in your default browser to make the connection."
            onClick={() => void startExtension()}
          />
          <MethodCard
            icon={<IconWallet size={17} />}
            title="Create wallets in Goldfelty"
            body="Smart-contract accounts derived from your recovery phrase. Use this if you do not already have a wallet."
            onClick={() => {
              onClose()
              onCreateOwn()
            }}
          />
          <MethodCard
            icon={<IconSearch size={17} />}
            title="Watch an address"
            body="Track any address in your portfolio without being able to spend from it."
            onClick={() => {
              onClose()
              onWatch()
            }}
          />
        </div>
      )}

      {method === 'walletconnect' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {needsProjectId ? (
            <>
              <Banner tone="warning" title="WalletConnect needs a project ID">
                WalletConnect routes through its own relay network, and that needs a free project ID. Create one at
                cloud.reown.com — it takes about two minutes — then paste it here.
              </Banner>
              <Field label="Project ID" hint="Stored locally. It identifies this app to the relay, and is not a secret key.">
                <input
                  className="input input--mono"
                  value={projectId}
                  spellCheck={false}
                  placeholder="e.g. 2f5a9c1e8b7d4a3f6c0e9b2d5a8f1c4e"
                  onChange={(e) => setProjectId(e.target.value.trim())}
                />
              </Field>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  icon={<IconExternal size={14} />}
                  onClick={() => void window.goldfelty.app.openExternal('https://cloud.reown.com')}
                >
                  Get a project ID
                </Button>
                <Button
                  variant="primary"
                  block
                  disabled={projectId.length < 8}
                  onClick={async () => {
                    await updateSettings({ walletConnectProjectId: projectId })
                    void startWalletConnect()
                  }}
                >
                  Save and connect
                </Button>
              </div>
            </>
          ) : busy || !pending ? (
            <div className="empty">
              <span className="spinner" />
              <span className="empty__title">Preparing a connection…</span>
            </div>
          ) : (
            <>
              <div className="qr-panel" style={{ padding: 8 }}>
                {qr && (
                  <div className="qr-frame">
                    <img src={qr} alt="WalletConnect QR code" />
                  </div>
                )}
                <p className="muted" style={{ fontSize: 13, maxWidth: 360 }}>
                  Scan this with your wallet app, or copy the link and paste it into a wallet on this computer.
                  Goldfelty never sees your keys — your wallet approves every transaction.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <CopyButton value={pending.uri} label="Copy link" />
                  <Button
                    icon={<IconExternal size={14} />}
                    onClick={() => void window.goldfelty.app.openExternal(`https://walletconnect.com/registry`)}
                  >
                    Which wallets work?
                  </Button>
                </div>
              </div>
              <Banner tone="info">Waiting for you to approve the connection in your wallet.</Banner>
            </>
          )}
        </div>
      )}

      {method === 'extension' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Banner tone="info" title="Check your browser">
            A page has opened in your default browser. Approve the connection there and it will appear here.
          </Banner>
          <p className="muted" style={{ fontSize: 13 }}>
            Extensions live inside the browser and cannot be reached from a desktop app directly, so Goldfelty
            serves a small page on this computer only (127.0.0.1) for your wallet to talk to.
          </p>
          <Banner tone="warning" title="Keep that tab open">
            The browser tab is the connection. Closing it disconnects the wallet, and Goldfelty will not be able to
            request signatures until you reconnect.
          </Banner>
          {pending?.bridgeUrl && (
            <Field label="If the page did not open" hint="Paste this into the browser where your extension is installed.">
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input input--mono" readOnly value={pending.bridgeUrl} />
                <CopyButton value={pending.bridgeUrl} label="Copy" />
              </div>
            </Field>
          )}
        </div>
      )}
    </Modal>
  )
}

function MethodCard({
  icon,
  title,
  body,
  badge,
  onClick
}: {
  icon: JSX.Element
  title: string
  body: string
  badge?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button className="picker" style={{ alignItems: 'flex-start', padding: '14px 15px' }} onClick={onClick}>
      <span style={{ color: 'var(--accent)', marginTop: 2 }}>{icon}</span>
      <div className="picker__body">
        <div className="picker__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {badge && <span className="tag tag--accent">{badge}</span>}
        </div>
        <div className="picker__meta" style={{ whiteSpace: 'normal', lineHeight: 1.5, marginTop: 3 }}>
          {body}
        </div>
      </div>
    </button>
  )
}
