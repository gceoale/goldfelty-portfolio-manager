import { useState, type JSX } from 'react'
import { useApp } from '../state/app.tsx'
import { AssetGlyph, Button, Group, Notice, Row, StatusDot, TextInput, Toolbar, WalletGlyph } from '../components/ui.tsx'
import { CopyIcon } from '../components/Icons.tsx'
import { money, tokenAmount } from '../lib/format.ts'

const api = window.goldfelty

export function WalletDetail({ id }: { id: string }): JSX.Element {
  const { wallets, connections, portfolio, settings, tokens, chains, run, go, notify, openConnect } = useApp()
  const wallet = wallets.find((w) => w.id === id)
  const [label, setLabel] = useState(wallet?.label ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)
  if (!wallet) {
    return (
      <div className="page">
        <Toolbar title="Wallet" />
        <div className="page-body">
          <p className="muted">That wallet is no longer in Goldfelty.</p>
        </div>
      </div>
    )
  }
  const currency = settings?.currency ?? 'USD'
  const connection = connections.find((c) => c.id === wallet.connectionId)
  const reachable = connection?.active === true
  const balances = (portfolio?.balances ?? []).filter((b) => b.walletId === wallet.id)
  const total = balances.reduce((s, b) => s + b.value, 0)

  const save = async (patch: Parameters<typeof api.wallets.update>[1]): Promise<void> => {
    if (await run(api.wallets.update(wallet.id, patch), 'Couldn’t save')) notify({ tone: 'good', title: 'Saved' })
  }

  return (
    <div className="page">
      <Toolbar title={wallet.label} subtitle={wallet.providerName ?? undefined}>
        {wallet.kind !== 'readonly' ? (
          <>
            <Button small onClick={() => go({ name: 'receive' })}>
              Receive
            </Button>
            <Button small variant="primary" onClick={() => go({ name: 'send' })} disabled={!reachable}>
              Send
            </Button>
          </>
        ) : null}
      </Toolbar>
      <div className="page-body narrow">
        {wallet.kind === 'readonly' ? (
          <Notice tone="warn">{wallet.note ?? 'Nothing can sign for this address, so Goldfelty only shows its balance.'}</Notice>
        ) : !wallet.connectionId ? (
          <Notice tone="warn">
            This wallet needs reconnecting before it can send.{' '}
            <button type="button" className="link" onClick={() => openConnect(true)}>
              Reconnect
            </button>
          </Notice>
        ) : null}

        <div className="wallet-head">
          <WalletGlyph name={wallet.providerName ?? wallet.label} color={wallet.color} icon={connection?.icon} size={36} />
          <div>
            <div className="mono wrap">{wallet.address}</div>
            <div className="muted small">
              {wallet.kind === 'readonly' ? (
                'Read-only'
              ) : (
                <>
                  <StatusDot on={reachable} label={reachable ? 'Reachable' : 'Not reachable'} />{' '}
                  {reachable
                    ? `Reachable through ${wallet.providerName}`
                    : wallet.kind === 'browser'
                      ? `Open the Goldfelty tab in the browser that has ${wallet.providerName} to send`
                      : wallet.kind === 'frame'
                        ? 'Open Frame to send'
                        : 'Phone not connected right now'}
                </>
              )}
            </div>
          </div>
          <Button small onClick={() => void run(api.app.copy(wallet.address))} aria-label="Copy address">
            <CopyIcon size={12} /> Copy
          </Button>
        </div>

        <h2 className="section-title">Balances {settings?.hideBalances ? null : <span className="muted">{money(total, currency)}</span>}</h2>
        {balances.length === 0 ? (
          <p className="muted">No balances on the networks this wallet is set to.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Network</th>
                <th className="num">Balance</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => {
                const token = tokens.find((t) => t.key === b.tokenKey)
                return (
                  <tr key={b.tokenKey}>
                    <td>
                      <span className="asset-cell">
                        <AssetGlyph symbol={b.symbol} color={token?.color ?? '#888888'} size={18} /> {b.symbol}
                      </span>
                    </td>
                    <td>{chains.find((c) => c.id === b.chainId)?.name}</td>
                    <td className="num">{settings?.hideBalances ? '•••' : tokenAmount(b.amount)}</td>
                    <td className="num">{settings?.hideBalances ? '•••' : money(b.value, currency)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <Group title="Name">
          <Row label="Shown as">
            <TextInput value={label} maxLength={48} onChange={(e) => setLabel(e.target.value)} aria-label="Wallet name" />
            <Button small disabled={!label.trim() || label === wallet.label} onClick={() => void save({ label })}>
              Rename
            </Button>
          </Row>
        </Group>

        <Group title="Networks" footer="Goldfelty reads balances on these networks for this wallet.">
          {chains
            .filter((c) => c.family === (wallet.family ?? 'evm') && (c.family !== 'evm' || settings?.enabledChains.includes(c.id)))
            .filter((c) => c.family === 'evm' || wallet.chainIds.includes(c.id))
            .map((c) => (
              <Row key={c.id} label={c.name}>
                <input
                  type="checkbox"
                  checked={wallet.chainIds.includes(c.id)}
                  aria-label={c.name}
                  onChange={(e) => {
                    const next = e.target.checked ? [...wallet.chainIds, c.id] : wallet.chainIds.filter((x) => x !== c.id)
                    if (next.length) void save({ chainIds: next })
                  }}
                />
              </Row>
            ))}
        </Group>

        <Group title="Remove">
          <Row label="Hide from Overview" detail="Keeps it, just out of totals and lists.">
            <Button small onClick={() => void save({ archived: true }).then(() => go({ name: 'overview' }))}>
              Hide
            </Button>
          </Row>
          <Row label="Remove from Goldfelty" detail="The wallet itself and its funds are untouched. Connect it again any time.">
            {confirmRemove ? (
              <>
                <Button small onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
                <Button
                  small
                  variant="danger"
                  onClick={() => void run(api.wallets.remove(wallet.id)).then((ok) => ok && go({ name: 'overview' }))}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button small variant="danger" onClick={() => setConfirmRemove(true)}>
                Remove…
              </Button>
            )}
          </Row>
        </Group>
      </div>
    </div>
  )
}
