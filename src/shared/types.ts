/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Nothing in here carries secret material: Goldfelty holds no wallet keys, and
 * the only secret it has (the key that encrypts local data) never leaves the
 * main process.
 */

/**
 * How a wallet reaches the app.
 *
 * - `browser`: an extension in the user's browser (MetaMask, Rabby, ...),
 *   reached through the local bridge page.
 * - `frame`: the Frame desktop app, over its local WebSocket.
 * - `walletconnect`: a phone wallet, over the WalletConnect relay.
 * - `readonly`: an address carried over from an earlier version that nothing
 *   can sign for. Shown so balances are not hidden, never offered as a route.
 */
export type WalletKind = 'browser' | 'frame' | 'walletconnect' | 'readonly'

export function canSign(kind: WalletKind): boolean {
  return kind !== 'readonly'
}

/** One account the user has connected. A wallet app can expose several. */
export interface Wallet {
  id: string
  label: string
  kind: WalletKind
  address: string
  /** The connection that can sign for this address, if it is still around. */
  connectionId: string | null
  /** The wallet app holding the key, e.g. "MetaMask". */
  providerName: string | null
  /** Registry id or EIP-6963 rdns, used to pick an icon and a colour. */
  providerId: string | null
  chainIds: number[]
  enabledTokens: string[]
  color: string
  createdAt: number
  archived: boolean
  /** Shown beside read-only wallets to say why they cannot send. */
  note: string | null
}

/** A live or remembered link to a wallet application. */
export interface WalletConnection {
  id: string
  kind: 'browser' | 'frame' | 'walletconnect'
  name: string
  /** Registry id, or the EIP-6963 rdns for wallets not in the registry. */
  providerId: string
  /** The EIP-6963 rdns a browser wallet announced, which routes its requests. */
  rdns: string | null
  /** Data URI supplied by the wallet itself through EIP-6963. */
  icon: string | null
  accounts: string[]
  chainIds: number[]
  connectedAt: number
  /**
   * Whether the app can reach the wallet right now. A browser connection is
   * active while a Goldfelty tab is open in a browser that has the extension;
   * Frame while Frame is running; WalletConnect while the session lives.
   */
  active: boolean
  /** WalletConnect session topic. */
  topic: string | null
}

/** A wallet the bridge page has seen announce itself in the user's browser. */
export interface DetectedWallet {
  providerId: string
  rdns: string
  name: string
  icon: string | null
}

/** Where a connection attempt has got to, for the connect sheet. */
export type ConnectStage =
  | { stage: 'opening-browser'; wallet: string }
  | { stage: 'waiting-for-tab'; wallet: string }
  | { stage: 'approve-in-wallet'; wallet: string }

export interface BridgeStatus {
  running: boolean
  url: string | null
  /** Browser tabs currently holding the bridge open. */
  pages: number
  detected: DetectedWallet[]
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
  priceId: string | null
  color: string
}

export interface Balance {
  walletId: string
  tokenKey: string
  chainId: number
  symbol: string
  /** Base-unit amount as a decimal string. */
  raw: string
  amount: number
  value: number
  /** True when the figure came from cache rather than a live read. */
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
  byWallet: Record<string, number>
}

export interface Portfolio {
  total: number
  change: number
  changePct: number
  holdings: AssetHolding[]
  balances: Balance[]
  history: PortfolioSnapshot[]
  updatedAt: number
  degraded: boolean
}

export type HistoryRange = '24h' | '7d' | '30d' | '1y' | 'all'

export interface Account {
  username: string
  email: string
  goldfeltyId: string
  createdAt: number
  /** Whether goldfelty.com has a record of this account. */
  linked: boolean
  /** The address whose signature proved the account, once linked. */
  address: string | null
}

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  currency: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'AUD' | 'CAD'
  autoLockMinutes: number
  hideBalances: boolean
  refreshIntervalSeconds: number
  priceProviderUrl: string
  customRpc: Record<number, string>
  enabledChains: number[]
  /** Overrides the project ID shipped with the build. */
  walletConnectProjectId: string
  /**
   * Send the portfolio total (one number, its currency and the wallet count)
   * to goldfelty.com. Off unless the user turns it on.
   */
  shareTotals: boolean
}

export interface AppStatus {
  /** A vault exists on this computer. */
  initialized: boolean
  /** Setup finished: a password, and at least the chance to connect a wallet. */
  onboarded: boolean
  locked: boolean
  /** When failed unlocks have triggered a wait, the time it ends. */
  unlockRetryAt: number | null
  /** Only populated while unlocked. */
  account: Account | null
  /** Shown on the lock screen, so it lives outside the encrypted store. */
  greetingName: string | null
  walletCount: number
  version: string
  platform: string
  arch: string
  /** Set once after upgrading from a version that created wallets. */
  upgradeNotice: UpgradeNotice | null
}

export interface UpgradeNotice {
  /** Addresses that version created, now kept read-only. */
  createdAddresses: string[]
  /** Where the old encrypted vault was moved to. */
  backupPath: string
}

export interface SendQuote {
  tokenKey: string
  symbol: string
  chainId: number
  chainName: string
  walletId: string
  walletLabel: string
  providerName: string
  from: string
  to: string
  amount: number
  networkFee: number
  networkFeeSymbol: string
  networkFeeValue: number
  totalValue: number
  /** Goldfelty's fee, when one applies. Shown before anything is sent. */
  fee: QuotedFee | null
  warnings: string[]
}

export interface QuotedFee {
  /** Basis points: 50 is 0.5%. Sent back with the transfer to pin the rate. */
  bps: number
  amount: number
  symbol: string
  value: number
  recipient: string
}

export interface SendResult {
  hash: string
  explorerUrl: string
  chainId: number
  submittedAt: number
  /** What happened to the fee transaction, when there was one. */
  fee: { status: 'sent'; hash: string; explorerUrl: string } | { status: 'declined' | 'failed'; message: string } | null
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
  /** A Goldfelty fee payment rather than a transfer the user addressed. */
  kind?: 'transfer' | 'fee'
  /**
   * Set when what the chain recorded differs from what Goldfelty asked the
   * wallet to send, such as a different recipient or amount.
   */
  warning?: string | null
}

/** A wallet + chain pair a token can be sent from or received into. */
export interface RouteOption {
  walletId: string
  walletLabel: string
  walletColor: string
  walletKind: WalletKind
  providerName: string | null
  providerId: string | null
  chainId: number
  chainName: string
  chainColor: string
  tokenKey: string
  address: string
  amount: number
  value: number
  sufficient: boolean
  /** False when the wallet app cannot be reached right now. */
  reachable: boolean
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

export interface AccountApiStatus {
  /** Whether api.goldfelty.com answered its health check just now. */
  reachable: boolean
  url: string
}

export interface PendingConnection {
  /** WalletConnect pairing URI. */
  uri: string
  expiresAt: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }
