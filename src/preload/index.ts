import { contextBridge, ipcRenderer } from 'electron'
import type {
  Account,
  AppStatus,
  Chain,
  HistoryRange,
  Portfolio,
  RecoveryMaterial,
  PendingConnection,
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

/**
 * The whole surface the renderer is allowed to touch. Every call is an explicit
 * verb — there is no generic `invoke(channel, ...)` escape hatch, so a
 * compromised renderer cannot reach an IPC channel this file does not name.
 */

type Unsubscribe = () => void

function on(channel: string, listener: (payload: unknown) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  app: {
    status: (): Promise<Result<AppStatus>> => ipcRenderer.invoke('app:status'),
    touch: (): Promise<Result<boolean>> => ipcRenderer.invoke('app:touch'),
    openExternal: (url: string): Promise<Result<boolean>> => ipcRenderer.invoke('app:openExternal', url),
    copy: (text: string, clearAfterMs?: number): Promise<Result<boolean>> =>
      ipcRenderer.invoke('app:copy', text, clearAfterMs),
    reference: (): Promise<Result<{ chains: Chain[]; tokens: TokenDef[]; maxWallets: number }>> =>
      ipcRenderer.invoke('app:reference')
  },
  onboarding: {
    scorePassword: (password: string): Promise<Result<{ score: number; label: string; problems: string[] }>> =>
      ipcRenderer.invoke('onboarding:scorePassword', password),
    createVault: (
      password: string,
      importMnemonic?: string
    ): Promise<Result<{ ticket: string; recovery: RecoveryMaterial }>> =>
      ipcRenderer.invoke('onboarding:createVault', password, importMnemonic),
    revealRecovery: (ticket: string): Promise<Result<RecoveryMaterial>> =>
      ipcRenderer.invoke('onboarding:revealRecovery', ticket),
    checkUsername: (
      username: string
    ): Promise<Result<{ available: boolean; offline: boolean; reason?: string }>> =>
      ipcRenderer.invoke('onboarding:checkUsername', username),
    validateIdentity: (
      username: string,
      email: string
    ): Promise<Result<{ username: string | null; email: string | null }>> =>
      ipcRenderer.invoke('onboarding:validateIdentity', username, email),
    register: (
      username: string,
      email: string
    ): Promise<Result<{ account: Account; linked: boolean; message?: string }>> =>
      ipcRenderer.invoke('onboarding:register', username, email),
    confirmBackup: (ticket: string): Promise<Result<boolean>> =>
      ipcRenderer.invoke('onboarding:confirmBackup', ticket),
    finish: (walletCount: number): Promise<Result<Wallet[]>> => ipcRenderer.invoke('onboarding:finish', walletCount)
  },
  vault: {
    unlock: (password: string): Promise<Result<boolean>> => ipcRenderer.invoke('vault:unlock', password),
    lock: (): Promise<Result<boolean>> => ipcRenderer.invoke('vault:lock'),
    verify: (password: string): Promise<Result<boolean>> => ipcRenderer.invoke('vault:verify', password),
    changePassword: (current: string, next: string): Promise<Result<boolean>> =>
      ipcRenderer.invoke('vault:changePassword', current, next)
  },
  wallets: {
    list: (): Promise<Result<Wallet[]>> => ipcRenderer.invoke('wallets:list'),
    connectSmart: (options: { count?: number; label?: string; chainIds?: number[] }): Promise<Result<Wallet[]>> =>
      ipcRenderer.invoke('wallets:connectSmart', options),
    connectWatch: (options: { address: string; label?: string; chainIds?: number[] }): Promise<Result<Wallet>> =>
      ipcRenderer.invoke('wallets:connectWatch', options),
    update: (id: string, patch: Partial<Wallet>): Promise<Result<Wallet>> =>
      ipcRenderer.invoke('wallets:update', id, patch),
    remove: (id: string): Promise<Result<boolean>> => ipcRenderer.invoke('wallets:remove', id),
    recover: (count: number): Promise<Result<Wallet[]>> => ipcRenderer.invoke('wallets:recover', count)
  },
  portfolio: {
    load: (range: HistoryRange): Promise<Result<Portfolio>> => ipcRenderer.invoke('portfolio:load', range),
    transfers: (): Promise<Result<TransferRecord[]>> => ipcRenderer.invoke('portfolio:transfers')
  },
  send: {
    symbols: (): Promise<Result<SendableAsset[]>> => ipcRenderer.invoke('send:symbols'),
    routes: (symbol: string, amount?: number): Promise<Result<RouteOption[]>> =>
      ipcRenderer.invoke('send:routes', symbol, amount),
    quote: (input: { walletId: string; tokenKey: string; to: string; amount: string }): Promise<Result<SendQuote>> =>
      ipcRenderer.invoke('send:quote', input),
    execute: (input: {
      walletId: string
      tokenKey: string
      to: string
      amount: string
      password: string
    }): Promise<Result<SendResult>> => ipcRenderer.invoke('send:execute', input)
  },
  receive: {
    symbols: (): Promise<Result<ReceivableAsset[]>> => ipcRenderer.invoke('receive:symbols'),
    routes: (symbol: string): Promise<Result<RouteOption[]>> => ipcRenderer.invoke('receive:routes', symbol)
  },
  connections: {
    list: (): Promise<Result<WalletConnection[]>> => ipcRenderer.invoke('connections:list'),
    walletConnectConfigured: (): Promise<Result<boolean>> =>
      ipcRenderer.invoke('connections:walletConnectConfigured'),
    connectWalletConnect: (): Promise<Result<PendingConnection>> =>
      ipcRenderer.invoke('connections:connectWalletConnect'),
    connectExtension: (): Promise<Result<PendingConnection>> =>
      ipcRenderer.invoke('connections:connectExtension'),
    disconnect: (connectionId: string): Promise<Result<{ detached: number }>> =>
      ipcRenderer.invoke('connections:disconnect', connectionId)
  },
  settings: {
    get: (): Promise<Result<Settings>> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<Settings>): Promise<Result<Settings>> => ipcRenderer.invoke('settings:update', patch),
    probeChain: (
      chainId: number
    ): Promise<Result<{ ok: boolean; blockNumber?: number; latencyMs?: number; error?: string }>> =>
      ipcRenderer.invoke('settings:probeChain', chainId),
    linkAccount: (): Promise<Result<{ account: Account; linked: boolean; message?: string }>> =>
      ipcRenderer.invoke('settings:linkAccount'),
    reset: (): Promise<Result<boolean>> => ipcRenderer.invoke('settings:reset'),
    dataPaths: (): Promise<Result<{ vault: string; userData: string; logs: string }>> =>
      ipcRenderer.invoke('settings:dataPaths')
  },
  events: {
    onLocked: (fn: () => void): Unsubscribe => on('app:locked', () => fn()),
    onUnlocked: (fn: () => void): Unsubscribe => on('app:unlocked', () => fn()),
    onSettingsChanged: (fn: (settings: Settings) => void): Unsubscribe =>
      on('settings:changed', (payload) => fn(payload as Settings)),
    onPortfolioInvalidate: (fn: () => void): Unsubscribe => on('portfolio:invalidate', () => fn()),
    onConnectionsChanged: (fn: () => void): Unsubscribe => on('connections:changed', () => fn()),
    onConnectionApproved: (
      fn: (payload: { connection: WalletConnection; wallets: Wallet[] }) => void
    ): Unsubscribe =>
      on('connections:approved', (payload) =>
        fn(payload as { connection: WalletConnection; wallets: Wallet[] })
      ),
    onConnectionFailed: (fn: (message: string) => void): Unsubscribe =>
      on('connections:failed', (payload) => fn((payload as { message: string }).message))
  }
}

export type GoldfeltyApi = typeof api

contextBridge.exposeInMainWorld('goldfelty', api)
