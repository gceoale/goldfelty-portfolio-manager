import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { RouteOption, SendQuote, SendableAsset } from '@shared/types.js'
import { Banner, Button, Card, Coin, EmptyState, Field, Modal, PasswordInput } from '../components/ui.js'
import { RouteChooser } from '../components/RouteChooser.js'
import { IconAlert, IconCheck, IconExternal, IconSend } from '../components/Icons.js'
import { useApp } from '../state/app.js'
import { money, shortAddress, tokenAmount } from '../lib/format.js'

/**
 * Send is a four-step funnel rather than one form. The route step is the reason:
 * when several wallets hold the same token, picking which one pays is a decision
 * only the user can make, and it has to happen before the amount is meaningful.
 */
export function Send({ onNavigate }: { onNavigate: (tab: string) => void }): JSX.Element {
  const { portfolio, settings, refreshPortfolio, notify, run } = useApp()
  const currency = settings?.currency ?? 'USD'

  const [assets, setAssets] = useState<SendableAsset[]>([])
  const [symbol, setSymbol] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [route, setRoute] = useState<RouteOption | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<SendQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ hash: string; url: string } | null>(null)

  const loadAssets = useCallback(async () => {
    const list = await run(window.goldfelty.send.symbols(), 'Could not list your assets')
    if (list) setAssets(list)
  }, [run])

  useEffect(() => {
    void loadAssets()
  }, [loadAssets, portfolio?.updatedAt])

  // Routes depend on the amount, because "can this wallet cover it" does.
  useEffect(() => {
    if (!symbol) {
      setRoutes([])
      return
    }
    void window.goldfelty.send.routes(symbol, Number(amount) || 0).then((result) => {
      if (!result.ok) return
      setRoutes(result.data)
      // Auto-select only when there is genuinely no choice to make.
      setRoute((current) => {
        if (current) return result.data.find((r) => r.walletId === current.walletId && r.tokenKey === current.tokenKey) ?? null
        return result.data.length === 1 ? result.data[0] : null
      })
    })
  }, [symbol, amount])

  const selectedAsset = useMemo(() => assets.find((a) => a.symbol === symbol) ?? null, [assets, symbol])
  const amountNumber = Number(amount) || 0
  const overBalance = route !== null && amountNumber > route.amount

  const detailsReady =
    route !== null && /^0x[a-fA-F0-9]{40}$/.test(recipient.trim()) && amountNumber > 0 && !overBalance

  useEffect(() => {
    if (!detailsReady || !route) {
      setQuote(null)
      return
    }
    let cancelled = false
    setQuoting(true)
    const timer = setTimeout(() => {
      void window.goldfelty.send
        .quote({ walletId: route.walletId, tokenKey: route.tokenKey, to: recipient.trim(), amount })
        .then((result) => {
          if (cancelled) return
          setQuoting(false)
          if (result.ok) setQuote(result.data)
          else {
            setQuote(null)
            notify({ tone: 'error', title: 'Could not price this transfer', text: result.error })
          }
        })
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(timer)
      setQuoting(false)
    }
  }, [detailsReady, route, recipient, amount, notify])

  const reset = (): void => {
    setSymbol(null)
    setRoutes([])
    setRoute(null)
    setRecipient('')
    setAmount('')
    setQuote(null)
    setSent(null)
  }

  const submit = async (): Promise<void> => {
    if (!route) return
    setSending(true)
    const result = await window.goldfelty.send.execute({
      walletId: route.walletId,
      tokenKey: route.tokenKey,
      to: recipient.trim(),
      amount,
      password
    })
    setSending(false)
    setPassword('')
    if (!result.ok) {
      notify({ tone: 'error', title: 'Transfer failed', text: result.error })
      return
    }
    setConfirmOpen(false)
    setSent({ hash: result.data.hash, url: result.data.explorerUrl })
    notify({ tone: 'success', title: 'Transfer submitted', text: shortAddress(result.data.hash, 10, 8) })
    void refreshPortfolio()
  }

  if (sent) {
    return (
      <div className="view">
        <div className="view__inner view__inner--narrow">
          <Card>
            <EmptyState
              icon={<IconCheck size={20} />}
              title="Transfer submitted"
              action={
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button icon={<IconExternal size={14} />} onClick={() => void window.goldfelty.app.openExternal(sent.url)}>
                    View on explorer
                  </Button>
                  <Button variant="primary" onClick={reset}>
                    Send something else
                  </Button>
                </div>
              }
            >
              Your transaction is on its way. It will settle in the network&rsquo;s own time — the Home tab updates
              once it confirms.
              <div className="mono" style={{ marginTop: 10, wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                {sent.hash}
              </div>
            </EmptyState>
          </Card>
        </div>
      </div>
    )
  }

  if (assets.length === 0) {
    return (
      <div className="view">
        <div className="view__inner view__inner--narrow">
          <Card>
            <EmptyState
              icon={<IconSend size={20} />}
              title="Nothing to send yet"
              action={
                <Button variant="primary" onClick={() => onNavigate('receive')}>
                  Get a receiving address
                </Button>
              }
            >
              Send becomes available once a smart wallet holds a balance. Watch-only wallets never appear here —
              Goldfelty has no key for them.
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
          {/* ---- 1. asset ---------------------------------------------- */}
          <Card>
            <div className={`step ${symbol ? 'step--done' : 'step--active'}`}>
              <div className="step__head">
                <span className="step__num">{symbol ? <IconCheck size={11} /> : 1}</span>
                <span className="step__title">Choose an asset</span>
                {selectedAsset && (
                  <span className="step__hint">
                    {tokenAmount(selectedAsset.amount, selectedAsset.symbol)} available
                  </span>
                )}
              </div>
              <div className="picker-grid">
                {assets.map((asset) => (
                  <button
                    key={asset.symbol}
                    className={`picker ${symbol === asset.symbol ? 'picker--selected' : ''}`}
                    onClick={() => {
                      setSymbol(asset.symbol)
                      setRoute(null)
                      setAmount('')
                      setQuote(null)
                    }}
                  >
                    <Coin symbol={asset.symbol} color={asset.color} size="sm" />
                    <div className="picker__body">
                      <div className="picker__title">{asset.symbol}</div>
                      <div className="picker__meta">
                        {asset.routes} {asset.routes === 1 ? 'wallet' : 'wallets'} · {money(asset.value, currency)}
                      </div>
                    </div>
                    {symbol === asset.symbol && <IconCheck size={15} className="picker__check" />}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {/* ---- 2. route ---------------------------------------------- */}
          {symbol && (
            <Card>
              <div className={`step ${route ? 'step--done' : 'step--active'}`}>
                <div className="step__head">
                  <span className="step__num">{route ? <IconCheck size={11} /> : 2}</span>
                  <span className="step__title">
                    {routes.length > 1 ? `Choose which wallet sends your ${symbol}` : 'Sending wallet'}
                  </span>
                  {routes.length > 1 && <span className="step__hint">{routes.length} routes available</span>}
                </div>

                <RouteChooser
                  routes={routes}
                  selected={route}
                  onSelect={setRoute}
                  symbol={symbol}
                  mode="send"
                  currency={currency}
                  requiredAmount={amountNumber}
                />
              </div>
            </Card>
          )}

          {/* ---- 3. details -------------------------------------------- */}
          {route && (
            <Card>
              <div className="step step--active">
                <div className="step__head">
                  <span className="step__num">3</span>
                  <span className="step__title">Amount and recipient</span>
                  <span className="step__hint">
                    on {route.chainName} from {route.walletLabel}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Field
                    label="Amount"
                    error={overBalance ? `That is more than the ${tokenAmount(route.amount, symbol!)} this wallet holds.` : null}
                    hint={
                      quote
                        ? `≈ ${money(quote.totalValue, currency)}`
                        : `Available: ${tokenAmount(route.amount, symbol ?? '')}`
                    }
                  >
                    <div className="input-group">
                      <input
                        className="input input--amount num"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      />
                      <div className="input-group__suffix" style={{ right: 12 }}>
                        <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>
                          {symbol}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => {
                            // Leave native gas behind — spending the balance to
                            // the last wei makes the account unusable.
                            const isNative = route.tokenKey.endsWith(':native')
                            const max = isNative ? Math.max(route.amount - (quote?.networkFee ?? 0.0008), 0) : route.amount
                            setAmount(String(Number(max.toFixed(8))))
                          }}
                        >
                          Max
                        </Button>
                      </div>
                    </div>
                  </Field>

                  <Field
                    label="Recipient address"
                    error={
                      recipient.trim() && !/^0x[a-fA-F0-9]{40}$/.test(recipient.trim())
                        ? 'That is not a valid address.'
                        : null
                    }
                    hint={`This address must be able to receive on ${route.chainName}.`}
                  >
                    <input
                      className="input input--mono"
                      placeholder="0x…"
                      spellCheck={false}
                      autoComplete="off"
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value.trim())}
                    />
                  </Field>
                </div>
              </div>
            </Card>
          )}

          {/* ---- 4. review --------------------------------------------- */}
          {detailsReady && (
            <Card>
              <div className="step step--active">
                <div className="step__head">
                  <span className="step__num">4</span>
                  <span className="step__title">Review</span>
                  {quoting && <span className="step__hint">Pricing…</span>}
                </div>

                {quote?.warnings.map((warning) => (
                  <div key={warning} style={{ marginBottom: 10 }}>
                    <Banner tone="warning">{warning}</Banner>
                  </div>
                ))}

                <div className="summary">
                  <div className="summary__line">
                    <span className="summary__key">Sending</span>
                    <span className="summary__val">{tokenAmount(amountNumber, symbol ?? '')}</span>
                  </div>
                  <div className="summary__line">
                    <span className="summary__key">From</span>
                    <span className="summary__val">
                      {route?.walletLabel} · <span className="mono">{shortAddress(route?.address ?? '')}</span>
                    </span>
                  </div>
                  <div className="summary__line">
                    <span className="summary__key">To</span>
                    <span className="summary__val mono">{recipient}</span>
                  </div>
                  <div className="summary__line">
                    <span className="summary__key">Network</span>
                    <span className="summary__val">{route?.chainName}</span>
                  </div>
                  <div className="summary__line">
                    <span className="summary__key">Estimated fee</span>
                    <span className="summary__val">
                      {quote
                        ? `${tokenAmount(quote.networkFee, quote.networkFeeSymbol)}${quote.networkFeeValue > 0 ? ` · ${money(quote.networkFeeValue, currency)}` : ''}`
                        : '—'}
                    </span>
                  </div>
                  <div className="summary__line summary__line--total">
                    <span>Value being sent</span>
                    <span className="summary__val">{quote ? money(quote.totalValue, currency) : '—'}</span>
                  </div>
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  block
                  style={{ marginTop: 18 }}
                  disabled={!quote || quoting}
                  icon={<IconSend size={15} />}
                  onClick={() => setConfirmOpen(true)}
                >
                  Send {tokenAmount(amountNumber, symbol ?? '')}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        title="Confirm this transfer"
        description="Transfers cannot be undone. Check the address one more time."
        onClose={() => {
          setConfirmOpen(false)
          setPassword('')
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setConfirmOpen(false)
                setPassword('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={sending}
              disabled={settings?.confirmBeforeSend !== false && password.length === 0}
              onClick={() => void submit()}
            >
              Send now
            </Button>
          </>
        }
      >
        <div className="summary">
          <div className="summary__line">
            <span className="summary__key">Amount</span>
            <span className="summary__val">{tokenAmount(amountNumber, symbol ?? '')}</span>
          </div>
          <div className="summary__line">
            <span className="summary__key">To</span>
            <span className="summary__val mono">{recipient}</span>
          </div>
          <div className="summary__line">
            <span className="summary__key">Via</span>
            <span className="summary__val">
              {route?.walletLabel} on {route?.chainName}
            </span>
          </div>
        </div>
        {quote?.requiresDeployment && (
          <Banner tone="warning" title="Two transactions">
            This wallet has not been used on {route?.chainName} before, so Goldfelty deploys the account contract
            first and then sends. You will be charged gas for both.
          </Banner>
        )}
        {settings?.confirmBeforeSend !== false ? (
          <Field label="Password" hint="Required for every transfer. Turn this off in Settings → Security.">
            <PasswordInput value={password} onChange={setPassword} autoFocus onEnter={() => void submit()} />
          </Field>
        ) : (
          <Banner tone="warning" title="Password confirmation is off">
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <IconAlert size={13} /> Anyone at this computer can move funds while the vault is unlocked.
            </span>
          </Banner>
        )}
      </Modal>
    </div>
  )
}
