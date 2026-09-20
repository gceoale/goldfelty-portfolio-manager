import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, PortfolioSnapshot, Settings, TransferRecord, Wallet } from '../shared/types.ts'
import { DEFAULT_CHAIN_IDS } from '../shared/chains.ts'

export interface StoreData {
  schemaVersion: number
  account: Account | null
  wallets: Wallet[]
  settings: Settings
  history: PortfolioSnapshot[]
  transfers: TransferRecord[]
  /** Last known balances, so the Home tab renders instantly and works offline. */
  balanceCache: Record<string, { raw: string; at: number }>
  priceCache: Record<string, { price: number; change24h: number; at: number }>
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  currency: 'USD',
  autoLockMinutes: 10,
  hideBalances: false,
  confirmBeforeSend: true,
  refreshIntervalSeconds: 60,
  priceProviderUrl: 'https://api.coingecko.com/api/v3',
  customRpc: {},
  enabledChains: [...DEFAULT_CHAIN_IDS],
  telemetry: false
}

const EMPTY: StoreData = {
  schemaVersion: 1,
  account: null,
  wallets: [],
  settings: DEFAULT_SETTINGS,
  history: [],
  transfers: [],
  balanceCache: {},
  priceCache: {}
}

/** Maximum retained portfolio snapshots (~1 year at one per hour). */
const MAX_HISTORY = 9000
const MAX_TRANSFERS = 500

/**
 * Durable, non-secret application state. Deliberately separate from the vault:
 * losing this file costs the user their labels and charts, never their funds.
 */
export class Store {
  private readonly file: string
  private data: StoreData

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'state.json')
    this.data = this.load()
  }

  private load(): StoreData {
    if (!existsSync(this.file)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      return {
        ...structuredClone(EMPTY),
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      }
    } catch {
      // Keep the damaged file around rather than silently discarding state.
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* best effort */
      }
      return structuredClone(EMPTY)
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get raw(): StoreData {
    return this.data
  }

  // ---- account -----------------------------------------------------------
  get account(): Account | null {
    return this.data.account
  }

  setAccount(account: Account | null): void {
    this.data.account = account
    this.persist()
  }

  updateAccount(patch: Partial<Account>): void {
    if (!this.data.account) return
    this.data.account = { ...this.data.account, ...patch }
    this.persist()
  }

  // ---- wallets -----------------------------------------------------------
  get wallets(): Wallet[] {
    return this.data.wallets
  }

  activeWallets(): Wallet[] {
    return this.data.wallets.filter((w) => !w.archived)
  }

  wallet(id: string): Wallet | undefined {
    return this.data.wallets.find((w) => w.id === id)
  }

  addWallet(wallet: Wallet): void {
    this.data.wallets.push(wallet)
    this.persist()
  }

  addWallets(wallets: Wallet[]): void {
    this.data.wallets.push(...wallets)
    this.persist()
  }

  updateWallet(id: string, patch: Partial<Wallet>): Wallet | undefined {
    const index = this.data.wallets.findIndex((w) => w.id === id)
    if (index === -1) return undefined
    this.data.wallets[index] = { ...this.data.wallets[index], ...patch, id }
    this.persist()
    return this.data.wallets[index]
  }

  removeWallet(id: string): void {
    this.data.wallets = this.data.wallets.filter((w) => w.id !== id)
    this.persist()
  }

  /** Highest BIP-44 index in use, so the next wallet never reuses a key. */
  nextDerivationIndex(): number {
    const used = this.data.wallets
      .map((w) => w.derivationIndex)
      .filter((i): i is number => typeof i === 'number')
    return used.length === 0 ? 0 : Math.max(...used) + 1
  }

  // ---- settings ----------------------------------------------------------
  get settings(): Settings {
    return this.data.settings
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.persist()
    return this.data.settings
  }

  // ---- history -----------------------------------------------------------
  get history(): PortfolioSnapshot[] {
    return this.data.history
  }

  pushSnapshot(snapshot: PortfolioSnapshot): void {
    const last = this.data.history[this.data.history.length - 1]
    // One snapshot per 5 minutes is plenty; overwrite within the window so a
    // burst of refreshes does not flatten the chart's time axis.
    if (last && snapshot.at - last.at < 5 * 60_000) {
      this.data.history[this.data.history.length - 1] = snapshot
    } else {
      this.data.history.push(snapshot)
    }
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history = this.data.history.slice(-MAX_HISTORY)
    }
    this.persist()
  }

  // ---- transfers ---------------------------------------------------------
  get transfers(): TransferRecord[] {
    return this.data.transfers
  }

  addTransfer(record: TransferRecord): void {
    this.data.transfers.unshift(record)
    if (this.data.transfers.length > MAX_TRANSFERS) {
      this.data.transfers = this.data.transfers.slice(0, MAX_TRANSFERS)
    }
    this.persist()
  }

  updateTransfer(id: string, patch: Partial<TransferRecord>): void {
    const index = this.data.transfers.findIndex((t) => t.id === id)
    if (index === -1) return
    this.data.transfers[index] = { ...this.data.transfers[index], ...patch }
    this.persist()
  }

  // ---- caches ------------------------------------------------------------
  cachedBalance(walletId: string, tokenKey: string): { raw: string; at: number } | undefined {
    return this.data.balanceCache[`${walletId}|${tokenKey}`]
  }

  cacheBalance(walletId: string, tokenKey: string, raw: string): void {
    this.data.balanceCache[`${walletId}|${tokenKey}`] = { raw, at: Date.now() }
  }

  cachedPrices(): Record<string, { price: number; change24h: number; at: number }> {
    return this.data.priceCache
  }

  cachePrices(prices: Record<string, { price: number; change24h: number }>): void {
    const at = Date.now()
    for (const [id, value] of Object.entries(prices)) {
      this.data.priceCache[id] = { ...value, at }
    }
    this.persist()
  }

  flush(): void {
    this.persist()
  }

  /** Wipe everything on this computer. Used by Settings → Reset. */
  reset(): void {
    this.data = structuredClone(EMPTY)
    this.persist()
  }
}
