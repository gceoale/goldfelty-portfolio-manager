import { contextBridge, ipcRenderer } from 'electron'
import type {
  Account,
  AccountApiStatus,
  AppStatus,
  BridgeStatus,
  Chain,
  ConnectStage,
  HistoryRange,
  PendingConnection,
  Portfolio,
  ReceivableAsset,
  Result,
  RouteOption,
  SendableAsset,
  SendQuote,
  SendResult,
  Settings,
  TokenDef,
  TransferRecord,
  Wallet,
  WalletConnection
} from '../shared/types.ts'
import type { RegistryWallet } from '../shared/walletRegistry.ts'

/**
 * The whole surface the renderer can touch. Every call is a named verb; there
 * is no generic invoke, so a compromised renderer cannot reach a channel this
 * file does not list. The main process checks every argument again anyway.
 */

type Unsubscribe = () => void
type Registration = { account: Account; linked: boolean; message?: string }
type Connected = { connection: WalletConnection; wallets: Wallet[] }

const EVENTS = new Set([
  'app:locked',
  'app:unlocked',
  'settings:changed',
  'portfolio:invalidate',
  'connections:changed',
  'connections:progress',
  'connections:approved',
  'connections:failed'
])

function on(channel: string, listener: (payload: unknown) => void): Unsubscribe {
  if (!EVENTS.has(channel)) throw new Error('Unknown event.')
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const call = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> => ipcRenderer.invoke(channel, ...args)

const api = {
  app: {
    status: () => call<AppStatus>('app:status'),
    touch: () => call<boolean>('app:touch'),
    openExternal: (url: string) => call<boolean>('app:openExternal', url),
    copy: (text: string) => call<boolean>('app:copy', text),
    reference: () => call<{ chains: Chain[]; tokens: TokenDef[]; registry: RegistryWallet[]; maxWallets: number }>('app:reference'),
    feeInfo: () => call<{ enabled: boolean; bps: number; recipient: string | null }>('app:feeInfo'),
    dismissUpgradeNotice: () => call<boolean>('app:dismissUpgradeNotice'),
    showBackup: () => call<boolean>('app:showBackup')
  },
  setup: {
    scorePassword: (password: string) => call<{ score: number; label: string; problems: string[] }>('setup:scorePassword', password),
    create: (password: string) => call<AppStatus>('setup:create', password),
    finish: () => call<AppStatus>('setup:finish')
  },
  account: {
    apiStatus: () => call<AccountApiStatus>('account:apiStatus'),
    checkUsername: (username: string) => call<{ available: boolean; offline: boolean; reason?: string }>('account:checkUsername', username),
    validate: (username: string, email: string) => call<{ username: string | null; email: string | null }>('account:validate', username, email),
    register: (input: { username: string; email: string; walletId: string | null }) => call<Registration>('account:register', input),
    link: (walletId: string) => call<Registration>('account:link', walletId),
    forget: () => call<boolean>('account:forget')
  },
  vault: {
    unlock: (password: string) => call<AppStatus>('vault:unlock', password),
    lock: () => call<boolean>('vault:lock'),
    changePassword: (current: string, next: string) => call<boolean>('vault:changePassword', current, next)
  },
  wallets: {
    list: () => call<Wallet[]>('wallets:list'),
    update: (id: string, patch: Partial<Pick<Wallet, 'label' | 'chainIds' | 'color' | 'archived' | 'enabledTokens'>>) =>
      call<Wallet>('wallets:update', id, patch),
    remove: (id: string) => call<boolean>('wallets:remove', id),
    /** Read-only: for wallets like Exodus that can't connect. */
    track: (input: { address: string; label?: string; providerId?: string | null }) => call<Wallet>('wallets:track', input)
  },
  connections: {
    list: () => call<WalletConnection[]>('connections:list'),
    bridge: () => call<BridgeStatus>('connections:bridge'),
    copyBridgeLink: () => call<boolean>('connections:copyBridgeLink'),
    openBridge: () => call<boolean>('connections:openBridge'),
    connectBrowser: (providerId: string) => call<Connected>('connections:connectBrowser', providerId),
    detectFrame: () => call<boolean>('connections:detectFrame'),
    connectFrame: () => call<Connected>('connections:connectFrame'),
    connectWalletConnect: () => call<PendingConnection>('connections:connectWalletConnect'),
    disconnect: (connectionId: string) => call<{ detached: number }>('connections:disconnect', connectionId)
  },
  portfolio: {
    load: (range: HistoryRange) => call<Portfolio>('portfolio:load', range),
    transfers: () => call<TransferRecord[]>('portfolio:transfers')
  },
  send: {
    assets: () => call<SendableAsset[]>('send:assets'),
    routes: (symbol: string, amount?: number) => call<RouteOption[]>('send:routes', symbol, amount),
    quote: (input: { walletId: string; tokenKey: string; to: string; amount: string }) => call<SendQuote>('send:quote', input),
    /** `feeBps` is the rate shown on the review screen; the main process refuses to charge more. */
    execute: (input: { walletId: string; tokenKey: string; to: string; amount: string; feeBps: number }) => call<SendResult>('send:execute', input)
  },
  receive: {
    assets: () => call<ReceivableAsset[]>('receive:assets'),
    routes: (symbol: string) => call<RouteOption[]>('receive:routes', symbol),
    checkAddress: (address: string) => call<boolean>('receive:checkAddress', address)
  },
  settings: {
    get: () => call<Settings>('settings:get'),
    update: (patch: Partial<Settings>) => call<Settings>('settings:update', patch),
    probeChain: (chainId: number) =>
      call<{ ok: boolean; blockNumber?: number; latencyMs?: number; error?: string }>('settings:probeChain', chainId),
    resetData: (password: string) => call<boolean>('settings:resetData', password),
    dataFolder: () => call<boolean>('settings:dataFolder')
  },
  events: {
    onLocked: (fn: () => void): Unsubscribe => on('app:locked', () => fn()),
    onUnlocked: (fn: () => void): Unsubscribe => on('app:unlocked', () => fn()),
    onSettingsChanged: (fn: (settings: Settings) => void): Unsubscribe => on('settings:changed', (p) => fn(p as Settings)),
    onPortfolioInvalidate: (fn: () => void): Unsubscribe => on('portfolio:invalidate', () => fn()),
    onConnectionsChanged: (fn: () => void): Unsubscribe => on('connections:changed', () => fn()),
    onConnectProgress: (fn: (stage: ConnectStage) => void): Unsubscribe => on('connections:progress', (p) => fn(p as ConnectStage)),
    onConnectionApproved: (fn: (payload: Connected) => void): Unsubscribe => on('connections:approved', (p) => fn(p as Connected)),
    onConnectionFailed: (fn: (message: string) => void): Unsubscribe =>
      on('connections:failed', (p) => fn(String((p as { message?: string })?.message ?? 'The connection failed.')))
  }
}

export type GoldfeltyApi = typeof api

contextBridge.exposeInMainWorld('goldfelty', api)
