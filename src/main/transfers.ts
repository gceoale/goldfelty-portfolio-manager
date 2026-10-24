import { randomUUID } from 'node:crypto'
import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers'
import type { Store } from './store.ts'
import { providerFor } from './rpc.ts'
import { fetchPrices } from './prices.ts'
import { erc20Interface } from './erc20.ts'
import { currentFeeBps, planFee, type FeePlan } from './fees.ts'
import { MAX_FEE_BPS } from '../shared/fees.ts'
import { TOKEN_BY_KEY, TOKENS, getChain, txUrl } from '../shared/chains.ts'
import { canSign } from '../shared/types.ts'
import { sameAddress, validateFor } from './addresses.ts'
import { otherStatus, quoteOther, sendOther, type OtherSigner } from './send/other.ts'
import type { Balance, Chain, RouteOption, SendQuote, SendResult, Settings, TokenDef, TransferRecord, Wallet } from '../shared/types.ts'

/**
 * Sending, from wallets the user owns.
 *
 * Goldfelty builds the transaction and hands it to the wallet app, which
 * shows it to the user and signs it. Nothing here can move funds on its own.
 */

/** Where transactions go once built: the connection manager, in practice. */
export interface Sender extends Partial<OtherSigner> {
  isReachable(connectionId: string): boolean
  sendTransaction(connectionId: string, chainId: number, tx: { from: string; to: string; value?: string; data?: string }): Promise<string>
}

/** Gas allowance when estimation fails, enough for an ERC-20 transfer. */
const FALLBACK_GAS = 120_000n

/**
 * Every wallet and chain that can send `symbol`. With more than one, the UI
 * makes the user choose; picking one silently would mean sending from a
 * wallet they didn't mean.
 */
export function routesForSymbol(store: Store, sender: Sender, balances: Balance[], symbol: string, requiredAmount = 0): RouteOption[] {
  const upper = symbol.toUpperCase()
  const options: RouteOption[] = []

  for (const balance of balances) {
    const token = TOKEN_BY_KEY.get(balance.tokenKey)
    if (!token || token.symbol.toUpperCase() !== upper) continue
    const wallet = store.wallet(balance.walletId)
    if (!wallet || wallet.archived || !canSign(wallet.kind)) continue
    if (!getChain(token.chainId).canSend) continue
    options.push(routeFor(wallet, token, balance.amount, balance.value, requiredAmount, sender))
  }

  return options.sort(
    (a, b) =>
      Number(b.reachable) - Number(a.reachable) ||
      Number(b.sufficient) - Number(a.sufficient) ||
      b.amount - a.amount
  )
}

/** Every connected wallet and chain that can receive `symbol`. */
export function receiveRoutes(store: Store, sender: Sender, symbol: string): RouteOption[] {
  const upper = symbol.toUpperCase()
  const tokens = TOKENS.filter((t) => t.symbol.toUpperCase() === upper)
  const options: RouteOption[] = []

  for (const wallet of store.activeWallets()) {
    // A read-only address from an earlier version must never be handed out:
    // nothing can move funds sent there.
    if (!canSign(wallet.kind)) continue
    for (const token of tokens) {
      if (!wallet.chainIds.includes(token.chainId)) continue
      const cached = store.cachedBalance(wallet.id, token.key)
      const amount = cached ? Number(formatUnits(cached.raw, token.decimals)) : 0
      options.push(routeFor(wallet, token, amount, 0, 0, sender))
    }
  }
  return options.sort((a, b) => a.walletLabel.localeCompare(b.walletLabel) || a.chainName.localeCompare(b.chainName))
}

function routeFor(wallet: Wallet, token: TokenDef, amount: number, value: number, required: number, sender: Sender): RouteOption {
  const chain = getChain(token.chainId)
  return {
    walletId: wallet.id,
    walletLabel: wallet.label,
    walletColor: wallet.color,
    walletKind: wallet.kind,
    providerName: wallet.providerName,
    providerId: wallet.providerId,
    chainId: chain.id,
    chainName: chain.name,
    chainColor: chain.color,
    tokenKey: token.key,
    address: wallet.address,
    amount,
    value,
    sufficient: amount >= required,
    reachable: !!wallet.connectionId && sender.isReachable(wallet.connectionId)
  }
}

export class SendError extends Error {
  readonly code: string
  constructor(message: string, code = 'SEND_FAILED') {
    super(message)
    this.code = code
  }
}

function requireSendable(store: Store, walletId: string, tokenKey: string): { wallet: Wallet; token: TokenDef } {
  const wallet = store.wallet(walletId)
  if (!wallet) throw new SendError('That wallet is no longer connected.', 'NO_WALLET')
  if (wallet.archived) throw new SendError('That wallet is archived.', 'ARCHIVED')
  if (!canSign(wallet.kind)) throw new SendError('Nothing can sign for that address.', 'READ_ONLY')
  if (!wallet.connectionId) {
    throw new SendError(`Reconnect ${wallet.providerName ?? 'this wallet'} in Settings to send from it.`, 'DISCONNECTED')
  }
  const token = TOKEN_BY_KEY.get(tokenKey)
  if (!token) throw new SendError('Unknown token.', 'NO_TOKEN')
  const chain = getChain(token.chainId)
  if (!wallet.chainIds.includes(token.chainId) || (wallet.family ?? 'evm') !== chain.family) {
    throw new SendError(`${wallet.label} isn’t set up for ${chain.name}.`, 'CHAIN_OFF')
  }
  if (!chain.canSend) throw new SendError(`Goldfelty can’t send on ${chain.name} yet. Send from the wallet itself.`, 'CANT_SEND')
  return { wallet, token }
}

function parseAmount(amount: string, token: TokenDef): bigint {
  let units: bigint
  try {
    units = parseUnits(amount.trim(), token.decimals)
  } catch {
    throw new SendError('That amount isn’t a number Goldfelty can use.', 'BAD_AMOUNT')
  }
  if (units <= 0n) throw new SendError('Enter an amount above zero.', 'BAD_AMOUNT')
  return units
}

function parseRecipient(to: string, chain: Chain): string {
  if (chain.family === 'evm') {
    if (!isAddress(to.trim())) throw new SendError('That address isn’t valid.', 'BAD_RECIPIENT')
    return getAddress(to.trim())
  }
  try {
    return validateFor(chain.family, chain.key, to)
  } catch {
    throw new SendError(`That isn’t a ${chain.name} address.`, 'BAD_RECIPIENT')
  }
}

/** The transaction the wallet is asked to send: a plain transfer it can describe. */
export function buildTransaction(wallet: Wallet, token: TokenDef, to: string, units: bigint): { from: string; to: string; value?: string; data?: string } {
  if (token.address === null) return { from: wallet.address, to, value: `0x${units.toString(16)}` }
  return { from: wallet.address, to: token.address, value: '0x0', data: erc20Interface.encodeFunctionData('transfer', [to, units]) }
}

/**
 * Address poisoning: scammers send dust from an address that shares the
 * first and last characters of one you use, hoping you copy it from your
 * history. Flag a recipient that looks like a known address but isn't one.
 */
export function lookalikeOf(to: string, known: string[]): string | null {
  const t = to.toLowerCase()
  for (const candidate of known) {
    const c = candidate.toLowerCase()
    if (c === t) return null
  }
  // The start (after any 0x) and the end are what people check by eye.
  for (const candidate of known) {
    const c = candidate.toLowerCase()
    if (c.slice(0, 6) === t.slice(0, 6) && c.slice(-4) === t.slice(-4)) return candidate
  }
  return null
}

/** EVM gas for the transfer, and the fee's own transaction, in wei. Adds warnings as it goes. */
async function quoteEvmNetwork(
  settings: Settings,
  chain: Chain,
  wallet: Wallet,
  token: TokenDef,
  to: string,
  units: bigint,
  fee: FeePlan | null,
  warnings: string[]
): Promise<bigint> {
  const tx = buildTransaction(wallet, token, to, units)
  let gasLimit = FALLBACK_GAS
  let gasPrice = 0n
  let nativeBalance = 0n
  try {
    const provider = providerFor(chain.id, settings)
    const [fees, balance] = await Promise.all([provider.getFeeData(), provider.getBalance(wallet.address)])
    nativeBalance = balance
    gasPrice = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
    try {
      gasLimit = ((await provider.estimateGas(tx)) * 120n) / 100n
    } catch {
      warnings.push('The network couldn’t simulate this transfer. It may fail; your wallet will say more.')
    }
  } catch {
    warnings.push(`Couldn’t reach ${chain.name}, so the fee is a guess.`)
  }

  // The Goldfelty fee is a second transaction, so it costs gas too.
  const gasUnits = gasLimit * gasPrice * (fee ? 2n : 1n)
  const nativeNeeded = gasUnits + (token.address === null ? units + (fee?.units ?? 0n) : 0n)
  if (gasPrice > 0n && nativeBalance < nativeNeeded) {
    warnings.push(`${wallet.label} doesn’t have enough ${chain.nativeSymbol} on ${chain.name} to cover this and the fees.`)
  }

  return gasUnits
}

/** Price a transfer and collect anything worth warning about, without sending. */
export async function quoteTransfer(
  store: Store,
  settings: Settings,
  input: { walletId: string; tokenKey: string; to: string; amount: string }
): Promise<SendQuote> {
  const { wallet, token } = requireSendable(store, input.walletId, input.tokenKey)
  const chain = getChain(token.chainId)
  const to = parseRecipient(input.to, chain)
  const units = parseAmount(input.amount, token)
  const warnings: string[] = []
  let fee = planFee(token, units, wallet.address, await currentFeeBps())
  const same = (a: string, b: string): boolean => sameAddress(chain.family, a, b)

  if (same(to, wallet.address)) warnings.push('You’re sending to the same wallet it comes from.')
  if (token.address && same(to, token.address)) {
    warnings.push(`That’s the ${token.symbol} contract itself. Tokens sent to it are almost always lost.`)
  }
  const readonly = store.wallets.find((w) => w.kind === 'readonly' && same(w.address, to))
  if (readonly && !readonly.note?.startsWith('Tracked address')) {
    warnings.push('That address was created by an earlier version of Goldfelty. Nothing can move funds out of it.')
  }
  const known = [...store.wallets.map((w) => w.address), ...store.transfers.map((t) => t.counterparty)]
  const lookalike = lookalikeOf(to, known)
  if (lookalike) {
    warnings.push(
      `This address looks like ${lookalike.slice(0, 6)}…${lookalike.slice(-4)}, which you’ve used before, but it’s a different address. ` +
        'Scammers create lookalikes to catch copy and paste. Check every character.'
    )
  }

  let networkUnits = 0n
  if (chain.family === 'evm') {
    networkUnits = await quoteEvmNetwork(settings, chain, wallet, token, to, units, fee, warnings)
  } else {
    const other = await quoteOther(chain, settings, wallet, token, to, units, fee)
    networkUnits = other.networkFee
    fee = other.fee
    warnings.push(...other.warnings)
  }
  const networkFee = Number(formatUnits(networkUnits, chain.decimals))

  const nativePriceId = TOKENS.find((t) => t.chainId === chain.id && t.address === null)?.priceId
  const priceIds = [token.priceId, nativePriceId].filter((id): id is string => !!id)
  const prices = await fetchPrices(priceIds, settings, store)
  const amount = Number(formatUnits(units, token.decimals))

  const tokenPrice = token.priceId ? (prices[token.priceId]?.price ?? 0) : 0
  const feeAmount = fee ? Number(formatUnits(fee.units, token.decimals)) : 0
  return {
    tokenKey: token.key,
    symbol: token.symbol,
    chainId: chain.id,
    chainName: chain.name,
    walletId: wallet.id,
    walletLabel: wallet.label,
    providerName: wallet.providerName ?? 'your wallet',
    from: wallet.address,
    to,
    amount,
    networkFee,
    networkFeeSymbol: chain.nativeSymbol,
    networkFeeValue: networkFee * (nativePriceId ? (prices[nativePriceId]?.price ?? 0) : 0),
    totalValue: amount * tokenPrice,
    fee: fee ? { bps: fee.bps, amount: feeAmount, symbol: token.symbol, value: feeAmount * tokenPrice, recipient: fee.recipient } : null,
    warnings
  }
}

/**
 * Hand the transfer to the wallet app. The user approves it there; there is
 * no password step here because Goldfelty holds nothing that could send.
 */
export async function executeTransfer(
  store: Store,
  settings: Settings,
  sender: Sender,
  input: { walletId: string; tokenKey: string; to: string; amount: string; feeBps: number }
): Promise<SendResult> {
  const { wallet, token } = requireSendable(store, input.walletId, input.tokenKey)
  const chain = getChain(token.chainId)
  const to = parseRecipient(input.to, chain)
  const units = parseAmount(input.amount, token)

  // Charge exactly the rate the user saw on the review screen, never more.
  const shown = Number(input.feeBps)
  if (!Number.isInteger(shown) || shown < 0 || shown > MAX_FEE_BPS) throw new SendError('Review the transfer again.', 'FEE_CHANGED')
  const fee = planFee(token, units, wallet.address, await currentFeeBps())

  if (chain.family !== 'evm') return executeOther(store, settings, sender, wallet, token, chain, to, units, fee, shown)

  if ((fee?.bps ?? 0) > shown) {
    throw new SendError('Goldfelty’s fee changed since you reviewed this. Review it again before sending.', 'FEE_CHANGED')
  }

  const tx = buildTransaction(wallet, token, to, units)
  let hash: string
  try {
    hash = await sender.sendTransaction(wallet.connectionId!, chain.id, tx)
  } catch (error) {
    throw walletError(error, wallet)
  }

  const amount = Number(formatUnits(units, token.decimals))
  const prices = token.priceId ? await fetchPrices([token.priceId], settings, store) : {}
  const price = token.priceId ? (prices[token.priceId]?.price ?? 0) : 0
  const record = recordOut(wallet, chain, token, amount, price, to, hash, 'transfer')
  store.addTransfer(record)
  void watchReceipt(store, settings, chain.id, hash, record.id, tx)

  const feeResult = fee ? await sendFee(store, settings, sender, wallet, token, fee, price) : null
  return { hash, explorerUrl: txUrl(chain, hash), chainId: chain.id, submittedAt: record.at, fee: feeResult }
}

/** A wallet's refusal or failure, in words the send screen can show. */
function walletError(error: unknown, wallet: Wallet): SendError {
  const err = error as Error & { code?: string | number }
  if (err.code === 4001 || /reject|denied|cancell?ed|declined/i.test(err.message)) {
    return new SendError(`You declined it in ${wallet.providerName ?? 'your wallet'}. Nothing was sent.`, 'DECLINED')
  }
  if (err.code === 'CHAIN_MISMATCH' || err.code === 'BRIDGE_CLOSED' || err.code === 'FRAME_UNAVAILABLE' || err.code === 'FEE_CHANGED') {
    return new SendError(err.message, String(err.code))
  }
  // Our own checks on Bitcoin, Solana and Tron transactions explain themselves.
  if (typeof err.code === 'string' && /^(TAMPERED|BAD_|INSUFFICIENT|DUST|BELOW_RENT|NO_PUBLIC_KEY|KEY_MISMATCH|UNSIGNED|TXID_MISMATCH|REJECTED|FEE_TOO_HIGH|UNSUPPORTED|CANT_SEND|NO_ACCOUNT|LOCKED)/.test(err.code)) {
    return new SendError(err.message, err.code)
  }
  return new SendError(`It wasn’t sent: ${err.message}`, 'WALLET_ERROR')
}

function recordOut(wallet: Wallet, chain: Chain, token: TokenDef, amount: number, price: number, counterparty: string, hash: string, kind: 'transfer' | 'fee'): TransferRecord {
  return {
    id: randomUUID(),
    direction: 'out',
    walletId: wallet.id,
    chainId: chain.id,
    symbol: token.symbol,
    amount,
    value: amount * price,
    counterparty,
    hash,
    at: Date.now(),
    status: 'pending',
    kind
  }
}

async function executeOther(
  store: Store,
  settings: Settings,
  sender: Sender,
  wallet: Wallet,
  token: TokenDef,
  chain: Chain,
  to: string,
  units: bigint,
  fee: FeePlan | null,
  shown: number
): Promise<SendResult> {
  if (!sender.signPsbt || !sender.signSolana || !sender.signTron) throw new SendError(`Goldfelty can’t send on ${chain.name} here.`, 'CANT_SEND')
  let sent
  try {
    sent = await sendOther(chain, settings, sender as OtherSigner, wallet, token, to, units, fee, shown)
  } catch (error) {
    throw walletError(error, wallet)
  }

  const prices = token.priceId ? await fetchPrices([token.priceId], settings, store) : {}
  const price = token.priceId ? (prices[token.priceId]?.price ?? 0) : 0
  const record = recordOut(wallet, chain, token, Number(formatUnits(units, token.decimals)), price, to, sent.hash, 'transfer')
  store.addTransfer(record)
  const watched = [record.id]

  let feeResult: SendResult['fee'] = null
  if (sent.fee) {
    if (sent.fee.status === 'sent' && sent.fee.hash) {
      const feeRecord = recordOut(wallet, chain, token, Number(formatUnits(sent.fee.plan.units, token.decimals)), price, sent.fee.plan.recipient, sent.fee.hash, 'fee')
      store.addTransfer(feeRecord)
      if (sent.fee.sameTransaction) watched.push(feeRecord.id)
      else void watchOther(store, settings, chain, sent.fee.hash, [feeRecord.id])
      feeResult = { status: 'sent', hash: sent.fee.hash, explorerUrl: txUrl(chain, sent.fee.hash) }
    } else {
      feeResult = { status: sent.fee.status === 'declined' ? 'declined' : 'failed', message: sent.fee.message ?? 'The fee wasn’t sent.' }
    }
  }
  void watchOther(store, settings, chain, sent.hash, watched)
  return { hash: sent.hash, explorerUrl: txUrl(chain, sent.hash), chainId: chain.id, submittedAt: record.at, fee: feeResult }
}

/** Follow a Bitcoin, Solana or Tron transaction until it settles. Unknown stays pending. */
async function watchOther(store: Store, settings: Settings, chain: Chain, hash: string, recordIds: string[]): Promise<void> {
  // Bitcoin blocks come every ten minutes or so, and can be slower.
  const deadline = Date.now() + (chain.family === 'utxo' ? 3 * 3_600_000 : 15 * 60_000)
  const every = chain.family === 'utxo' ? 30_000 : 5_000
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, every).unref?.())
    if (!store.isOpen) return
    const status = await otherStatus(chain, settings, hash).catch(() => 'pending' as const)
    if (status === 'pending') continue
    for (const id of recordIds) store.updateTransfer(id, { status, warning: null })
    return
  }
}

/**
 * The fee goes after the transfer, as its own transaction, so it is only
 * ever asked for once the user's transfer is on its way, and the wallet
 * shows it to them for what it is.
 */
async function sendFee(
  store: Store,
  settings: Settings,
  sender: Sender,
  wallet: Wallet,
  token: TokenDef,
  fee: FeePlan,
  price: number
): Promise<SendResult['fee']> {
  const chain = getChain(token.chainId)
  const tx = buildTransaction(wallet, token, fee.recipient, fee.units)
  try {
    const hash = await sender.sendTransaction(wallet.connectionId!, chain.id, tx)
    const record = recordOut(wallet, chain, token, Number(formatUnits(fee.units, token.decimals)), price, fee.recipient, hash, 'fee')
    store.addTransfer(record)
    void watchReceipt(store, settings, chain.id, hash, record.id, tx)
    return { status: 'sent', hash, explorerUrl: txUrl(chain, hash) }
  } catch (error) {
    const err = error as Error & { code?: string | number }
    const declined = err.code === 4001 || /reject|denied|cancell?ed|declined/i.test(err.message)
    return { status: declined ? 'declined' : 'failed', message: declined ? 'The fee was declined.' : err.message }
  }
}

/**
 * Compare what the chain recorded with what the wallet was asked to send.
 * Wallets legitimately change gas and nonce, never the sender, recipient,
 * amount or calldata. A difference means the wallet, or something posing as
 * it, sent something else, and the user should hear about it.
 */
export function describeMismatch(
  asked: { from: string; to: string; value?: string; data?: string },
  onChain: { from: string; to: string | null; value: bigint; data: string }
): string | null {
  const same = (a?: string | null, b?: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
  if (!same(asked.from, onChain.from)) return 'It was sent from a different address than the one you chose.'
  if (!same(asked.to, onChain.to)) return 'It went to a different address than the one you entered.'
  if (BigInt(asked.value ?? '0x0') !== onChain.value) return 'It moved a different amount than you entered.'
  const askedData = asked.data && asked.data !== '0x' ? asked.data : '0x'
  const chainData = onChain.data && onChain.data !== '0x' ? onChain.data : '0x'
  if (!same(askedData, chainData)) return 'Its contents differ from the transfer you approved here.'
  return null
}

/**
 * Poll for a receipt. Hand-rolled rather than ethers' waitForTransaction so
 * the timer never keeps the process alive on its own.
 */
async function pollReceipt(
  provider: ReturnType<typeof providerFor>,
  hash: string,
  timeoutMs: number
): Promise<{ status: number | null } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null)
    if (receipt) return receipt
    await new Promise<void>((resolve) => setTimeout(resolve, 8_000).unref?.())
  }
  return null
}

/** Follow a hash the wallet broadcast until it lands, and check it is what was asked for. */
async function watchReceipt(
  store: Store,
  settings: Settings,
  chainId: number,
  hash: string,
  recordId: string,
  asked: { from: string; to: string; value?: string; data?: string }
): Promise<void> {
  try {
    const provider = providerFor(chainId, settings)
    const receipt = await pollReceipt(provider, hash, 15 * 60_000)
    if (!store.isOpen) return
    let warning: string | null = null
    const sent = await provider.getTransaction(hash).catch(() => null)
    if (sent) warning = describeMismatch(asked, { from: sent.from, to: sent.to, value: sent.value, data: sent.data })
    store.updateTransfer(recordId, { status: receipt?.status === 1 ? 'confirmed' : 'failed', warning })
  } catch {
    // Unknown is not failed. Leave it pending rather than guess.
  }
}
