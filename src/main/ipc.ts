import { BrowserWindow, app, clipboard, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import type { Store } from './store.ts'
import type { Prefs } from './prefs.ts'
import { Vault, WeakPasswordError } from './vault.ts'
import { scorePassword, MIN_PASSWORD_SCORE, WrongPasswordError } from './crypto.ts'
import { detectAddress } from './addresses.ts'
import { MAX_WALLETS, detachConnection, registerConnectionAccounts, trackAddress } from './wallets.ts'
import { loadPortfolio } from './portfolio.ts'
import { executeTransfer, quoteTransfer, receiveRoutes, routesForSymbol, type Sender } from './transfers.ts'
import {
  apiStatus,
  checkUsername,
  localAccount,
  registerAccount,
  reportTotals,
  withdrawTotals,
  validateEmail,
  validateUsername,
  type AccountSigner
} from './goldfelty.ts'
import { probeChain } from './rpc.ts'
import { currentFeeBps, feeRecipient, feesEnabled } from './fees.ts'
import { clearPriceMemory } from './prices.ts'
import type { ConnectionManager, ConnectStage } from './connections/index.ts'
import { CHAINS, TOKENS, TOKEN_BY_KEY, getChain } from '../shared/chains.ts'
import { WALLET_REGISTRY } from '../shared/walletRegistry.ts'
import { canSign } from '../shared/types.ts'
import type { AppStatus, Balance, HistoryRange, Portfolio, Result, Wallet, WalletConnection } from '../shared/types.ts'

/**
 * Every request the renderer can make, and the checks in front of each.
 *
 * The renderer is treated as untrusted input: requests are only accepted
 * from the app's own main frame, every argument is type-checked and bounded
 * here, and nothing the renderer sends can name a file, a URL to fetch, or
 * a method to call on a wallet.
 */

export interface Runtime {
  store: Store
  vault: Vault
  prefs: Prefs
  connections: ConnectionManager
  /** The window allowed to talk to the main process. */
  window: () => BrowserWindow | null
  /** The URL the renderer is loaded from; anything else is refused. */
  rendererUrl: string
  lastBalances: Balance[]
  lastActivity: number
}

class InputError extends Error {
  code = 'BAD_INPUT'
}

class LockedError extends Error {
  code = 'LOCKED'
  constructor() {
    super('Goldfelty is locked.')
  }
}

class ThrottledError extends Error {
  code = 'THROTTLED'
  readonly retryAt: number
  constructor(retryAt: number) {
    const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
    super(`Too many wrong passwords. Try again in ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`)
    this.retryAt = retryAt
  }
}

// ---- input helpers --------------------------------------------------------

function str(value: unknown, max: number, name = 'value'): string {
  if (typeof value !== 'string') throw new InputError(`Expected text for ${name}.`)
  if (value.length > max) throw new InputError(`That ${name} is too long.`)
  return value
}

function id(value: unknown): string {
  const s = str(value, 128, 'id')
  if (!/^[\w:.-]+$/.test(s)) throw new InputError('Unknown id.')
  return s
}

function chainId(value: unknown): number {
  const n = Number(value)
  if (!CHAINS.some((c) => c.id === n)) throw new InputError('Unknown network.')
  return n
}

function transferInput(value: unknown): { walletId: string; tokenKey: string; to: string; amount: string; feeBps: number } {
  const v = (value ?? {}) as Record<string, unknown>
  const tokenKey = str(v.tokenKey, 80, 'token')
  if (!TOKEN_BY_KEY.has(tokenKey)) throw new InputError('Unknown token.')
  return {
    walletId: id(v.walletId),
    tokenKey,
    to: str(v.to, 64, 'address').trim(),
    amount: str(v.amount, 80, 'amount').trim(),
    feeBps: Number(v.feeBps ?? 0)
  }
}

const RANGES = new Set<HistoryRange>(['24h', '7d', '30d', '1y', 'all'])

// ---- plumbing -------------------------------------------------------------

export function broadcast(runtime: Runtime, channel: string, payload?: unknown): void {
  const win = runtime.window()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Only the app's own top-level page may call in. A frame, a second window,
 * or a page that navigated somewhere else gets nothing.
 */
function trusted(runtime: Runtime, event: IpcMainInvokeEvent): boolean {
  const win = runtime.window()
  if (!win || event.sender !== win.webContents) return false
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  return frame.url.startsWith(runtime.rendererUrl)
}

function makeHandle(runtime: Runtime) {
  return function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
    ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
      if (!trusted(runtime, event)) return { ok: false, error: 'Not allowed.', code: 'FORBIDDEN' }
      try {
        return { ok: true, data: await fn(...args) }
      } catch (error) {
        const err = error as Error & { code?: string | number }
        if (!app.isPackaged) console.error(`[ipc] ${channel}:`, err)
        // Messages are ours or a wallet's; never a stack, never a path.
        const message = typeof err.message === 'string' ? err.message.slice(0, 400) : 'Something went wrong.'
        return { ok: false, error: message, code: err.code === undefined ? undefined : String(err.code) }
      }
    })
  }
}

export function lockApp(runtime: Runtime): void {
  runtime.connections.attach(null)
  runtime.store.close()
  runtime.vault.lock()
  runtime.lastBalances = []
  broadcast(runtime, 'app:locked')
}

function requireUnlocked(runtime: Runtime): void {
  if (runtime.vault.isLocked || !runtime.store.isOpen) throw new LockedError()
}

/** Run a password check under the same throttle as the lock screen. */
async function withPasswordThrottle<T>(runtime: Runtime, fn: () => Promise<T>): Promise<T> {
  const retryAt = runtime.prefs.unlockRetryAt()
  if (retryAt) throw new ThrottledError(retryAt)
  try {
    const result = await fn()
    runtime.prefs.recordSuccessfulUnlock()
    return result
  } catch (error) {
    if (error instanceof WrongPasswordError) {
      const next = runtime.prefs.recordFailedUnlock()
      if (next) throw new ThrottledError(next)
    }
    throw error
  }
}

function status(runtime: Runtime): AppStatus {
  const { vault, store, prefs } = runtime
  const open = !vault.isLocked && store.isOpen
  return {
    initialized: vault.exists(),
    onboarded: prefs.onboarded,
    locked: !open,
    unlockRetryAt: prefs.unlockRetryAt(),
    account: open ? store.account : null,
    greetingName: prefs.greetingName,
    theme: prefs.theme,
    walletCount: open ? store.activeWallets().length : 0,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    upgradeNotice: prefs.upgradeNotice
  }
}

/** What the renderer may see of a registration: never the token. */
function publicResult(result: { account: unknown; linked: boolean; message?: string }): { account: unknown; linked: boolean; message?: string } {
  return { account: result.account, linked: result.linked, message: result.message }
}

const REPORT_EVERY_MS = 6 * 3600_000

/** Share the total, if the user turned that on, at most every six hours. */
function maybeReport(runtime: Runtime, total: number): void {
  const { store } = runtime
  const token = store.accountToken
  if (!store.settings.shareTotals || !token || !store.account?.linked) return
  if (Date.now() - store.lastReportAt < REPORT_EVERY_MS) return
  store.markReported(Date.now())
  const wallets = store.activeWallets().filter((w) => canSign(w.kind)).length
  void reportTotals(token, { value: total, currency: store.settings.currency, wallets }).catch(() => {
    // Try again at the next refresh rather than in six hours.
    if (store.isOpen) store.markReported(0)
  })
}

/** A signer backed by one of the user's connected wallets. */
function signerFor(runtime: Runtime, walletId: string): AccountSigner {
  const wallet = runtime.store.wallet(walletId)
  if (!wallet || !canSign(wallet.kind) || !wallet.connectionId) {
    throw new InputError('Choose a connected wallet to sign with.')
  }
  const connectionId = wallet.connectionId
  return {
    address: wallet.address,
    name: wallet.providerName ?? wallet.label,
    sign: (message) => runtime.connections.signMessage(connectionId, wallet.address, message)
  }
}

function afterConnect(runtime: Runtime, connection: WalletConnection): Wallet[] {
  const wallets = registerConnectionAccounts(runtime.store, connection, runtime.store.settings.enabledChains)
  broadcast(runtime, 'connections:changed')
  broadcast(runtime, 'portfolio:invalidate')
  return wallets
}

export function registerIpc(runtime: Runtime): void {
  const { store, vault, prefs, connections } = runtime
  const handle = makeHandle(runtime)
  const touch = (): void => {
    runtime.lastActivity = Date.now()
  }

  const sender: Sender = {
    isReachable: (connectionId) => {
      const c = store.isOpen ? store.connection(connectionId) : undefined
      return !!c && connections.isActive(c)
    },
    sendTransaction: (connectionId, chain, tx) => connections.sendTransaction(connectionId, chain, tx),
    signPsbt: (connectionId, psbtHex, inputs, address) => connections.signPsbt(connectionId, psbtHex, inputs, address),
    signSolana: (connectionId, address, txBase64) => connections.signSolana(connectionId, address, txBase64),
    signTron: (connectionId, tx) => connections.signTron(connectionId, tx)
  }

  // ---- app ---------------------------------------------------------------
  handle('app:status', () => status(runtime))

  handle('app:touch', () => {
    touch()
    return true
  })

  handle('app:openExternal', async (raw) => {
    const url = new URL(str(raw, 2048, 'link'))
    // Web pages over https only. Anything else could start a local handler.
    if (url.protocol !== 'https:' || url.username || url.password) throw new InputError('Only https links can be opened.')
    await shell.openExternal(url.toString())
    return true
  })

  handle('app:copy', (text) => {
    // Addresses and short links only; this is not a general clipboard.
    clipboard.writeText(str(text, 200, 'text'))
    return true
  })

  handle('app:reference', () => ({ chains: CHAINS, tokens: TOKENS, registry: WALLET_REGISTRY, maxWallets: MAX_WALLETS }))

  // For Settings and the send screen: whether this build charges a fee, and the rate now.
  handle('app:feeInfo', async () => ({
    enabled: feesEnabled(),
    bps: currentFeeBps(),
    recipient: feeRecipient(),
    recipients: { evm: feeRecipient('evm'), utxo: feeRecipient('utxo'), solana: feeRecipient('solana'), tron: feeRecipient('tron') }
  }))

  handle('app:dismissUpgradeNotice', () => {
    prefs.setUpgradeNotice(null)
    return true
  })

  handle('app:showBackup', () => {
    const notice = prefs.upgradeNotice
    if (notice) shell.showItemInFolder(notice.backupPath)
    return true
  })

  // ---- setup -------------------------------------------------------------
  handle('setup:scorePassword', (password) => scorePassword(str(password, 1024, 'password')))

  handle('setup:create', async (password) => {
    const pw = str(password, 1024, 'password')
    await vault.create(pw)
    store.open(vault.key())
    connections.attach(store)
    touch()
    return status(runtime)
  })

  handle('setup:finish', () => {
    requireUnlocked(runtime)
    prefs.finishOnboarding(store.account?.username ?? null)
    return status(runtime)
  })

  // ---- account (goldfelty.com) -------------------------------------------
  handle('account:apiStatus', () => apiStatus())

  handle('account:checkUsername', (username) => checkUsername(str(username, 64, 'username')))

  handle('account:validate', (username, email) => ({
    username: validateUsername(str(username, 64, 'username')),
    email: validateEmail(str(email, 254, 'email'))
  }))

  handle('account:register', async (input) => {
    requireUnlocked(runtime)
    touch()
    const v = (input ?? {}) as Record<string, unknown>
    const username = str(v.username, 64, 'username')
    const email = str(v.email, 254, 'email')
    const usernameProblem = validateUsername(username)
    if (usernameProblem) throw new InputError(usernameProblem)
    const emailProblem = validateEmail(email)
    if (emailProblem) throw new InputError(emailProblem)

    // No wallet to sign with: keep the account here until one is connected.
    if (v.walletId === null || v.walletId === undefined) {
      const local = localAccount({ username, email })
      const account = store.account && !store.account.linked ? { ...store.account, username: local.username, email: local.email } : local
      store.setAccount(account)
      prefs.setGreetingName(account.username)
      return { account, linked: false, message: 'Saved on this computer. Link it to goldfelty.com from Settings once a wallet is connected.' }
    }

    const result = await registerAccount({ username, email }, signerFor(runtime, id(v.walletId)), store.account)
    store.setAccount(result.account)
    if (result.token) store.setAccountToken(result.token)
    prefs.setGreetingName(result.account.username)
    return publicResult(result)
  })

  handle('account:link', async (walletId) => {
    requireUnlocked(runtime)
    touch()
    const account = store.account
    if (!account) throw new InputError('There’s no account to link.')
    if (account.linked) return { account, linked: true }
    const result = await registerAccount({ username: account.username, email: account.email }, signerFor(runtime, id(walletId)), account)
    store.setAccount(result.account)
    if (result.token) store.setAccountToken(result.token)
    prefs.setGreetingName(result.account.username)
    return publicResult(result)
  })

  handle('account:forget', () => {
    requireUnlocked(runtime)
    const token = store.accountToken
    if (token) void withdrawTotals(token).catch(() => undefined)
    store.setAccount(null)
    prefs.setGreetingName(null)
    return true
  })

  // ---- lock --------------------------------------------------------------
  handle('vault:unlock', async (password) => {
    const pw = str(password, 1024, 'password')
    const result = await withPasswordThrottle(runtime, () => vault.unlock(pw))
    let report
    try {
      report = store.open(vault.key())
    } catch (error) {
      vault.lock()
      throw error
    }
    if (result.migratedFromV1 || (report && report.createdAddresses.length > 0)) {
      prefs.setUpgradeNotice({ createdAddresses: report?.createdAddresses ?? [], backupPath: result.backupPath ?? vault.backupPath })
    }
    connections.walletConnect.setProjectId(store.settings.walletConnectProjectId)
    connections.attach(store)
    void connections.walletConnect.resume()
    touch()
    broadcast(runtime, 'app:unlocked')
    return status(runtime)
  })

  handle('vault:lock', () => {
    lockApp(runtime)
    return true
  })

  handle('vault:changePassword', async (current, next) => {
    requireUnlocked(runtime)
    const nextPw = str(next, 1024, 'password')
    const strength = scorePassword(nextPw)
    if (strength.score < MIN_PASSWORD_SCORE) throw new WeakPasswordError(strength.problems)
    await withPasswordThrottle(runtime, () => vault.changePassword(str(current, 1024, 'password'), nextPw))
    touch()
    return true
  })

  // ---- wallets -----------------------------------------------------------
  handle('wallets:list', () => {
    requireUnlocked(runtime)
    return store.wallets
  })

  handle('wallets:update', (walletId, patch) => {
    requireUnlocked(runtime)
    touch()
    const p = (patch ?? {}) as Record<string, unknown>
    // Only presentation fields. Address, kind and connection are never the renderer's to set.
    const safe: Partial<Wallet> = {}
    if (typeof p.label === 'string' && p.label.trim()) safe.label = p.label.trim().slice(0, 48)
    if (Array.isArray(p.chainIds)) {
      const family = store.wallet(id(walletId))?.family ?? 'evm'
      // Only networks of the wallet's own kind: a Bitcoin address means nothing on Ethereum.
      const ids = [...new Set(p.chainIds.map(Number).filter((c) => CHAINS.some((chain) => chain.id === c && chain.family === family)))]
      if (ids.length) safe.chainIds = ids
    }
    if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) safe.color = p.color
    if (typeof p.archived === 'boolean') safe.archived = p.archived
    if (Array.isArray(p.enabledTokens)) safe.enabledTokens = p.enabledTokens.filter((k): k is string => typeof k === 'string' && TOKEN_BY_KEY.has(k))
    const updated = store.updateWallet(id(walletId), safe)
    if (!updated) throw new InputError('That wallet no longer exists.')
    broadcast(runtime, 'portfolio:invalidate')
    return updated
  })

  handle('wallets:track', (input) => {
    requireUnlocked(runtime)
    touch()
    const v = (input ?? {}) as Record<string, unknown>
    const wallet = trackAddress(
      store,
      {
        address: str(v.address, 64, 'address'),
        label: v.label === undefined ? undefined : str(v.label, 48, 'name'),
        providerId: v.providerId == null ? null : str(v.providerId, 64, 'wallet')
      },
      store.settings.enabledChains
    )
    broadcast(runtime, 'portfolio:invalidate')
    return wallet
  })

  handle('wallets:remove', (walletId) => {
    requireUnlocked(runtime)
    touch()
    store.removeWallet(id(walletId))
    broadcast(runtime, 'portfolio:invalidate')
    return true
  })

  // ---- connections -------------------------------------------------------
  handle('connections:list', () => {
    requireUnlocked(runtime)
    return connections.list()
  })

  handle('connections:bridge', () => connections.bridge.status())

  handle('connections:copyBridgeLink', async () => {
    requireUnlocked(runtime)
    // Straight to the clipboard: the one-time link never passes through the renderer.
    clipboard.writeText(await connections.bridgeLink())
    return true
  })

  handle('connections:openBridge', async () => {
    requireUnlocked(runtime)
    await shell.openExternal(await connections.bridgeLink())
    return true
  })

  handle('connections:connectBrowser', async (providerId) => {
    requireUnlocked(runtime)
    touch()
    const progress = (stage: ConnectStage): void => broadcast(runtime, 'connections:progress', stage)
    const list = await connections.connectBrowser(str(providerId, 120, 'wallet'), progress)
    const wallets = list.flatMap((connection) => afterConnect(runtime, connection))
    return { connection: list[0], connections: list, wallets }
  })

  handle('connections:detectFrame', () => connections.detectFrame())

  handle('connections:connectFrame', async () => {
    requireUnlocked(runtime)
    touch()
    const progress = (stage: ConnectStage): void => broadcast(runtime, 'connections:progress', stage)
    const connection = await connections.connectFrame(progress)
    return { connection, wallets: afterConnect(runtime, connection) }
  })

  handle('connections:connectWalletConnect', async () => {
    requireUnlocked(runtime)
    touch()
    connections.walletConnect.setProjectId(store.settings.walletConnectProjectId)
    const { pending, approved } = await connections.connectWalletConnect(store.settings.enabledChains)
    void approved.then(
      (connection) => {
        if (!store.isOpen) return
        broadcast(runtime, 'connections:approved', { connection, wallets: afterConnect(runtime, connection) })
      },
      (error: Error) => broadcast(runtime, 'connections:failed', { message: error.message })
    )
    return pending
  })

  handle('connections:disconnect', async (connectionId) => {
    requireUnlocked(runtime)
    const cid = id(connectionId)
    await connections.disconnect(cid)
    const detached = detachConnection(store, cid)
    broadcast(runtime, 'connections:changed')
    return { detached }
  })

  // ---- portfolio ---------------------------------------------------------
  handle('portfolio:load', async (range): Promise<Portfolio> => {
    requireUnlocked(runtime)
    const r = RANGES.has(range as HistoryRange) ? (range as HistoryRange) : '24h'
    const portfolio = await loadPortfolio(store, r)
    runtime.lastBalances = portfolio.balances
    store.flush()
    if (!portfolio.degraded) maybeReport(runtime, portfolio.total)
    return portfolio
  })

  handle('portfolio:transfers', () => {
    requireUnlocked(runtime)
    return store.transfers
  })

  // ---- send / receive ----------------------------------------------------
  handle('send:assets', () => {
    requireUnlocked(runtime)
    const seen = new Map<string, { symbol: string; name: string; color: string; amount: number; value: number; routes: number }>()
    for (const balance of runtime.lastBalances) {
      const token = TOKEN_BY_KEY.get(balance.tokenKey)
      const wallet = store.wallet(balance.walletId)
      if (!token || !wallet || wallet.archived || !canSign(wallet.kind)) continue
      const entry = seen.get(token.symbol) ?? { symbol: token.symbol, name: token.name, color: token.color, amount: 0, value: 0, routes: 0 }
      entry.amount += balance.amount
      entry.value += balance.value
      entry.routes += 1
      seen.set(token.symbol, entry)
    }
    return [...seen.values()].sort((a, b) => b.value - a.value)
  })

  handle('send:routes', async (symbol, amount) => {
    requireUnlocked(runtime)
    // Include the fee, so a wallet that can cover the amount but not the fee isn't shown as enough.
    const bps = currentFeeBps()
    return routesForSymbol(store, sender, runtime.lastBalances, str(symbol, 16, 'symbol'), (Number(amount) || 0) * (1 + bps / 10_000))
  })

  handle('send:quote', (input) => {
    requireUnlocked(runtime)
    touch()
    return quoteTransfer(store, store.settings, transferInput(input))
  })

  handle('send:execute', async (input) => {
    requireUnlocked(runtime)
    touch()
    const result = await executeTransfer(store, store.settings, sender, transferInput(input))
    broadcast(runtime, 'portfolio:invalidate')
    return result
  })

  handle('receive:assets', () => {
    requireUnlocked(runtime)
    const wallets = store.activeWallets().filter((w) => canSign(w.kind))
    const chainIds = new Set(wallets.flatMap((w) => w.chainIds))
    const seen = new Map<string, { symbol: string; name: string; color: string; chains: string[]; wallets: number }>()
    for (const token of TOKENS) {
      if (!chainIds.has(token.chainId)) continue
      const entry = seen.get(token.symbol) ?? { symbol: token.symbol, name: token.name, color: token.color, chains: [], wallets: 0 }
      const chainName = getChain(token.chainId).name
      if (!entry.chains.includes(chainName)) entry.chains.push(chainName)
      entry.wallets = new Set([...wallets.filter((w) => w.chainIds.includes(token.chainId)).map((w) => w.id)]).size
      seen.set(token.symbol, entry)
    }
    return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
  })

  handle('receive:routes', (symbol) => {
    requireUnlocked(runtime)
    return receiveRoutes(store, sender, str(symbol, 16, 'symbol'))
  })

  handle('receive:checkAddress', (address) => {
    // Lets the UI confirm an address it is about to show belongs to a wallet here.
    const a = str(address, 128, 'address')
    try {
      return !!store.walletByAddress(detectAddress(a).address)
    } catch {
      return false
    }
  })

  // ---- settings ----------------------------------------------------------
  handle('settings:get', () => {
    requireUnlocked(runtime)
    return store.settings
  })

  handle('settings:update', (patch) => {
    requireUnlocked(runtime)
    touch()
    const before = store.settings
    const next = store.updateSettings(patch)
    if (next.theme !== before.theme) {
      prefs.setTheme(next.theme)
      nativeTheme.themeSource = next.theme
    }
    if (next.currency !== before.currency) clearPriceMemory()
    if (before.shareTotals && !next.shareTotals && store.accountToken) {
      // Turning sharing off deletes what goldfelty.com holds, not just future reports.
      void withdrawTotals(store.accountToken).catch(() => undefined)
    }
    if (!before.shareTotals && next.shareTotals) store.markReported(0)
    if (next.walletConnectProjectId !== before.walletConnectProjectId) {
      connections.walletConnect.setProjectId(next.walletConnectProjectId)
    }
    broadcast(runtime, 'settings:changed', next)
    return next
  })

  handle('settings:probeChain', (chain) => {
    requireUnlocked(runtime)
    return probeChain(chainId(chain), store.settings)
  })

  handle('settings:resetData', async (password) => {
    requireUnlocked(runtime)
    const pw = str(password, 1024, 'password')
    const ok = await withPasswordThrottle(runtime, async () => {
      if (!(await vault.verify(pw))) throw new WrongPasswordError()
      return true
    })
    if (!ok) return false
    for (const c of connections.list()) await connections.disconnect(c.id)
    store.reset()
    runtime.lastBalances = []
    broadcast(runtime, 'connections:changed')
    broadcast(runtime, 'portfolio:invalidate')
    return true
  })

  handle('settings:dataFolder', () => {
    shell.showItemInFolder(vault.path)
    return true
  })
}

/**
 * Lock after a period without input. The renderer pings `app:touch` on real
 * input, so a window left open on a shared desk locks itself.
 */
export function startAutoLock(runtime: Runtime): NodeJS.Timeout {
  return setInterval(() => {
    if (runtime.vault.isLocked || !runtime.store.isOpen) return
    const minutes = Math.max(1, runtime.store.settings.autoLockMinutes)
    if (Date.now() - runtime.lastActivity > minutes * 60_000) lockApp(runtime)
  }, 15_000)
}
