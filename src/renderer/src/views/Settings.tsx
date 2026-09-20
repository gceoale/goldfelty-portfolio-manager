import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { Settings as SettingsShape, Wallet, WalletConnection } from '@shared/types.js'
import { Banner, Button, Card, CopyButton, EmptyState, Field, Modal, PasswordInput, Switch } from '../components/ui.js'
import {
  IconAlert,
  IconCheck,
  IconExternal,
  IconLayers,
  IconLink,
  IconLock,
  IconPencil,
  IconPlus,
  IconShield,
  IconTrash,
  IconWallet
} from '../components/Icons.js'
import { ConnectWalletModal } from '../components/ConnectWalletModal.js'
import { useApp } from '../state/app.js'
import { dateTime, shortAddress } from '../lib/format.js'

type Section = 'wallets' | 'general' | 'security' | 'networks' | 'account' | 'advanced'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'wallets', label: 'Wallets' },
  { id: 'general', label: 'General' },
  { id: 'security', label: 'Security' },
  { id: 'networks', label: 'Networks' },
  { id: 'account', label: 'Account' },
  { id: 'advanced', label: 'Advanced' }
]

export function Settings(): JSX.Element {
  const [section, setSection] = useState<Section>('wallets')
  return (
    <div className="view">
      <div className="view__inner">
        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                className={`settings-nav__item ${section === item.id ? 'settings-nav__item--active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-group">
            {section === 'wallets' && <WalletsSection />}
            {section === 'general' && <GeneralSection />}
            {section === 'security' && <SecuritySection />}
            {section === 'networks' && <NetworksSection />}
            {section === 'account' && <AccountSection />}
            {section === 'advanced' && <AdvancedSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   Wallets — connecting, labelling, archiving
   ====================================================================== */

function WalletsSection(): JSX.Element {
  const { wallets, chains, settings, maxWallets, refreshWallets, refreshPortfolio, notify, run } = useApp()
  const [chooserOpen, setChooserOpen] = useState(false)
  const [connections, setConnections] = useState<WalletConnection[]>([])
  const [connectOpen, setConnectOpen] = useState(false)
  const [watchOpen, setWatchOpen] = useState(false)
  const [editing, setEditing] = useState<Wallet | null>(null)
  const [removing, setRemoving] = useState<Wallet | null>(null)
  const [query, setQuery] = useState('')

  const [count, setCount] = useState(5)
  const [label, setLabel] = useState('')
  const [chainIds, setChainIds] = useState<number[]>(settings?.enabledChains ?? [])
  const [busy, setBusy] = useState(false)

  const [watchAddress, setWatchAddress] = useState('')
  const [watchLabel, setWatchLabel] = useState('')

  useEffect(() => {
    if (settings && chainIds.length === 0) setChainIds(settings.enabledChains)
  }, [settings, chainIds.length])

  const loadConnections = useCallback(async () => {
    const list = await run(window.goldfelty.connections.list(), 'Could not read wallet connections')
    if (list) setConnections(list)
  }, [run])

  useEffect(() => {
    void loadConnections()
    return window.goldfelty.events.onConnectionsChanged(() => {
      void loadConnections()
      void refreshWallets()
    })
  }, [loadConnections, refreshWallets])

  const active = wallets.filter((w) => !w.archived)
  const remaining = maxWallets - wallets.length

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return wallets
    return wallets.filter(
      (w) => w.label.toLowerCase().includes(needle) || w.address.toLowerCase().includes(needle)
    )
  }, [wallets, query])

  const connect = useCallback(async () => {
    setBusy(true)
    const created = await run(
      window.goldfelty.wallets.connectSmart({ count, label: label.trim() || undefined, chainIds }),
      'Could not connect those wallets'
    )
    setBusy(false)
    if (!created) return
    setConnectOpen(false)
    setLabel('')
    notify({
      tone: 'success',
      title: `${created.length} ${created.length === 1 ? 'wallet' : 'wallets'} connected`,
      text: created.length === 1 ? created[0].address : `${created[0].label} … ${created[created.length - 1].label}`
    })
    await refreshWallets()
    void refreshPortfolio()
  }, [count, label, chainIds, run, notify, refreshWallets, refreshPortfolio])

  const connectWatch = useCallback(async () => {
    setBusy(true)
    const created = await run(
      window.goldfelty.wallets.connectWatch({ address: watchAddress.trim(), label: watchLabel.trim() || undefined, chainIds }),
      'Could not add that address'
    )
    setBusy(false)
    if (!created) return
    setWatchOpen(false)
    setWatchAddress('')
    setWatchLabel('')
    notify({ tone: 'success', title: 'Watch wallet added', text: created.address })
    await refreshWallets()
    void refreshPortfolio()
  }, [watchAddress, watchLabel, chainIds, run, notify, refreshWallets, refreshPortfolio])

  const toggleChain = (id: number): void =>
    setChainIds((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]))

  return (
    <>
      <Card
        title="Connected wallets"
        description={`${active.length} active of ${maxWallets} possible. Every smart wallet is derived from your recovery phrase, so one backup covers all of them.`}
        action={
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={14} />}
            disabled={remaining <= 0}
            onClick={() => setChooserOpen(true)}
          >
            Connect wallet
          </Button>
        }
      >
        {remaining <= 0 && (
          <div style={{ marginBottom: 12 }}>
            <Banner tone="warning" title="Wallet limit reached">
              This vault holds the maximum of {maxWallets} wallets. Remove one before connecting another.
            </Banner>
          </div>
        )}

        {wallets.length > 8 && (
          <div style={{ marginBottom: 12 }}>
            <input
              className="input"
              placeholder="Filter by name or address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {wallets.length === 0 ? (
          <EmptyState
            icon={<IconWallet size={20} />}
            title="No wallets yet"
            action={
              <Button variant="primary" onClick={() => setChooserOpen(true)}>
                Connect your first wallet
              </Button>
            }
          >
            Connect a wallet you already use — MetaMask, Rainbow, Phantom, Coinbase Wallet — or let Goldfelty
            create smart-contract accounts for you.
          </EmptyState>
        ) : (
          <div className="wallet-list">
            {filtered.map((wallet) => (
              <div key={wallet.id} className="wallet-card" style={{ opacity: wallet.archived ? 0.55 : 1 }}>
                <span className="wallet-card__swatch" style={{ background: wallet.color }} />
                <div style={{ minWidth: 0 }}>
                  <div className="wallet-card__label">
                    {wallet.label}
                    {wallet.kind === 'watch' && <span className="tag">Watch-only</span>}
                    {wallet.archived && <span className="tag">Archived</span>}
                    {wallet.deployedOn.length > 0 && (
                      <span className="tag tag--positive">Live on {wallet.deployedOn.length}</span>
                    )}
                  </div>
                  <div className="wallet-card__addr">
                    {shortAddress(wallet.address, 10, 8)} ·{' '}
                    {wallet.chainIds
                      .map((id) => chains.find((c) => c.id === id)?.shortName ?? id)
                      .join(' · ')}
                    {wallet.derivationIndex !== null && ` · index ${wallet.derivationIndex}`}
                  </div>
                </div>
                <div className="wallet-card__actions">
                  <CopyButton value={wallet.address} label="" variant="ghost" />
                  <Button variant="ghost" size="sm" aria-label="Edit" onClick={() => setEditing(wallet)}>
                    <IconPencil size={14} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => setRemoving(wallet)}>
                    <IconTrash size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {connections.length > 0 && (
        <Card
          title="Connected wallet apps"
          description="Goldfelty holds no keys for these. Every transfer is approved in the app itself."
        >
          {connections.map((connection) => (
            <div key={connection.id} className="setting">
              <div className="setting__body">
                <div className="setting__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {connection.name}
                  <span className={`tag ${connection.active ? 'tag--positive' : 'tag--negative'}`}>
                    {connection.active ? 'Connected' : 'Disconnected'}
                  </span>
                  <span className="tag">
                    {connection.kind === 'walletconnect' ? 'WalletConnect' : 'Browser extension'}
                  </span>
                </div>
                <div className="setting__desc">
                  {connection.accounts.length} {connection.accounts.length === 1 ? 'account' : 'accounts'} ·{' '}
                  {connection.accounts.map((a: string) => shortAddress(a)).join(', ')}
                </div>
                {!connection.active && connection.kind === 'extension' && (
                  <div className="setting__desc" style={{ color: 'var(--warning)' }}>
                    The browser tab was closed. Reconnect to sign again.
                  </div>
                )}
              </div>
              <div className="setting__control">
                <Button
                  size="sm"
                  onClick={() => {
                    void run(
                      window.goldfelty.connections.disconnect(connection.id),
                      'Could not disconnect'
                    ).then(async (result) => {
                      if (!result) return
                      notify({
                        tone: 'info',
                        title: `${connection.name} disconnected`,
                        text: `${result.detached} ${result.detached === 1 ? 'wallet' : 'wallets'} can no longer send`
                      })
                      await loadConnections()
                      await refreshWallets()
                    })
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <ConnectWalletModal
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onCreateOwn={() => setConnectOpen(true)}
        onWatch={() => setWatchOpen(true)}
      />

      {/* ---- connect smart wallets ------------------------------------- */}
      <Modal
        open={connectOpen}
        title="Connect smart wallets"
        description="Each wallet is an ERC-1167 contract account with its own owner key, derived from your recovery phrase. The addresses are identical on every network you select."
        onClose={() => setConnectOpen(false)}
        footer={
          <>
            <Button onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={chainIds.length === 0} onClick={() => void connect()}>
              Connect {count} {count === 1 ? 'wallet' : 'wallets'}
            </Button>
          </>
        }
      >
        <Field label="How many" hint={`You can connect up to ${remaining} more.`}>
          <input
            className="input num"
            type="number"
            min={1}
            max={Math.max(remaining, 1)}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(remaining, Number(e.target.value) || 1)))}
          />
        </Field>
        <Field label="Name" hint={count > 1 ? 'A number is appended to each one.' : 'Optional.'}>
          <input
            className="input"
            placeholder={count > 1 ? 'Trading' : 'Savings'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Networks" hint="Balances are scanned on each selected network.">
          <div className="chain-chips">
            {chains.map((chain) => (
              <button
                key={chain.id}
                className={`chain-chip ${chainIds.includes(chain.id) ? 'chain-chip--on' : ''}`}
                onClick={() => toggleChain(chain.id)}
              >
                <span className="dot" style={{ background: chain.color }} />
                {chain.name}
                {chain.testnet && <span className="muted">test</span>}
              </button>
            ))}
          </div>
        </Field>
      </Modal>

      {/* ---- watch address --------------------------------------------- */}
      <Modal
        open={watchOpen}
        title="Watch an address"
        description="Track any address in your portfolio without holding its key. Watch wallets never appear as a send route."
        onClose={() => setWatchOpen(false)}
        footer={
          <>
            <Button onClick={() => setWatchOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!/^0x[a-fA-F0-9]{40}$/.test(watchAddress.trim())}
              onClick={() => void connectWatch()}
            >
              Add address
            </Button>
          </>
        }
      >
        <Field
          label="Address"
          error={
            watchAddress.trim() && !/^0x[a-fA-F0-9]{40}$/.test(watchAddress.trim())
              ? 'That is not a valid address.'
              : null
          }
        >
          <input
            className="input input--mono"
            placeholder="0x…"
            spellCheck={false}
            value={watchAddress}
            onChange={(e) => setWatchAddress(e.target.value.trim())}
          />
        </Field>
        <Field label="Name" hint="Optional.">
          <input className="input" placeholder="Cold storage" value={watchLabel} onChange={(e) => setWatchLabel(e.target.value)} />
        </Field>
      </Modal>

      {editing && <EditWalletModal wallet={editing} onClose={() => setEditing(null)} />}
      {removing && <RemoveWalletModal wallet={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

function EditWalletModal({ wallet, onClose }: { wallet: Wallet; onClose: () => void }): JSX.Element {
  const { chains, refreshWallets, refreshPortfolio, run } = useApp()
  const [label, setLabel] = useState(wallet.label)
  const [chainIds, setChainIds] = useState<number[]>(wallet.chainIds)
  const [archived, setArchived] = useState(wallet.archived)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    const updated = await run(
      window.goldfelty.wallets.update(wallet.id, { label, chainIds, archived }),
      'Could not update that wallet'
    )
    setBusy(false)
    if (!updated) return
    onClose()
    await refreshWallets()
    void refreshPortfolio()
  }

  return (
    <Modal
      open
      title="Edit wallet"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!label.trim() || chainIds.length === 0} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Networks" hint="Deselecting a network stops Goldfelty scanning it for this wallet.">
        <div className="chain-chips">
          {chains.map((chain) => (
            <button
              key={chain.id}
              className={`chain-chip ${chainIds.includes(chain.id) ? 'chain-chip--on' : ''}`}
              onClick={() =>
                setChainIds((current) =>
                  current.includes(chain.id) ? current.filter((c) => c !== chain.id) : [...current, chain.id]
                )
              }
            >
              <span className="dot" style={{ background: chain.color }} />
              {chain.name}
            </button>
          ))}
        </div>
      </Field>
      <div className="setting" style={{ borderTop: 'none', paddingTop: 4 }}>
        <div className="setting__body">
          <div className="setting__title">Archive this wallet</div>
          <div className="setting__desc">Hides it from the portfolio and from Send. Nothing is deleted.</div>
        </div>
        <div className="setting__control">
          <Switch checked={archived} onChange={setArchived} label="Archive wallet" />
        </div>
      </div>
      <div className="summary" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        <div className="summary__line">
          <span className="summary__key">Address</span>
          <span className="summary__val mono">{wallet.address}</span>
        </div>
        {wallet.ownerAddress && (
          <div className="summary__line">
            <span className="summary__key">Owner key</span>
            <span className="summary__val mono">{shortAddress(wallet.ownerAddress, 10, 8)}</span>
          </div>
        )}
        <div className="summary__line">
          <span className="summary__key">Connected</span>
          <span className="summary__val">{dateTime(wallet.createdAt)}</span>
        </div>
      </div>
    </Modal>
  )
}

function RemoveWalletModal({ wallet, onClose }: { wallet: Wallet; onClose: () => void }): JSX.Element {
  const { refreshWallets, refreshPortfolio, notify, run } = useApp()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    const ok = await run(window.goldfelty.wallets.remove(wallet.id), 'Could not remove that wallet')
    setBusy(false)
    if (!ok) return
    onClose()
    notify({ tone: 'info', title: `${wallet.label} removed`, text: 'Its funds are untouched and recoverable from your phrase.' })
    await refreshWallets()
    void refreshPortfolio()
  }

  return (
    <Modal
      open
      title={`Remove ${wallet.label}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" busy={busy} disabled={confirmation !== 'REMOVE'} onClick={() => void remove()}>
            Remove wallet
          </Button>
        </>
      }
    >
      <Banner tone="info" title="Nothing on-chain changes">
        Removing a wallet only takes it out of this app. The account still exists, still holds whatever it held, and
        comes back if you reconnect at the same derivation index.
      </Banner>
      {!wallet.archived && (
        <Banner tone="warning">
          If you just want it out of the way, archive it instead — that keeps it listed and reversible in one click.
        </Banner>
      )}
      <Field label="Type REMOVE to confirm">
        <input className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value.toUpperCase())} />
      </Field>
    </Modal>
  )
}

/* =========================================================================
   General
   ====================================================================== */

function GeneralSection(): JSX.Element {
  const { settings, updateSettings } = useApp()
  if (!settings) return <Card title="General">Loading…</Card>

  const set = <K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): void => {
    void updateSettings({ [key]: value } as Partial<SettingsShape>)
  }

  return (
    <Card title="General" description="How Goldfelty looks and how often it checks the networks.">
      <Setting title="Theme" description="Match your system, or pin one.">
        <select className="select" value={settings.theme} onChange={(e) => set('theme', e.target.value as SettingsShape['theme'])}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Match system</option>
        </select>
      </Setting>

      <Setting title="Display currency" description="Every value in the app is converted to this.">
        <select
          className="select"
          value={settings.currency}
          onChange={(e) => set('currency', e.target.value as SettingsShape['currency'])}
        >
          {['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </Setting>

      <Setting
        title="Hide balances"
        description="Replaces every figure with dots. Useful on a call or in a café."
      >
        <Switch checked={settings.hideBalances} onChange={(value) => set('hideBalances', value)} label="Hide balances" />
      </Setting>

      <Setting title="Refresh interval" description="How often balances are re-read from each network.">
        <select
          className="select"
          value={settings.refreshIntervalSeconds}
          onChange={(e) => set('refreshIntervalSeconds', Number(e.target.value))}
        >
          <option value={30}>Every 30 seconds</option>
          <option value={60}>Every minute</option>
          <option value={300}>Every 5 minutes</option>
          <option value={900}>Every 15 minutes</option>
        </select>
      </Setting>
    </Card>
  )
}

function Setting({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="setting">
      <div className="setting__body">
        <div className="setting__title">{title}</div>
        <div className="setting__desc">{description}</div>
      </div>
      <div className="setting__control">{children}</div>
    </div>
  )
}

/* =========================================================================
   Security
   ====================================================================== */

function SecuritySection(): JSX.Element {
  const { settings, updateSettings, notify, run } = useApp()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  if (!settings) return <Card title="Security">Loading…</Card>

  const change = async (): Promise<void> => {
    setBusy(true)
    const ok = await run(window.goldfelty.vault.changePassword(current, next), 'Could not change your password')
    setBusy(false)
    if (!ok) return
    setPasswordOpen(false)
    setCurrent('')
    setNext('')
    setConfirm('')
    notify({ tone: 'success', title: 'Password changed', text: 'Your vault has been re-encrypted.' })
  }

  return (
    <>
      <Card title="Security" description="What stands between this computer and your funds.">
        <Setting title="Auto-lock" description="Lock the vault after this long without input.">
          <select
            className="select"
            value={settings.autoLockMinutes}
            onChange={(e) => void updateSettings({ autoLockMinutes: Number(e.target.value) })}
          >
            <option value={1}>After 1 minute</option>
            <option value={5}>After 5 minutes</option>
            <option value={10}>After 10 minutes</option>
            <option value={30}>After 30 minutes</option>
            <option value={0}>Never</option>
          </select>
        </Setting>

        <Setting
          title="Require password for every transfer"
          description="Strongly recommended. Without it, an unlocked window is enough to move funds."
        >
          <Switch
            checked={settings.confirmBeforeSend}
            onChange={(value) => void updateSettings({ confirmBeforeSend: value })}
            label="Require password to send"
          />
        </Setting>

        <Setting title="Vault password" description="Re-encrypts your vault with a new key. Your recovery phrase does not change.">
          <Button icon={<IconLock size={14} />} onClick={() => setPasswordOpen(true)}>
            Change password
          </Button>
        </Setting>

        <Setting title="Lock now" description="Clears your keys from memory until you enter your password again.">
          <Button
            onClick={() => {
              void window.goldfelty.vault.lock()
            }}
          >
            Lock vault
          </Button>
        </Setting>
      </Card>

      <Card title="Recovery">
        <Banner tone="info" title="Your phrase is sealed">
          Goldfelty showed your recovery phrase once, during setup, and cannot show it again. That is deliberate: a
          wallet that can reveal its seed on demand is one screen-share away from being emptied. If you lost it,
          move your funds to a wallet whose phrase you do have.
        </Banner>
      </Card>

      <Modal
        open={passwordOpen}
        title="Change your password"
        onClose={() => setPasswordOpen(false)}
        footer={
          <>
            <Button onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!current || next.length < 10 || next !== confirm}
              onClick={() => void change()}
            >
              Change password
            </Button>
          </>
        }
      >
        <Field label="Current password">
          <PasswordInput value={current} onChange={setCurrent} autoFocus />
        </Field>
        <Field label="New password" hint="At least 10 characters, with a mix of cases, a number and a symbol.">
          <PasswordInput value={next} onChange={setNext} />
        </Field>
        <Field label="Confirm new password" error={confirm && next !== confirm ? 'These do not match.' : null}>
          <PasswordInput value={confirm} onChange={setConfirm} />
        </Field>
      </Modal>
    </>
  )
}

/* =========================================================================
   Networks
   ====================================================================== */

function NetworksSection(): JSX.Element {
  const { chains, settings, updateSettings, notify } = useApp()
  const [probing, setProbing] = useState<number | null>(null)
  const [results, setResults] = useState<Record<number, { ok: boolean; blockNumber?: number; latencyMs?: number; error?: string }>>({})

  if (!settings) return <Card title="Networks">Loading…</Card>

  const toggle = (id: number): void => {
    const next = settings.enabledChains.includes(id)
      ? settings.enabledChains.filter((c) => c !== id)
      : [...settings.enabledChains, id]
    if (next.length === 0) {
      notify({ tone: 'error', title: 'Keep at least one network', text: 'Goldfelty has nothing to scan otherwise.' })
      return
    }
    void updateSettings({ enabledChains: next })
  }

  const probe = async (id: number): Promise<void> => {
    setProbing(id)
    const result = await window.goldfelty.settings.probeChain(id)
    setProbing(null)
    if (result.ok) setResults((current) => ({ ...current, [id]: result.data }))
  }

  return (
    <Card title="Networks" description="Which chains Goldfelty scans, and where it reads them from.">
      {chains.map((chain) => {
        const enabled = settings.enabledChains.includes(chain.id)
        const probeResult = results[chain.id]
        return (
          <div key={chain.id} className="setting">
            <div className="setting__body">
              <div className="setting__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="dot" style={{ background: chain.color }} />
                {chain.name}
                {chain.testnet && <span className="tag">Testnet</span>}
                {probeResult && (
                  <span className={`tag ${probeResult.ok ? 'tag--positive' : 'tag--negative'}`}>
                    {probeResult.ok ? `block ${probeResult.blockNumber} · ${probeResult.latencyMs}ms` : 'unreachable'}
                  </span>
                )}
              </div>
              <div className="setting__desc">
                Chain ID {chain.id} · native {chain.nativeSymbol} ·{' '}
                {settings.customRpc[chain.id] ? 'custom RPC' : `${chain.rpcUrls.length} public endpoints`}
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, maxWidth: 520 }}>
                <input
                  className="input input--mono"
                  placeholder="Custom RPC URL (optional)"
                  defaultValue={settings.customRpc[chain.id] ?? ''}
                  spellCheck={false}
                  onBlur={(e) => {
                    const value = e.target.value.trim()
                    const nextRpc = { ...settings.customRpc }
                    if (value) nextRpc[chain.id] = value
                    else delete nextRpc[chain.id]
                    void updateSettings({ customRpc: nextRpc })
                  }}
                />
                <Button size="sm" busy={probing === chain.id} onClick={() => void probe(chain.id)}>
                  Test
                </Button>
              </div>
            </div>
            <div className="setting__control">
              <Switch checked={enabled} onChange={() => toggle(chain.id)} label={`Enable ${chain.name}`} />
            </div>
          </div>
        )
      })}
    </Card>
  )
}

/* =========================================================================
   Account
   ====================================================================== */

function AccountSection(): JSX.Element {
  const { status, refreshStatus, notify, run } = useApp()
  const [busy, setBusy] = useState(false)
  const account = status?.account

  if (!account) return <Card title="Account">No account on this computer.</Card>

  const link = async (): Promise<void> => {
    setBusy(true)
    const result = await run(window.goldfelty.settings.linkAccount(), 'Could not reach goldfelty.com')
    setBusy(false)
    if (!result) return
    if (result.linked) notify({ tone: 'success', title: 'Account linked to goldfelty.com' })
    else notify({ tone: 'info', title: 'Still offline', text: result.message })
    await refreshStatus()
  }

  return (
    <Card title="Account" description="Your goldfelty.com identity.">
      <Setting title="Username" description="How you appear on goldfelty.com.">
        <span className="mono">{account.username}</span>
      </Setting>
      <Setting title="Email" description="Used for release notes and support.">
        <span className="mono">{account.email}</span>
      </Setting>
      <Setting title="Account ID" description="Issued when the account was created.">
        <span className="mono">{shortAddress(account.goldfeltyId, 12, 6)}</span>
      </Setting>
      <Setting title="Created" description="When this vault was set up.">
        <span>{dateTime(account.createdAt)}</span>
      </Setting>
      <Setting
        title="goldfelty.com link"
        description={
          account.linked
            ? 'This account is registered with goldfelty.com.'
            : 'This account was created while offline and exists only on this computer.'
        }
      >
        {account.linked ? (
          <span className="tag tag--positive">
            <IconCheck size={11} /> Linked
          </span>
        ) : (
          <Button busy={busy} icon={<IconLink size={14} />} onClick={() => void link()}>
            Link now
          </Button>
        )}
      </Setting>
      <Setting title="Open goldfelty.com" description="Manage your profile in the browser.">
        <Button icon={<IconExternal size={14} />} onClick={() => void window.goldfelty.app.openExternal('https://goldfelty.com')}>
          Open
        </Button>
      </Setting>
    </Card>
  )
}

/* =========================================================================
   Advanced
   ====================================================================== */

function AdvancedSection(): JSX.Element {
  const { status, settings, updateSettings, refreshWallets, refreshPortfolio, notify, run } = useApp()
  const [paths, setPaths] = useState<{ vault: string; userData: string; logs: string } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [recoverOpen, setRecoverOpen] = useState(false)
  const [recoverCount, setRecoverCount] = useState(10)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.goldfelty.settings.dataPaths().then((result) => {
      if (result.ok) setPaths(result.data)
    })
  }, [])

  return (
    <>
      <Card title="Data" description="Where Goldfelty keeps things on this computer.">
        <Setting title="Vault file" description="Your encrypted recovery phrase. Back this file up alongside your written phrase.">
          {paths && <CopyButton value={paths.vault} label="Copy path" />}
        </Setting>
        <Setting title="Application data" description="Wallet labels, settings, portfolio history and caches.">
          {paths && <CopyButton value={paths.userData} label="Copy path" />}
        </Setting>
        <Setting title="Price provider" description="Any API exposing CoinGecko's /simple/price shape.">
          <input
            className="input input--mono"
            defaultValue={settings?.priceProviderUrl}
            spellCheck={false}
            onBlur={(e) => void updateSettings({ priceProviderUrl: e.target.value.trim() })}
          />
        </Setting>
      </Card>

      <Card title="Recovery tools">
        <Setting
          title="Rebuild wallet list"
          description="Re-derives wallets from your recovery phrase in order. Use after restoring this vault on a new computer. Labels and archive state are replaced."
        >
          <Button icon={<IconLayers size={14} />} onClick={() => setRecoverOpen(true)}>
            Rebuild
          </Button>
        </Setting>
      </Card>

      <Card title="About">
        <Setting title="Version" description="Goldfelty Portfolio Manager.">
          <span className="mono">
            {status?.version} · {status?.platform}/{status?.arch}
          </span>
        </Setting>
        <Setting
          title="Security status"
          description="This build has not had an independent security audit. Treat it accordingly."
        >
          <span className="tag tag--warning">
            <IconShield size={11} /> Unaudited
          </span>
        </Setting>
      </Card>

      <Card title="Danger zone">
        <Setting
          title="Reset application data"
          description="Clears wallets, labels, settings and history on this computer. Your vault file and recovery phrase are left alone, so your funds stay reachable."
        >
          <Button variant="danger" icon={<IconAlert size={14} />} onClick={() => setResetOpen(true)}>
            Reset data
          </Button>
        </Setting>
      </Card>

      <Modal
        open={recoverOpen}
        title="Rebuild wallet list"
        onClose={() => setRecoverOpen(false)}
        footer={
          <>
            <Button onClick={() => setRecoverOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                setBusy(true)
                void run(window.goldfelty.wallets.recover(recoverCount), 'Could not rebuild your wallets').then(
                  async (created) => {
                    setBusy(false)
                    if (!created) return
                    setRecoverOpen(false)
                    notify({ tone: 'success', title: `${created.length} wallets rebuilt` })
                    await refreshWallets()
                    void refreshPortfolio()
                  }
                )
              }}
            >
              Rebuild {recoverCount} wallets
            </Button>
          </>
        }
      >
        <Banner tone="warning" title="This replaces your current wallet list">
          Wallets are re-derived at indices 0 upward. Any custom names, colours or archived state are lost. Nothing
          on-chain is touched.
        </Banner>
        <Field label="How many wallets to derive" hint="Pick at least as many as you had before.">
          <input
            className="input num"
            type="number"
            min={1}
            max={256}
            value={recoverCount}
            onChange={(e) => setRecoverCount(Math.max(1, Math.min(256, Number(e.target.value) || 1)))}
          />
        </Field>
      </Modal>

      <Modal
        open={resetOpen}
        title="Reset application data?"
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={confirmation !== 'RESET'}
              onClick={() => {
                setBusy(true)
                void run(window.goldfelty.settings.reset(), 'Could not reset').then((ok) => {
                  setBusy(false)
                  if (ok) window.location.reload()
                })
              }}
            >
              Reset everything
            </Button>
          </>
        }
      >
        <Banner tone="danger" title="Your funds are not affected">
          Your vault file stays on disk and your recovery phrase still works. What goes is the list of wallets,
          their names, your settings and the growth history behind the Home chart.
        </Banner>
        <Field label="Type RESET to confirm">
          <input className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value.toUpperCase())} />
        </Field>
      </Modal>
    </>
  )
}
