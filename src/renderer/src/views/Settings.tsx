import { useEffect, useState, type JSX } from 'react'
import type { AccountApiStatus, Settings as SettingsT } from '@shared/types.ts'
import { formatFeeRate } from '@shared/fees.ts'
import { useApp } from '../state/app.tsx'
import { Button, Group, Row, Segmented, StatusDot, TextInput, Toggle, Toolbar, WalletGlyph } from '../components/ui.tsx'
import { shortAddress } from '../lib/format.ts'

const api = window.goldfelty
const TERMS_URL = 'https://goldfelty.com/terms/'

export function Settings(): JSX.Element {
  const { settings, updateSettings } = useApp()
  if (!settings) return <div className="page" />
  return (
    <div className="page">
      <Toolbar title="Settings" />
      <div className="page-body narrow">
        <Connections />
        <AccountSection />
        <Security settings={settings} update={updateSettings} />
        <Group title="Appearance">
          <Row label="Theme">
            <Segmented
              label="Theme"
              value={settings.theme}
              options={[
                { value: 'system', label: 'Automatic' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' }
              ]}
              onChange={(theme) => void updateSettings({ theme })}
            />
          </Row>
          <Row label="Currency">
            <select className="input input-small" value={settings.currency} onChange={(e) => void updateSettings({ currency: e.target.value as SettingsT['currency'] })}>
              {['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Row>
          <Row label="Hide balances" detail="Shows dots instead of amounts, for screen sharing.">
            <Toggle label="Hide balances" checked={settings.hideBalances} onChange={(hideBalances) => void updateSettings({ hideBalances })} />
          </Row>
        </Group>
        <Networks settings={settings} update={updateSettings} />
        <FeesSection />
        <DataSection />
        <About />
      </div>
    </div>
  )
}

/* ---- connections ------------------------------------------------------------ */

function Connections(): JSX.Element {
  const { connections, wallets, registry, openConnect, run, notify } = useApp()
  const kindLabel = { browser: 'Browser extension', frame: 'Desktop app', walletconnect: 'Phone, via WalletConnect' } as const
  return (
    <Group
      title="Connected wallets"
      footer="Disconnecting stops Goldfelty asking that wallet for anything. Its accounts stay listed, read-only, until you reconnect."
    >
      {connections.length === 0 ? <Row label="None yet" detail="Connect a wallet you already use." /> : null}
      {connections.map((c) => {
        const count = wallets.filter((w) => w.connectionId === c.id).length
        const color = registry.find((r) => r.id === c.providerId)?.color ?? '#8e8e93'
        return (
          <Row
            key={c.id}
            label={
              <span className="inline">
                <WalletGlyph name={c.name} color={color} icon={c.icon} size={18} /> {c.name}
              </span>
            }
            detail={
              <>
                <StatusDot on={c.active} label={c.active ? 'Reachable' : 'Not reachable'} /> {kindLabel[c.kind]} · {count} account{count === 1 ? '' : 's'}
                {c.active ? '' : c.kind === 'browser' ? ' · open the Goldfelty tab to reach it' : ''}
              </>
            }
          >
            <Button
              small
              onClick={() =>
                void run(api.connections.disconnect(c.id)).then((r) => r && notify({ tone: 'info', title: `${c.name} disconnected` }))
              }
            >
              Disconnect
            </Button>
          </Row>
        )
      })}
      <Row label="Add another">
        <Button small variant="primary" onClick={() => openConnect(true)}>
          Connect a wallet…
        </Button>
      </Row>
      <Row label="Goldfelty browser tab" detail="Browser wallets are reached through a tab Goldfelty opens on this computer.">
        <Button small onClick={() => void run(api.connections.openBridge())}>
          Open tab
        </Button>
      </Row>
    </Group>
  )
}

/* ---- goldfelty.com account ---------------------------------------------------- */

function AccountSection(): JSX.Element {
  const { status, wallets, settings, updateSettings, run, notify, refreshStatus } = useApp()
  const [apiStatus, setApiStatus] = useState<AccountApiStatus | null>(null)
  const [signer, setSigner] = useState('')
  const [busy, setBusy] = useState(false)
  const account = status?.account ?? null
  const signers = wallets.filter((w) => w.kind !== 'readonly' && (w.family ?? 'evm') === 'evm' && w.connectionId && !w.archived)

  useEffect(() => {
    void api.account.apiStatus().then((r) => r.ok && setApiStatus(r.data))
  }, [])
  useEffect(() => {
    if (!signer && signers[0]) setSigner(signers[0].id)
  }, [signer, signers])

  const link = async (): Promise<void> => {
    setBusy(true)
    const result = await run(api.account.link(signer), 'Couldn’t link the account')
    setBusy(false)
    if (result) {
      notify({ tone: result.linked ? 'good' : 'info', title: result.linked ? 'Linked to goldfelty.com' : 'Still saved on this computer', body: result.message })
      await refreshStatus()
    }
  }

  return (
    <Group
      title="goldfelty.com account"
      footer="Linking sends your username, email and one wallet’s signature to goldfelty.com. Never your password or keys, and your balances only if you turn on sharing below."
    >
      {account ? (
        <>
          <Row label={account.username} detail={account.email} />
          <Row
            label="Status"
            detail={
              account.linked
                ? `Linked${account.address ? ` with ${shortAddress(account.address)}` : ''}`
                : apiStatus?.reachable === false
                  ? 'Saved on this computer. goldfelty.com isn’t reachable right now.'
                  : 'Saved on this computer only.'
            }
          >
            {!account.linked ? (
              signers.length ? (
                <>
                  <select className="input input-small" value={signer} onChange={(e) => setSigner(e.target.value)} aria-label="Sign with">
                    {signers.map((w) => (
                      <option key={w.id} value={w.id}>
                        Sign with {w.label}
                      </option>
                    ))}
                  </select>
                  <Button small variant="primary" busy={busy} disabled={apiStatus?.reachable === false} onClick={() => void link()}>
                    Link
                  </Button>
                </>
              ) : (
                <span className="muted small">Connect a wallet to link</span>
              )
            ) : null}
          </Row>
          <Row
            label="Share my portfolio total"
            detail="Sends goldfelty.com your total value, its currency and how many wallets it spans, at most every six hours. Never addresses or holdings. Turning this off deletes what was shared."
          >
            <Toggle
              label="Share my portfolio total"
              checked={settings?.shareTotals ?? false}
              onChange={(shareTotals) => void updateSettings({ shareTotals })}
            />
          </Row>
        </>
      ) : (
        <Row label="No account" detail="An account is optional. It reserves your username on goldfelty.com.">
          <span className="muted small">Set one up when you first open Goldfelty, or reset to start over.</span>
        </Row>
      )}
    </Group>
  )
}

/* ---- security ---------------------------------------------------------------------- */

function Security({ settings, update }: { settings: SettingsT; update: (p: Partial<SettingsT>) => Promise<boolean> }): JSX.Element {
  const { run, notify } = useApp()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const change = async (): Promise<void> => {
    setBusy(true)
    const ok = await run(api.vault.changePassword(current, next), 'Password not changed')
    setBusy(false)
    if (ok) {
      setCurrent('')
      setNext('')
      notify({ tone: 'good', title: 'Password changed' })
    }
  }
  return (
    <Group title="Security" footer="Goldfelty also locks when your computer sleeps or its screen locks.">
      <Row label="Lock after" detail="Minutes without using Goldfelty.">
        <select className="input input-small" value={settings.autoLockMinutes} onChange={(e) => void update({ autoLockMinutes: Number(e.target.value) })}>
          {[1, 5, 10, 15, 30, 60, 120].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </Row>
      <Row label="Change password" detail="Your local data is re-protected under the new one.">
        <TextInput type="password" placeholder="Current" value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="Current password" />
        <TextInput type="password" placeholder="New" value={next} onChange={(e) => setNext(e.target.value)} aria-label="New password" />
        <Button small busy={busy} disabled={!current || next.length < 10} onClick={() => void change()}>
          Change
        </Button>
      </Row>
    </Group>
  )
}

/* ---- networks ---------------------------------------------------------------------- */

function Networks({ settings, update }: { settings: SettingsT; update: (p: Partial<SettingsT>) => Promise<boolean> }): JSX.Element {
  const { chains, run } = useApp()
  const [rpc, setRpc] = useState<Record<number, string>>({ ...settings.customRpc })
  const [probe, setProbe] = useState<Record<number, string>>({})
  const test = async (id: number): Promise<void> => {
    setProbe((p) => ({ ...p, [id]: 'Checking…' }))
    const r = await run(api.settings.probeChain(id), null)
    setProbe((p) => ({ ...p, [id]: r?.ok ? `Block ${r.blockNumber}, ${r.latencyMs} ms` : `No answer${r?.error ? `: ${r.error}` : ''}` }))
  }
  return (
    <Group title="Networks" footer="Custom endpoints must be https://, or http:// on this computer. They’re tried before the built-in ones.">
      {chains.map((c) => {
        const evm = c.family === 'evm'
        // Other chains are always on: their wallets are only ever on that chain.
        const on = !evm || settings.enabledChains.includes(c.id)
        return (
          <Row key={c.id} label={c.name} detail={probe[c.id] ?? (c.testnet ? 'Test network' : !c.canSend ? 'Balances only' : undefined)}>
            {on ? (
              <>
                <TextInput
                  className="input-small"
                  placeholder={evm ? 'Custom RPC (optional)' : 'Custom API (optional)'}
                  value={rpc[c.id] ?? ''}
                  onChange={(e) => setRpc((r) => ({ ...r, [c.id]: e.target.value }))}
                  onBlur={() => (rpc[c.id] ?? '') !== (settings.customRpc[c.id] ?? '') && void update({ customRpc: { [c.id]: rpc[c.id] ?? '' } })}
                  aria-label={`${c.name} custom ${evm ? 'RPC' : 'API'}`}
                />
                <Button small onClick={() => void test(c.id)}>
                  Test
                </Button>
              </>
            ) : null}
            {evm ? (
              <Toggle
                label={c.name}
                checked={on}
                onChange={(v) =>
                  void update({ enabledChains: v ? [...settings.enabledChains, c.id] : settings.enabledChains.filter((x) => x !== c.id) })
                }
              />
            ) : null}
          </Row>
        )
      })}
    </Group>
  )
}

/* ---- fees and terms --------------------------------------------------------------- */

function FeesSection(): JSX.Element {
  const { fee } = useApp()
  return (
    <Group title="Fees and terms">
      <Row
        label="Goldfelty fee"
        detail={
          fee?.enabled
            ? `${formatFeeRate(fee.bps)} of each token you send through Goldfelty, on networks where it applies. It is shown before every send and approved in your wallet: inside the same transaction on Bitcoin and Solana, as its own transaction elsewhere.`
            : 'This build charges no fee.'
        }
      >
        <strong>{fee?.enabled ? formatFeeRate(fee.bps) : '0%'}</strong>
      </Row>
      <Row label="Terms of Service" detail="The owner of goldfelty.com can set the fee anywhere from 0% to 10%.">
        <Button small onClick={() => void api.app.openExternal(TERMS_URL)}>
          Read
        </Button>
      </Row>
    </Group>
  )
}

/* ---- data ---------------------------------------------------------------------------- */

function DataSection(): JSX.Element {
  const { run, notify } = useApp()
  const [confirm, setConfirm] = useState(false)
  const [password, setPassword] = useState('')
  const reset = async (): Promise<void> => {
    if (await run(api.settings.resetData(password), 'Not reset')) {
      notify({ tone: 'info', title: 'Wallets and history cleared' })
      setConfirm(false)
      setPassword('')
    }
  }
  return (
    <Group title="Data" footer="Everything Goldfelty stores is encrypted with your password. No keys are stored; your wallets hold those.">
      <Row label="Data folder">
        <Button small onClick={() => void run(api.settings.dataFolder())}>
          Show
        </Button>
      </Row>
      <Row label="Clear wallets and history" detail="Disconnects every wallet and forgets balances and activity. Settings and your account stay.">
        {confirm ? (
          <>
            <TextInput type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password to confirm" />
            <Button small onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button small variant="danger" disabled={!password} onClick={() => void reset()}>
              Clear
            </Button>
          </>
        ) : (
          <Button small variant="danger" onClick={() => setConfirm(true)}>
            Clear…
          </Button>
        )}
      </Row>
    </Group>
  )
}

function About(): JSX.Element {
  const { status } = useApp()
  return (
    <Group title="About">
      <Row label="Goldfelty Portfolio Manager" detail={`Version ${status?.version} · ${status?.platform} ${status?.arch}`}>
        <Button small onClick={() => void api.app.openExternal('https://goldfelty.com')}>
          goldfelty.com
        </Button>
      </Row>
    </Group>
  )
}

