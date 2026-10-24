import { useEffect, useMemo, useState, type JSX } from 'react'
import type { RouteOption, SendableAsset, SendQuote, SendResult } from '@shared/types.ts'
import { formatFeeRate } from '@shared/fees.ts'
import { useApp } from '../state/app.tsx'
import { AssetGlyph, Button, Empty, Field, Notice, Sheet, Spinner, StatusDot, TextInput, Toolbar, WalletGlyph } from '../components/ui.tsx'
import { WarningIcon } from '../components/Icons.tsx'
import { money, shortAddress, tokenAmount } from '../lib/format.ts'

const api = window.goldfelty

type Phase = { name: 'edit' } | { name: 'sending'; quote: SendQuote } | { name: 'done'; quote: SendQuote; result: SendResult }

export function Send({ symbol: initialSymbol }: { symbol?: string }): JSX.Element {
  const { settings, wallets, run, openConnect, refreshPortfolio, fee: feeInfo } = useApp()
  const currency = settings?.currency ?? 'USD'
  const [assets, setAssets] = useState<SendableAsset[] | null>(null)
  const [symbol, setSymbol] = useState(initialSymbol ?? '')
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [routeKey, setRouteKey] = useState<string | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<SendQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [phase, setPhase] = useState<Phase>({ name: 'edit' })

  useEffect(() => {
    void run(api.send.assets()).then((list) => {
      setAssets(list ?? [])
      if (list && list.length && !list.some((a) => a.symbol === symbol)) setSymbol(list[0].symbol)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!symbol) return
    setRouteKey(null)
    setQuote(null)
    void run(api.send.routes(symbol, Number(amount) || 0)).then((r) => {
      const list = r ?? []
      setRoutes(list)
      // Only one wallet holds it: nothing to choose. Several: the user picks.
      if (list.length === 1) setRouteKey(keyOf(list[0]))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  const route = routes.find((r) => keyOf(r) === routeKey) ?? null
  const asset = assets?.find((a) => a.symbol === symbol) ?? null
  const ownAddresses = useMemo(
    () => wallets.filter((w) => !w.archived && w.kind !== 'readonly' && w.address !== route?.address),
    [wallets, route]
  )

  // Any edit invalidates the review.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
  }, [routeKey, to, amount])

  const ready = !!route && /^0x[0-9a-fA-F]{40}$/.test(to.trim()) && Number(amount) > 0

  const review = async (): Promise<void> => {
    if (!route) return
    setQuoting(true)
    setQuoteError(null)
    const result = await api.send.quote({ walletId: route.walletId, tokenKey: route.tokenKey, to: to.trim(), amount: amount.trim() })
    setQuoting(false)
    if (result.ok) setQuote(result.data)
    else setQuoteError(result.error)
  }

  const send = async (): Promise<void> => {
    if (!quote || !route) return
    setPhase({ name: 'sending', quote })
    const result = await api.send.execute({
      walletId: route.walletId,
      tokenKey: route.tokenKey,
      to: quote.to,
      amount: amount.trim(),
      feeBps: quote.fee?.bps ?? 0
    })
    if (result.ok) {
      setPhase({ name: 'done', quote, result: result.data })
      void refreshPortfolio()
    } else {
      setPhase({ name: 'edit' })
      setQuote(null)
      setQuoteError(result.error)
    }
  }

  const setMax = (): void => {
    if (!route) return
    // Leave room for Goldfelty's fee, which comes out of the same balance.
    const bps = feeInfo?.enabled ? feeInfo.bps : 0
    const max = route.amount / (1 + bps / 10_000)
    setAmount(String(Math.floor(max * 1e6) / 1e6))
  }

  if (assets && assets.length === 0) {
    return (
      <div className="page">
        <Toolbar title="Send" />
        <div className="page-body">
          <Empty title="Nothing to send yet">
            <p>Send works from wallets that are connected and hold a balance.</p>
            <Button variant="primary" onClick={() => openConnect(true)}>
              Connect a wallet
            </Button>
          </Empty>
        </div>
      </div>
    )
  }

  const wallet = route?.providerName ?? 'your wallet'

  return (
    <div className="page">
      <Toolbar title="Send" />
      <div className="page-body split">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) void review()
          }}
        >
          <Field label="Asset" htmlFor="send-asset">
            <select id="send-asset" className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(assets ?? []).map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.symbol}: {tokenAmount(a.amount)} in {a.routes} place{a.routes === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="From"
            hint={routes.length > 1 ? `${routes.length} wallets hold ${symbol}. Choose which one sends it.` : undefined}
          >
            {routes.length === 0 ? (
              <span className="muted">{assets ? 'No connected wallet holds this.' : 'Loading…'}</span>
            ) : (
              <div className="route-list" role="radiogroup" aria-label="Send from">
                {routes.map((r) => {
                  const k = keyOf(r)
                  return (
                    <label key={k} className={`route${routeKey === k ? ' selected' : ''}${!r.reachable ? ' unreachable' : ''}`}>
                      <input type="radio" name="route" checked={routeKey === k} onChange={() => setRouteKey(k)} />
                      <WalletGlyph name={r.providerName ?? r.walletLabel} color={r.walletColor} size={20} />
                      <span className="route-text">
                        <span>
                          {r.walletLabel} <span className="muted">on {r.chainName}</span>
                        </span>
                        <span className="muted small">
                          {shortAddress(r.address)} · {r.reachable ? `via ${r.providerName ?? 'wallet'}` : `${r.providerName ?? 'Wallet'} isn’t reachable right now`}
                        </span>
                      </span>
                      <span className="route-amount">
                        {tokenAmount(r.amount, symbol)}
                        <StatusDot on={r.reachable} label={r.reachable ? 'Reachable' : 'Not reachable'} />
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </Field>

          <Field label="To" htmlFor="send-to" hint="Paste the full address and check it character by character.">
            <TextInput id="send-to" mono placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
            {ownAddresses.length > 0 ? (
              <select
                className="input input-quiet"
                aria-label="Send to one of your wallets"
                value=""
                onChange={(e) => e.target.value && setTo(e.target.value)}
              >
                <option value="">Or one of your wallets…</option>
                {ownAddresses.map((w) => (
                  <option key={w.id} value={w.address}>
                    {w.label} ({shortAddress(w.address)})
                  </option>
                ))}
              </select>
            ) : null}
          </Field>

          <Field label="Amount" htmlFor="send-amount" hint={route ? `Available: ${tokenAmount(route.amount, symbol)}` : undefined}>
            <div className="input-with">
              <TextInput
                id="send-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              <span className="input-suffix">{symbol}</span>
              <Button small onClick={setMax} disabled={!route}>
                Max
              </Button>
            </div>
          </Field>

          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={!ready} busy={quoting}>
              Review
            </Button>
          </div>
        </form>

        <aside className="review" aria-label="Review">
          <h2 className="section-title">Review</h2>
          {quoteError ? <Notice tone="bad">{quoteError}</Notice> : null}
          {!quote ? (
            <p className="muted">
              {asset ? <AssetGlyph symbol={asset.symbol} color={asset.color} size={18} /> : null} Fill in the form and choose Review. Nothing is sent until you
              approve it in your wallet.
            </p>
          ) : (
            <>
              <dl className="review-list">
                <dt>Recipient gets</dt>
                <dd>
                  <strong>{tokenAmount(quote.amount, quote.symbol)}</strong>
                  {quote.totalValue ? <span className="muted">{money(quote.totalValue, currency)}</span> : null}
                </dd>
                <dt>To</dt>
                <dd className="mono wrap">{quote.to}</dd>
                <dt>From</dt>
                <dd>
                  {quote.walletLabel} <span className="muted">on {quote.chainName}</span>
                </dd>
                <dt>Network fee</dt>
                <dd>
                  about {tokenAmount(quote.networkFee, quote.networkFeeSymbol)}
                  {quote.networkFeeValue ? <span className="muted">{money(quote.networkFeeValue, currency)}</span> : null}
                </dd>
                {quote.fee ? (
                  <>
                    <dt>Goldfelty fee ({formatFeeRate(quote.fee.bps)})</dt>
                    <dd>
                      {tokenAmount(quote.fee.amount, quote.fee.symbol)}
                      {quote.fee.value ? <span className="muted">{money(quote.fee.value, currency)}</span> : null}
                    </dd>
                    <dt>Total from wallet</dt>
                    <dd>
                      <strong>{tokenAmount(quote.amount + quote.fee.amount, quote.symbol)}</strong> <span className="muted">plus network fees</span>
                    </dd>
                  </>
                ) : null}
              </dl>
              {quote.warnings.map((w) => (
                <Notice key={w} tone="warn">
                  <WarningIcon size={12} /> {w}
                </Notice>
              ))}
              <p className="muted small">
                {quote.fee
                  ? `${quote.providerName} will ask you to approve two transactions: your transfer, then the ${formatFeeRate(quote.fee.bps)} Goldfelty fee. `
                  : `${quote.providerName} will show you the transfer to approve. `}
                Check the address there too.
              </p>
              <Button variant="primary" className="wide" onClick={() => void send()}>
                Send with {quote.providerName}
              </Button>
            </>
          )}
        </aside>
      </div>

      {phase.name === 'sending' ? (
        <Sheet title={`Approve in ${phase.quote.providerName}`} onClose={() => undefined}>
          <div className="waiting-block">
            <Spinner />
            <div>
              <p>
                {phase.quote.providerName} should be showing a request to send {tokenAmount(phase.quote.amount, phase.quote.symbol)} to{' '}
                <span className="mono">{shortAddress(phase.quote.to)}</span>.
              </p>
              {phase.quote.fee ? <p className="muted">After that, it asks for the Goldfelty fee of {tokenAmount(phase.quote.fee.amount, phase.quote.fee.symbol)}.</p> : null}
              {route?.walletKind === 'browser' ? <p className="muted small">It appears in your browser, in the Goldfelty tab.</p> : null}
              {route?.walletKind === 'walletconnect' ? <p className="muted small">Check your phone.</p> : null}
            </div>
          </div>
        </Sheet>
      ) : null}

      {phase.name === 'done' ? (
        <Sheet
          title="Sent"
          onClose={() => {
            setPhase({ name: 'edit' })
            setQuote(null)
            setAmount('')
          }}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setPhase({ name: 'edit' })
                setQuote(null)
                setAmount('')
              }}
            >
              Done
            </Button>
          }
        >
          <p>
            {wallet} broadcast your transfer of {tokenAmount(phase.quote.amount, phase.quote.symbol)}. It usually confirms within a minute; Activity shows when it
            does.
          </p>
          <p>
            <button type="button" className="link" onClick={() => void api.app.openExternal(phase.result.explorerUrl)}>
              View it on the block explorer
            </button>
          </p>
          {phase.result.fee?.status === 'sent' ? <p className="muted small">The Goldfelty fee was sent as a separate transaction.</p> : null}
          {phase.result.fee && phase.result.fee.status !== 'sent' ? (
            <Notice tone="warn">The Goldfelty fee wasn’t sent: {phase.result.fee.message}</Notice>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  )
}

function keyOf(r: RouteOption): string {
  return `${r.walletId}|${r.tokenKey}`
}
