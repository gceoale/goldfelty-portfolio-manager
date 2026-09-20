import { randomUUID } from 'node:crypto'
import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers'
import type { Store } from './store.ts'
import type { Vault } from './vault.ts'
import { providerFor } from './rpc.ts'
import { fetchPrices } from './prices.ts'
import {
  FACTORY_ADDRESS,
  deploymentCalldata,
  encodeNativeTransfer,
  encodeTokenTransfer
} from './smartAccount.ts'
import { TOKEN_BY_KEY, TOKENS, getChain } from '../shared/chains.ts'
import type { Balance, SendQuote, SendResult, TokenDef, TransferRecord, Wallet } from '../shared/types.ts'

/** Gas allowance when estimation is unavailable, chosen to cover an ERC-20 transfer. */
const FALLBACK_GAS = 120_000n
const DEPLOY_GAS = 260_000n

export interface RouteOption {
  walletId: string
  walletLabel: string
  walletColor: string
  walletKind: Wallet['kind']
  chainId: number
  chainName: string
  chainColor: string
  tokenKey: string
  address: string
  amount: number
  value: number
  /** False when this route cannot cover the requested amount. */
  sufficient: boolean
  /** True when the account contract is not yet deployed on this chain. */
  requiresDeployment: boolean
}

/**
 * Every wallet/chain pair that can send a given symbol. When this returns more
 * than one option the UI must make the user pick — silently choosing a route
 * would mean sending from a wallet the user did not intend.
 */
export function routesForSymbol(
  store: Store,
  balances: Balance[],
  symbol: string,
  requiredAmount = 0
): RouteOption[] {
  const upper = symbol.toUpperCase()
  const options: RouteOption[] = []

  for (const balance of balances) {
    const token = TOKEN_BY_KEY.get(balance.tokenKey)
    if (!token || token.symbol.toUpperCase() !== upper) continue
    const wallet = store.wallet(balance.walletId)
    if (!wallet || wallet.archived) continue
    const chain = getChain(token.chainId)
    options.push({
      walletId: wallet.id,
      walletLabel: wallet.label,
      walletColor: wallet.color,
      walletKind: wallet.kind,
      chainId: chain.id,
      chainName: chain.name,
      chainColor: chain.color,
      tokenKey: token.key,
      address: wallet.address,
      amount: balance.amount,
      value: balance.value,
      sufficient: balance.amount >= requiredAmount,
      requiresDeployment: !wallet.deployedOn.includes(chain.id)
    })
  }

  return options.sort(
    (a, b) =>
      Number(b.sufficient) - Number(a.sufficient) ||
      Number(a.requiresDeployment) - Number(b.requiresDeployment) ||
      b.amount - a.amount
  )
}

/** Wallets that can receive a symbol, for the Receive tab's routing choice. */
export function receiveRoutes(store: Store, symbol: string): RouteOption[] {
  const upper = symbol.toUpperCase()
  const tokens = TOKENS.filter((t) => t.symbol.toUpperCase() === upper)
  const options: RouteOption[] = []

  for (const wallet of store.activeWallets()) {
    for (const token of tokens) {
      if (!wallet.chainIds.includes(token.chainId)) continue
      const chain = getChain(token.chainId)
      const cached = store.cachedBalance(wallet.id, token.key)
      const amount = cached ? Number(formatUnits(cached.raw, token.decimals)) : 0
      options.push({
        walletId: wallet.id,
        walletLabel: wallet.label,
        walletColor: wallet.color,
        walletKind: wallet.kind,
        chainId: chain.id,
        chainName: chain.name,
        chainColor: chain.color,
        tokenKey: token.key,
        address: wallet.address,
        amount,
        value: 0,
        sufficient: true,
        requiresDeployment: !wallet.deployedOn.includes(chain.id)
      })
    }
  }
  return options.sort((a, b) => a.walletLabel.localeCompare(b.walletLabel) || a.chainId - b.chainId)
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
  if (wallet.kind !== 'smart' || wallet.derivationIndex === null) {
    throw new SendError('Watch-only wallets cannot send. Choose a different route.', 'WATCH_ONLY')
  }
  const token = TOKEN_BY_KEY.get(tokenKey)
  if (!token) throw new SendError('Unknown token.', 'NO_TOKEN')
  if (!wallet.chainIds.includes(token.chainId)) {
    throw new SendError(`${wallet.label} is not connected on ${getChain(token.chainId).name}.`, 'CHAIN_OFF')
  }
  return { wallet, token }
}

function buildCalldata(token: TokenDef, to: string, units: bigint): { to: string; data: string; value: bigint } {
  return token.address === null
    ? { to: '', data: encodeNativeTransfer(to, units), value: 0n }
    : { to: '', data: encodeTokenTransfer(token.address, to, units), value: 0n }
}

/**
 * Price a transfer without sending it: gas, fiat value, and every warning worth
 * showing before the user commits.
 */
export async function quoteTransfer(
  store: Store,
  vault: Vault,
  input: { walletId: string; tokenKey: string; to: string; amount: string }
): Promise<SendQuote> {
  const { wallet, token } = requireSendable(store, input.walletId, input.tokenKey)
  const chain = getChain(token.chainId)
  if (!isAddress(input.to)) throw new SendError('The recipient address is not valid.', 'BAD_RECIPIENT')
  const to = getAddress(input.to)

  let units: bigint
  try {
    units = parseUnits(input.amount, token.decimals)
  } catch {
    throw new SendError('That amount is not a valid number.', 'BAD_AMOUNT')
  }
  if (units <= 0n) throw new SendError('Enter an amount greater than zero.', 'BAD_AMOUNT')

  const warnings: string[] = []
  const requiresDeployment = !wallet.deployedOn.includes(chain.id)
  if (requiresDeployment) {
    warnings.push(
      `${wallet.label} has not been used on ${chain.name} yet. The first transfer also deploys the account contract, which costs extra gas.`
    )
  }
  if (to.toLowerCase() === wallet.address.toLowerCase()) {
    warnings.push('The recipient is this wallet. The transfer would return to where it started.')
  }
  if (token.address && to.toLowerCase() === token.address.toLowerCase()) {
    warnings.push('The recipient is the token contract itself. Funds sent there are normally unrecoverable.')
  }

  const settings = store.settings
  const call = buildCalldata(token, to, units)
  let gasLimit = FALLBACK_GAS
  let gasPrice = 0n
  let ownerBalance = 0n

  try {
    const provider = providerFor(chain.id, settings)
    const owner = vault.ownerAddress(wallet.derivationIndex!)
    const [feeData, balance] = await Promise.all([provider.getFeeData(), provider.getBalance(owner)])
    ownerBalance = balance
    gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
    if (!requiresDeployment) {
      try {
        gasLimit = await provider.estimateGas({ from: owner, to: wallet.address, data: call.data, value: call.value })
        gasLimit = (gasLimit * 120n) / 100n
      } catch {
        warnings.push('Gas could not be estimated precisely; the figure below is an upper bound.')
      }
    } else {
      gasLimit = FALLBACK_GAS + DEPLOY_GAS
    }
  } catch {
    warnings.push(`${chain.name} could not be reached, so the network fee is an estimate.`)
  }

  const feeUnits = gasLimit * gasPrice
  const networkFee = Number(formatUnits(feeUnits, chain.decimals))
  if (gasPrice > 0n && ownerBalance < feeUnits) {
    warnings.push(
      `The signer for ${wallet.label} holds ${Number(formatUnits(ownerBalance, chain.decimals)).toFixed(6)} ${chain.nativeSymbol} on ${chain.name}, which is below the estimated fee. Top it up before sending.`
    )
  }

  const priceIds = [token.priceId, TOKENS.find((t) => t.chainId === chain.id && t.address === null)?.priceId].filter(
    (id): id is string => !!id
  )
  const prices = await fetchPrices(priceIds, settings, store)
  const tokenPrice = token.priceId ? (prices[token.priceId]?.price ?? 0) : 0
  const nativePriceId = TOKENS.find((t) => t.chainId === chain.id && t.address === null)?.priceId
  const nativePrice = nativePriceId ? (prices[nativePriceId]?.price ?? 0) : 0
  const amount = Number(formatUnits(units, token.decimals))

  return {
    tokenKey: token.key,
    symbol: token.symbol,
    chainId: chain.id,
    chainName: chain.name,
    walletId: wallet.id,
    walletLabel: wallet.label,
    from: wallet.address,
    to,
    amount,
    networkFee,
    networkFeeSymbol: chain.nativeSymbol,
    networkFeeValue: networkFee * nativePrice,
    totalValue: amount * tokenPrice,
    requiresDeployment,
    warnings
  }
}

/**
 * Execute a quoted transfer. The password is re-checked here rather than
 * trusting an unlocked session, so an unattended machine cannot move funds.
 */
export async function executeTransfer(
  store: Store,
  vault: Vault,
  input: { walletId: string; tokenKey: string; to: string; amount: string; password: string }
): Promise<SendResult> {
  if (store.settings.confirmBeforeSend) {
    const ok = await vault.verify(input.password)
    if (!ok) throw new SendError('Incorrect password.', 'WRONG_PASSWORD')
  }

  const { wallet, token } = requireSendable(store, input.walletId, input.tokenKey)
  const chain = getChain(token.chainId)
  if (!isAddress(input.to)) throw new SendError('The recipient address is not valid.', 'BAD_RECIPIENT')
  const to = getAddress(input.to)
  const units = parseUnits(input.amount, token.decimals)
  if (units <= 0n) throw new SendError('Enter an amount greater than zero.', 'BAD_AMOUNT')

  const provider = providerFor(chain.id, store.settings)
  const signer = vault.ownerSigner(wallet.derivationIndex!, provider)

  // First use on a chain: deploy the counterfactual account before using it.
  if (!wallet.deployedOn.includes(chain.id)) {
    const code = await provider.getCode(wallet.address)
    if (code === '0x') {
      const deployTx = await signer.sendTransaction({
        to: FACTORY_ADDRESS,
        data: deploymentCalldata(wallet.ownerAddress!, BigInt(wallet.derivationIndex!))
      })
      await deployTx.wait(1)
    }
    store.updateWallet(wallet.id, { deployedOn: [...new Set([...wallet.deployedOn, chain.id])] })
  }

  const call = buildCalldata(token, to, units)
  let response
  try {
    response = await signer.sendTransaction({ to: wallet.address, data: call.data, value: call.value })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SendError(`The network rejected the transfer: ${message}`)
  }

  const amount = Number(formatUnits(units, token.decimals))
  const prices = token.priceId ? await fetchPrices([token.priceId], store.settings, store) : {}
  const value = amount * (token.priceId ? (prices[token.priceId]?.price ?? 0) : 0)

  const record: TransferRecord = {
    id: randomUUID(),
    direction: 'out',
    walletId: wallet.id,
    chainId: chain.id,
    symbol: token.symbol,
    amount,
    value,
    counterparty: to,
    hash: response.hash,
    at: Date.now(),
    status: 'pending'
  }
  store.addTransfer(record)

  // Follow the receipt in the background so the history row settles itself.
  void response
    .wait(1)
    .then((receipt) => store.updateTransfer(record.id, { status: receipt?.status === 1 ? 'confirmed' : 'failed' }))
    .catch(() => store.updateTransfer(record.id, { status: 'failed' }))

  return {
    hash: response.hash,
    explorerUrl: `${chain.explorer}/tx/${response.hash}`,
    chainId: chain.id,
    submittedAt: record.at
  }
}
