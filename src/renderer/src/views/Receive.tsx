import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { ReceivableAsset, RouteOption } from '@shared/types.js'
import { Banner, Button, Card, Coin, CopyButton, EmptyState, Field } from '../components/ui.js'
import { RouteChooser } from '../components/RouteChooser.js'
import { IconAlert, IconCheck, IconExternal, IconReceive, IconSearch } from '../components/Icons.js'
import { useApp } from '../state/app.js'

/**
 * Receive mirrors Send: choose the asset, then — when more than one wallet can
 * take it — choose which wallet before the address is ever copyable. Handing out
 * an address on the wrong chain is how people lose money.
 */
export function Receive({ onNavigate }: { onNavigate: (tab: string) => void }): JSX.Element {
  const { wallets, chains, settings, notify, run } = useApp()
  const [assets, setAssets] = useState<ReceivableAsset[]>([])
  const [query, setQuery] = useState('')
  const [symbol, setSymbol] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [route, setRoute] = useState<RouteOption | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const currency = settings?.currency ?? 'USD'

  const load = useCallback(async () => {
    const list = await run(window.goldfelty.receive.symbols(), 'Could not list receivable assets')
    if (list) setAssets(list)
  }, [run])

  useEffect(() => {
    void load()
  }, [load, wallets.length])

  useEffect(() => {
    if (!symbol) {
      setRoutes([])
      setRoute(null)
      return
    }
    void window.goldfelty.receive.routes(symbol).then((result) => {
      if (!result.ok) return
      setRoutes(result.data)
      setRoute(result.data.length === 1 ? result.data[0] : null)
    })
  }, [symbol])

  useEffect(() => {
    if (!route) {
      setQr(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(route.address, {
      errorCorrectionLevel: 'M',
      margin: 0,
      scale: 8,
      color: { dark: '#0b0c10', light: '#ffffff' }
    }).then((url) => {
      if (!cancelled) setQr(url)
    })
    return () => {
      cancelled = true
    }
  }, [route])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return assets
    return assets.filter((a) => a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))
  }, [assets, query])

  const chain = route ? chains.find((c) => c.id === route.chainId) : null

  if (wallets.length === 0) {
    return (
      <div className="view">
        <div className="view__inner view__inner--narrow">
          <Card>
            <EmptyState
              icon={<IconReceive size={20} />}
              title="Connect a wallet first"
              action={
                <Button variant="primary" onClick={() => onNavigate('settings')}>
                  Connect a wallet
                </Button>
              }
            >
              Connect a wallet first.
            </EmptyState>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view__inner view__inner--narrow">
        <div className="steps">
          <Card>
            <div className={`step ${symbol ? 'step--done' : 'step--active'}`}>
              <div className="step__head">
                <span className="step__num">{symbol ? <IconCheck size={11} /> : 1}</span>
                <span className="step__title">What are you receiving?</span>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div className="input-group">
                  <input
                    className="input"
                    placeholder="Search assets"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ paddingLeft: 34 }}
                  />
                  <span style={{ position: 'absolute', left: 11, color: 'var(--text-muted)', display: 'flex' }}>
                    <IconSearch size={15} />
                  </span>
                </div>
              </div>
              <div className="picker-grid">
                {filtered.map((asset) => (
                  <button
                    key={asset.symbol}
                    className={`picker ${symbol === asset.symbol ? 'picker--selected' : ''}`}
                    onClick={() => setSymbol(asset.symbol)}
                  >
                    <Coin symbol={asset.symbol} color={asset.color} size="sm" />
                    <div className="picker__body">
                      <div className="picker__title">{asset.symbol}</div>
                      <div className="picker__meta">{asset.chains.join(', ')}</div>
                    </div>
                    {symbol === asset.symbol && <IconCheck size={15} className="picker__check" />}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="muted" style={{ fontSize: 12.5, gridColumn: '1 / -1' }}>
                    No asset matches &ldquo;{query}&rdquo;.
                  </p>
                )}
              </div>
            </div>
          </Card>

          {symbol && (
            <Card>
              <div className={`step ${route ? 'step--done' : 'step--active'}`}>
                <div className="step__head">
                  <span className="step__num">{route ? <IconCheck size={11} /> : 2}</span>
                  <span className="step__title">
                    {routes.length > 1 ? `Which wallet should receive your ${symbol}?` : 'Receiving wallet'}
                  </span>
                  {routes.length > 1 && <span className="step__hint">{routes.length} options</span>}
                </div>

                <RouteChooser
                  routes={routes}
                  selected={route}
                  onSelect={setRoute}
                  symbol={symbol}
                  mode="receive"
                  currency={currency}
                />
              </div>
            </Card>
          )}

          {route && (
            <Card>
              <div className="step step--active">
                <div className="step__head">
                  <span className="step__num">3</span>
                  <span className="step__title">Your address</span>
                </div>

                <Banner tone="warning" title={`Send only ${symbol} on ${route.chainName}`}>
                  {route.walletLabel}. Anything sent on another network may be unrecoverable.
                </Banner>

                <div className="qr-panel">
                  {qr && (
                    <div className="qr-frame">
                      <img src={qr} alt={`QR code for ${route.address}`} />
                    </div>
                  )}

                  <div className="address-box">
                    <span className="address-box__text">{route.address}</span>
                    <CopyButton
                      value={route.address}
                      variant="primary"
                      label="Copy"
                      onCopied={() =>
                        notify({
                          tone: 'success',
                          title: 'Address copied',
                          text: `${route.walletLabel} on ${route.chainName}`
                        })
                      }
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {chain && (
                      <Button
                        size="sm"
                        icon={<IconExternal size={13} />}
                        onClick={() => void window.goldfelty.app.openExternal(`${chain.explorer}/address/${route.address}`)}
                      >
                        View on {chain.name}
                      </Button>
                    )}
                    <CopyButton value={`${symbol}:${route.address}@${route.chainId}`} label="Copy payment link" />
                  </div>

                  {route.requiresDeployment && (
                    <Field hint="">
                      <p className="muted" style={{ fontSize: 12.5, maxWidth: 46 * 8 }}>
                        <IconAlert size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                        Not deployed on {route.chainName} yet. Receiving works anyway; the contract goes up on your first send.
                      </p>
                    </Field>
                  )}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
