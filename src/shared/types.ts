/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Nothing in here may contain secret material — every value described below
 * is safe to hand to the renderer process.
 */

/**
 * How a wallet got into the app.
 *
 * - `walletconnect` / `extension` are wallets the user already owns, reached
 *   through their own app. Goldfelty never holds their keys and asks them to
 *   sign every transaction.
 * - `smart` is a contract account this app derived from its own seed.
 * - `watch` is an address tracked without any ability to spend.
 */
export type WalletKind = 'smart' | 'watch' | 'walletconnect' | 'extension'

/** True for wallets whose keys live in somebody else's app. */
export function isExternal(kind: WalletKind): boolean {
  return kind === 'walletconnect' || kind === 'extension'
}

/** A connected wallet. Smart wallets are contract accounts owned by a derived signer. */
export interface Wallet {
  id: string
  label: string
  kind: WalletKind
  /** Smart-contract account address (identical on every chain — CREATE2). */
  address: string
  /** EOA that owns the contract account. `null` for watch-only wallets. */
  ownerAddress: string | null
  /** BIP-44 index the owner key was derived at. `null` for watch-only wallets. */
  derivationIndex: number | null
  /** CREATE2 salt used to pin the account address. */
  salt: string
  /** Chains this wallet is connected on. */
  chainIds: number[]
  /** Chains where the account contract has actually been deployed on-chain. */
  deployedOn: number[]
  /** Token keys this wallet holds or has been enabled for, beyond chain natives. */
  enabledTokens: string[]
  color: string
  createdAt: number
  archived: boolean
  /** For external wallets: the connection that can sign for this address. */
  connectionId: string | null
  /** Name of the wallet app holding the keys, e.g. "MetaMask". */
  providerName: string | null
}

export interface Chain {
  id: number
  key: string
  name: string
  shortName: string
  nativeSymbol: string
  nativeName: string
  decimals: number
  rpcUrls: string[]
  explorer: string
  color: string
  testnet: boolean
}

export interface TokenDef {
  /** `${chainId}:${address|native}` — unique across the app. */
  key: string
  chainId: number
  /** `null` means the chain's native asset. */
  address: string | null
  symbol: string
  name: string
  decimals: number
  /** Identifier used by the price provider. */
  priceId: string | null
  color: string
}

export interface Balance {
  walletId: string
  tokenKey: string
  chainId: number
  symbol: string
  /** Base-unit amount as a decimal string (wei-like). */
  raw: string
  /** Human-readable amount. */
  amount: number
  /** Fiat value at the time of the snapshot. */
  value: number
  /** True when the figure came from cache rather than a live RPC call. */
  stale: boolean
}

/** A token rolled up across every wallet and chain that holds it. */
export interface AssetHolding {
  symbol: string
  name: string
  color: string
  amount: number
  value: number
  priceId: string | null
  price: number
  change24h: number
  /** Per-wallet, per-chain breakdown — drives the routing choices in Send/Receive. */
  sources: Array<{
    walletId: string
    walletLabel: string
    walletColor: string
    chainId: number
    chainName: string
    tokenKey: string
    address: string
    amount: number
    value: number
  }>
}

export interface PortfolioSnapshot {
  at: number
  total: number
  /** Per-wallet totals at this instant. */
  byWallet: Record<string, number>
}

export interface Portfolio {
  total: number
  /** Absolute change over the selected window. */
  change: number
  /** Percentage change over the selected window. */
  changePct: number
  holdings: AssetHolding[]
  balances: Balance[]
  history: PortfolioSnapshot[]
  updatedAt: number
  /** True when at least one balance could not be refreshed from the network. */
  degraded: boolean
}

export type HistoryRange = '24h' | '7d' | '30d' | '1y' | 'all'

export interface Account {
  username: string
  email: string
  /** Goldfelty account id returned at registration. */
  goldfeltyId: string
  createdAt: number
  /** Set once the user has confirmed they stored the recovery material. */
  backedUp: boolean
  /** Whether the account was linked to goldfelty.com or created offline. */
  linked: boolean
}

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  currency: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'AUD' | 'CAD'
  autoLockMinutes: number
  hideBalances: boolean
  confirmBeforeSend: boolean
  refreshIntervalSeconds: number
  priceProviderUrl: string
  customRpc: Record<number, string>
  enabledChains: number[]
  telemetry: boolean
  /** Free project ID from cloud.reown.com. WalletConnect does nothing without it. */
  walletConnectProjectId: string
}

export interface AppStatus {
  initialized: boolean
  locked: boolean
  account: Account | null
  walletCount: number
  version: string
  platform: string
  arch: string
}

/** Recovery material. Returned exactly once, during onboarding, then destroyed. */
export interface RecoveryMaterial {
  mnemonic: string
  privateKey: string
  ownerAddress: string
  derivationPath: string
}

export interface SendQuote {
  tokenKey: string
  symbol: string
  chainId: number
  chainName: string
  walletId: string
  walletLabel: string
  from: string
  to: string
  amount: number
  /** Estimated network fee in the chain's native asset. */
  networkFee: number
  networkFeeSymbol: string
  networkFeeValue: number
  totalValue: number
  /** Populated when the contract account still needs deploying on this chain. */
  requiresDeployment: boolean
  warnings: string[]
}

export interface SendResult {
  hash: string
  explorerUrl: string
  chainId: number
  submittedAt: number
}

export interface TransferRecord {
  id: string
  direction: 'in' | 'out'
  walletId: string
  chainId: number
  symbol: string
  amount: number
  value: number
  counterparty: string
  hash: string
  at: number
  status: 'pending' | 'confirmed' | 'failed'
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

/** A wallet + chain pair a token can be sent from or received into. */
export interface RouteOption {
  walletId: string
  walletLabel: string
  walletColor: string
  walletKind: WalletKind
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

export interface SendableAsset {
  symbol: string
  name: string
  color: string
  amount: number
  value: number
  routes: number
}

export interface ReceivableAsset {
  symbol: string
  name: string
  color: string
  chains: string[]
  wallets: number
}


/** A live link to a wallet application the user controls. */
export interface WalletConnection {
  id: string
  kind: 'walletconnect' | 'extension'
  /** The wallet app's own name, as it reports it. */
  name: string
  icon: string | null
  /** Addresses this connection can sign for. */
  accounts: string[]
  /** Chains the wallet agreed to operate on. */
  chainIds: number[]
  connectedAt: number
  /** False once the wallet app disconnects or the session expires. */
  active: boolean
  /** WalletConnect session topic; null for the extension bridge. */
  topic: string | null
}

/** A pending connection the user still has to approve in their wallet. */
export interface PendingConnection {
  /** WalletConnect pairing URI, for the QR code and deep links. */
  uri: string
  /** Where to point a browser for the extension bridge. */
  bridgeUrl?: string
  expiresAt: number
}
