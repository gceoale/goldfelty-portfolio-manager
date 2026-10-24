import { useEffect, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { ReceivableAsset, RouteOption } from '@shared/types.ts'
import { useApp } from '../state/app.tsx'
import { Button, Empty, Field, Notice, Toolbar, WalletGlyph } from '../components/ui.tsx'
import { CheckIcon, CopyIcon } from '../components/Icons.tsx'
import { groupedAddress, shortAddress } from '../lib/format.ts'

const api = window.goldfelty

export function Receive({ symbol: initialSymbol }: { symbol?: string }): JSX.Element {
  const { run, openConnect } = useApp()
  const [assets, setAssets] = useState<ReceivableAsset[] | null>(null)
  const [symbol, setSymbol] = useState(initialSymbol ?? '')
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [routeKey, setRouteKey] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void run(api.receive.assets()).then((list) => {
      setAssets(list ?? [])
      if (list && list.length && !list.some((a) => a.symbol === symbol)) setSymbol(list.find((a) => a.symbol === 'ETH')?.symbol ?? list[0].symbol)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!symbol) return
    setRouteKey(null)
    void run(api.receive.routes(symbol)).then((r) => {
      const list = r ?? []
      setRoutes(list)
      if (list.length === 1) setRouteKey(keyOf(list[0]))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  const route = routes.find((r) => keyOf(r) === routeKey) ?? null

  useEffect(() => {
    setQr(null)
    setCopied(false)
    if (!route) return
    // Plain address in the code: every wallet scanner reads that.
    void QRCode.toDataURL(route.address, { margin: 1, width: 200, errorCorrectionLevel: 'M' }).then(setQr)
  }, [route])

  if (assets && assets.length === 0) {
    return (
      <div className="page">
        <Toolbar title="Receive" />
        <div className="page-body">
          <Empty title="No wallet to receive into">
            <p>Connect a wallet first. Goldfelty shows its address; the funds go straight to that wallet.</p>
            <Button variant="primary" onClick={() => openConnect(true)}>
              Connect a wallet
            </Button>
          </Empty>
        </div>
      </div>
    )
  }

  const copy = async (): Promise<void> => {
    if (!route) return
    if (await run(api.app.copy(route.address))) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  return (
    <div className="page">
      <Toolbar title="Receive" />
      <div className="page-body split">
        <div className="form">
          <Field label="Asset" htmlFor="recv-asset">
            <select id="recv-asset" className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(assets ?? []).map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.symbol}, {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Into" hint={routes.length > 1 ? 'Choose the wallet and network. The sender must use the same network.' : undefined}>
            <div className="route-list" role="radiogroup" aria-label="Receive into">
              {routes.map((r) => {
                const k = keyOf(r)
                return (
                  <label key={k} className={`route${routeKey === k ? ' selected' : ''}`}>
                    <input type="radio" name="recv-route" checked={routeKey === k} onChange={() => setRouteKey(k)} />
                    <WalletGlyph name={r.providerName ?? r.walletLabel} color={r.walletColor} size={20} />
                    <span className="route-text">
                      <span>
                        {r.walletLabel} <span className="muted">on {r.chainName}</span>
                      </span>
                      <span className="muted small mono">{shortAddress(r.address)}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </Field>
        </div>

        <aside className="review receive-card" aria-label="Address">
          {!route ? (
            <p className="muted">{routes.length > 1 ? 'Choose where it should arrive to see the address.' : 'Loading…'}</p>
          ) : (
            <>
              <div className="qr">{qr ? <img src={qr} width={200} height={200} alt={`QR code for ${route.address}`} /> : null}</div>
              <div className="address-block" aria-label={route.address}>
                {groupedAddress(route.address).map((g, i) => (
                  <span key={i}>{g}</span>
                ))}
              </div>
              <Button variant="primary" className="wide" onClick={() => void copy()}>
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {copied ? 'Copied' : 'Copy address'}
              </Button>
              <p className="muted small">
                {symbol} on <strong>{route.chainName}</strong> only. This is {route.walletLabel}’s address in {route.providerName ?? 'your wallet'}; open
                that wallet and check it shows the same characters before sharing it.
              </p>
              {route.chainName !== 'Ethereum' ? (
                <Notice>Sending from a different network to this address can strand the funds. Tell the sender to use {route.chainName}.</Notice>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function keyOf(r: RouteOption): string {
  return `${r.walletId}|${r.chainId}`
}
