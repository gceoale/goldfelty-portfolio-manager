import { BrowserWindow, app, clipboard, ipcMain, shell } from 'electron'
import { Store } from './store.ts'
import { Vault, WeakPasswordError } from './vault.ts'
import { scorePassword } from './crypto.ts'
import {
  connectSmartWallets,
  connectWatchWallet,
  connectExternalWallets,
  detachConnection,
  reconcileWallets,
  recoverWallets,
  MAX_WALLETS
} from './wallets.ts'
import type { WalletConnectService } from './walletconnect.ts'
import type { ExtensionBridge } from './extensionBridge.ts'
import type { ExternalSender } from './transfers.ts'
import { loadPortfolio } from './portfolio.ts'
import { executeTransfer, quoteTransfer, receiveRoutes, routesForSymbol } from './transfers.ts'
import { checkUsername, linkExistingAccount, registerAccount, validateEmail, validateUsername } from './goldfelty.ts'
import { probeChain } from './rpc.ts'
import { clearPriceMemory } from './prices.ts'
import { CHAINS, TOKENS, getChain } from '../shared/chains.ts'
import type { Balance, HistoryRange, Portfolio, Result, Settings, Wallet } from '../shared/types.ts'

/** Wrap a handler so failures cross IPC as data rather than serialized stack traces. */
function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (error) {
      const err = error as Error & { code?: string }
      if (!app.isPackaged) console.error(`[ipc] ${channel}:`, err)
      return { ok: false, error: err.message ?? 'Something went wrong.', code: err.code }
    }
  })
}

export interface Runtime {
  store: Store
  vault: Vault
  /** Latest balances, kept in memory to answer routing questions instantly. */
  lastBalances: Balance[]
  lastPortfolioAt: number
  lastActivity: number
  onboardingTicket: string | null
  walletConnect: WalletConnectService
  bridge: ExtensionBridge
  /** Set when the user confirms the seed backup, before the account exists. */
  backupConfirmed: boolean
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function requireUnlocked(runtime: Runtime): void {
  if (runtime.vault.isLocked) {
    const error = new Error('The vault is locked.') as Error & { code: string }
    error.code = 'LOCKED'
    throw error
  }
}

export function registerIpc(runtime: Runtime): void {
  const { store, vault } = runtime

  const touch = (): void => {
    runtime.lastActivity = Date.now()
  }

  // ---- app ---------------------------------------------------------------
  handle('app:status', () => ({
    initialized: vault.exists() && store.account !== null && store.account.backedUp,
    locked: vault.isLocked,
    account: store.account,
    walletCount: store.activeWallets().length,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }))

  handle('app:touch', () => {
    touch()
    return true
  })

  handle('app:openExternal', async (url: string) => {
    // Only ever hand http(s) to the OS; anything else could launch a local handler.
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Refusing to open a non-web link.')
    }
    await shell.openExternal(parsed.toString())
    return true
  })

  handle('app:copy', (text: string, clearAfterMs?: number) => {
    clipboard.writeText(String(text))
    if (clearAfterMs && clearAfterMs > 0) {
      const snapshot = String(text)
      setTimeout(() => {
        // Only clear if the user has not copied something else since.
        if (clipboard.readText() === snapshot) clipboard.clear()
      }, clearAfterMs)
    }
    return true
  })

  handle('app:reference', () => ({
    chains: CHAINS,
    tokens: TOKENS,
    maxWallets: MAX_WALLETS
  }))

  // ---- onboarding --------------------------------------------------------
  handle('onboarding:scorePassword', (password: string) => scorePassword(String(password ?? '')))

  handle('onboarding:createVault', async (password: string, importMnemonic?: string) => {
    const { recovery, ticket } = await vault.create(String(password), importMnemonic || undefined)
    runtime.onboardingTicket = ticket
    touch()
    return { ticket, recovery }
  })

  handle('onboarding:revealRecovery', (ticket: string) => vault.revealOnce(String(ticket)))

  handle('onboarding:checkUsername', (username: string) => checkUsername(String(username)))

  handle('onboarding:register', async (username: string, email: string) => {
    requireUnlocked(runtime)
    const result = await registerAccount(vault, { username: String(username), email: String(email) })
    // The backup step runs before this one, so carry its confirmation across.
    store.setAccount({ ...result.account, backedUp: runtime.backupConfirmed })
    touch()
    return result
  })

  handle('onboarding:confirmBackup', (ticket: string) => {
    if (!runtime.onboardingTicket || String(ticket) !== runtime.onboardingTicket) {
      throw new Error('That confirmation is no longer valid.')
    }
    // The point of no return: after this the seed can never be displayed again.
    vault.closeReveal()
    runtime.onboardingTicket = null
    runtime.backupConfirmed = true
    store.updateAccount({ backedUp: true })
    return true
  })

  handle('onboarding:finish', (walletCount: number) => {
    requireUnlocked(runtime)
    const count = Math.max(1, Math.min(Number(walletCount) || 1, MAX_WALLETS))
    const created = connectSmartWallets(store, vault, { count })
    touch()
    return created
  })

  handle('onboarding:validateIdentity', (username: string, email: string) => ({
    username: validateUsername(String(username)),
    email: validateEmail(String(email))
  }))

  // ---- vault -------------------------------------------------------------
  handle('vault:unlock', async (password: string) => {
    await vault.unlock(String(password))
    reconcileWallets(store, vault)
    touch()
    broadcast('app:unlocked')
    return true
  })

  handle('vault:lock', () => {
    vault.lock()
    broadcast('app:locked')
    return true
  })

  handle('vault:changePassword', async (current: string, next: string) => {
    const strength = scorePassword(String(next))
    if (strength.score < 2) throw new WeakPasswordError(strength.problems)
    await vault.changePassword(String(current), String(next))
    touch()
    return true
  })

  handle('vault:verify', (password: string) => vault.verify(String(password)))

  // ---- wallets -----------------------------------------------------------
  handle('wallets:list', () => store.wallets)

  handle('wallets:connectSmart', (options: { count?: number; label?: string; chainIds?: number[] }) => {
    requireUnlocked(runtime)
    touch()
    return connectSmartWallets(store, vault, options ?? {})
  })

  handle('wallets:connectWatch', (options: { address: string; label?: string; chainIds?: number[] }) => {
    touch()
    return connectWatchWallet(store, options)
  })

  handle('wallets:update', (id: string, patch: Partial<Wallet>) => {
    touch()
    // Never let the renderer rewrite identity or key material fields.
    const { label, chainIds, color, archived, enabledTokens } = patch
    const safe: Partial<Wallet> = {}
    if (typeof label === 'string' && label.trim()) safe.label = label.trim().slice(0, 48)
    if (Array.isArray(chainIds)) safe.chainIds = chainIds.filter((c) => CHAINS.some((chain) => chain.id === c))
    if (typeof color === 'string') safe.color = color
    if (typeof archived === 'boolean') safe.archived = archived
    if (Array.isArray(enabledTokens)) safe.enabledTokens = enabledTokens
    const updated = store.updateWallet(String(id), safe)
    if (!updated) throw new Error('That wallet no longer exists.')
    return updated
  })

  handle('wallets:remove', (id: string) => {
    touch()
    store.removeWallet(String(id))
    return true
  })

  handle('wallets:recover', (count: number) => {
    requireUnlocked(runtime)
    touch()
    return recoverWallets(store, vault, Number(count) || 1)
  })

  // ---- portfolio ---------------------------------------------------------
  handle('portfolio:load', async (range: HistoryRange = '24h'): Promise<Portfolio> => {
    const portfolio = await loadPortfolio(store, range)
    runtime.lastBalances = portfolio.balances
    runtime.lastPortfolioAt = portfolio.updatedAt
    store.flush()
    return portfolio
  })

  handle('portfolio:transfers', () => store.transfers)

  // ---- send / receive ----------------------------------------------------
  handle('send:symbols', () => {
    const seen = new Map<string, { symbol: string; name: string; color: string; amount: number; value: number; routes: number }>()
    for (const balance of runtime.lastBalances) {
      const token = TOKENS.find((t) => t.key === balance.tokenKey)
      if (!token) continue
      const entry = seen.get(token.symbol) ?? {
        symbol: token.symbol,
        name: token.name,
        color: token.color,
        amount: 0,
        value: 0,
        routes: 0
      }
      const wallet = store.wallet(balance.walletId)
      if (!wallet || wallet.kind === 'watch') continue
      entry.amount += balance.amount
      entry.value += balance.value
      entry.routes += 1
      seen.set(token.symbol, entry)
    }
    return [...seen.values()].sort((a, b) => b.value - a.value)
  })

  handle('send:routes', (symbol: string, amount = 0) =>
    // Everything except watch-only can send: our own smart accounts, and the
    // user's own wallets reached over WalletConnect or the browser bridge.
    routesForSymbol(store, runtime.lastBalances, String(symbol), Number(amount) || 0).filter(
      (route) => route.walletKind !== 'watch'
    )
  )

  handle('send:quote', (input: { walletId: string; tokenKey: string; to: string; amount: string }) => {
    requireUnlocked(runtime)
    touch()
    return quoteTransfer(store, vault, input)
  })

  handle('send:execute', async (input: { walletId: string; tokenKey: string; to: string; amount: string; password: string }) => {
    requireUnlocked(runtime)
    touch()
    const result = await executeTransfer(store, vault, input, externalSender(runtime))
    broadcast('portfolio:invalidate')
    return result
  })

  handle('receive:symbols', () => {
    const wallets = store.activeWallets()
    const chainIds = new Set(wallets.flatMap((w) => w.chainIds))
    const seen = new Map<string, { symbol: string; name: string; color: string; chains: string[]; wallets: number }>()
    for (const token of TOKENS) {
      if (!chainIds.has(token.chainId)) continue
      const entry = seen.get(token.symbol) ?? {
        symbol: token.symbol,
        name: token.name,
        color: token.color,
        chains: [],
        wallets: 0
      }
      const chainName = getChain(token.chainId).name
      if (!entry.chains.includes(chainName)) entry.chains.push(chainName)
      entry.wallets += wallets.filter((w) => w.chainIds.includes(token.chainId)).length
      seen.set(token.symbol, entry)
    }
    return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
  })

  handle('receive:routes', (symbol: string) => receiveRoutes(store, String(symbol)))

  // ---- external wallet connections ---------------------------------------
  handle('connections:list', () => [
    ...runtime.walletConnect.list(),
    ...(runtime.bridge.current ? [runtime.bridge.current] : [])
  ])

  handle('connections:walletConnectConfigured', () => ({
    configured: runtime.walletConnect.configured,
    builtIn: runtime.walletConnect.hasBuiltIn
  }))

  handle('connections:connectWalletConnect', async () => {
    touch()
    runtime.walletConnect.setProjectId(store.settings.walletConnectProjectId)
    const { pending, approved } = await runtime.walletConnect.connect(store.settings.enabledChains)

    // Resolve in the background: the UI shows the QR straight away and is told
    // separately once the user approves in their wallet.
    void approved
      .then((connection) => {
        const created = connectExternalWallets(store, {
          connectionId: connection.id,
          kind: 'walletconnect',
          providerName: connection.name,
          accounts: connection.accounts,
          chainIds: connection.chainIds.length > 0 ? connection.chainIds : store.settings.enabledChains
        })
        broadcast('connections:approved', { connection, wallets: created })
      })
      .catch((error: Error) => broadcast('connections:failed', { message: error.message }))

    return pending
  })

  handle('connections:connectExtension', async () => {
    touch()
    const { url, connected } = await runtime.bridge.start(store.settings.enabledChains)

    void connected
      .then((connection) => {
        const created = connectExternalWallets(store, {
          connectionId: connection.id,
          kind: 'extension',
          providerName: connection.name,
          accounts: connection.accounts,
          chainIds: connection.chainIds.length > 0 ? connection.chainIds : store.settings.enabledChains
        })
        broadcast('connections:approved', { connection, wallets: created })
      })
      .catch((error: Error) => broadcast('connections:failed', { message: error.message }))

    await shell.openExternal(url)
    return { uri: url, bridgeUrl: url, expiresAt: Date.now() + 5 * 60_000 }
  })

  handle('connections:disconnect', async (connectionId: string) => {
    const id = String(connectionId)
    if (runtime.bridge.current?.id === id) await runtime.bridge.disconnect()
    else await runtime.walletConnect.disconnect(id)
    const detached = detachConnection(store, id)
    broadcast('connections:changed')
    return { detached }
  })

  // ---- settings ----------------------------------------------------------
  handle('settings:get', () => store.settings)

  handle('settings:update', (patch: Partial<Settings>) => {
    touch()
    const next = store.updateSettings(patch ?? {})
    if (patch?.currency) clearPriceMemory()
    if (patch?.walletConnectProjectId !== undefined) {
      runtime.walletConnect.setProjectId(next.walletConnectProjectId)
    }
    broadcast('settings:changed', next)
    return next
  })

  handle('settings:probeChain', (chainId: number) => probeChain(Number(chainId), store.settings))

  handle('settings:linkAccount', async () => {
    requireUnlocked(runtime)
    const account = store.account
    if (!account) throw new Error('There is no account to link.')
    const result = await linkExistingAccount(vault, account)
    store.setAccount({ ...result.account, backedUp: account.backedUp })
    return result
  })

  handle('settings:reset', () => {
    // Deliberately leaves the vault file alone — wiping funds access needs a
    // separate, explicit confirmation in the UI.
    store.reset()
    vault.lock()
    broadcast('app:locked')
    return true
  })

  handle('settings:dataPaths', () => ({
    vault: vault.path,
    userData: app.getPath('userData'),
    logs: app.getPath('logs')
  }))
}

/** Route a transfer to whichever transport owns the wallet's keys. */
function externalSender(runtime: Runtime): ExternalSender {
  return {
    async send(wallet, chainId, tx) {
      if (!wallet.connectionId) throw new Error('That wallet is no longer connected.')
      if (wallet.kind === 'extension') {
        return runtime.bridge.request('eth_sendTransaction', [tx])
      }
      return runtime.walletConnect.sendTransaction(wallet.connectionId, chainId, tx)
    }
  }
}

/**
 * Lock the vault after a period without user interaction. The renderer pings
 * `app:touch` on real input, so a window left open on a shared desk locks.
 */
export function startAutoLock(runtime: Runtime): NodeJS.Timeout {
  return setInterval(() => {
    const minutes = runtime.store.settings.autoLockMinutes
    if (minutes <= 0 || runtime.vault.isLocked) return
    // Never lock mid-onboarding; the user still has to record their seed.
    if (runtime.onboardingTicket) return
    if (Date.now() - runtime.lastActivity > minutes * 60_000) {
      runtime.vault.lock()
      broadcast('app:locked')
    }
  }, 15_000)
}
