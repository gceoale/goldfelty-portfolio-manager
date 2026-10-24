import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { seal, unseal, type SealedBlob } from './crypto.ts'
import { matchRegistry } from '../shared/walletRegistry.ts'
import { DEFAULT_SETTINGS, applySettingsPatch, normaliseSettings } from './settings.ts'
import type {
  Account,
  Settings,
  PortfolioSnapshot,
  TransferRecord,
  Wallet,
  WalletConnection,
  WalletKind
} from '../shared/types.ts'

/**
 * Everything Goldfelty knows about your wallets, encrypted at rest.
 *
 * It is opened with the data key the vault releases on unlock and closed
 * again on lock, at which point the decrypted copy is dropped from memory.
 * Losing this file costs labels, history and the list of connected wallets;
 * it never costs funds, because no keys live here.
 */

export interface StoreData {
  schemaVersion: 2
  settings: Settings
  account: Account | null
  /** goldfelty.com reporting token. Main process only; never sent to the renderer. */
  accountToken: string | null
  lastReportAt: number
  wallets: Wallet[]
  connections: WalletConnection[]
  history: PortfolioSnapshot[]
  transfers: TransferRecord[]
  balanceCache: Record<string, { raw: string; at: number }>
  priceCache: Record<string, { price: number; change24h: number; at: number }>
}

const empty = (): StoreData => ({
  schemaVersion: 2,
  settings: { ...DEFAULT_SETTINGS, customRpc: {}, enabledChains: [...DEFAULT_SETTINGS.enabledChains] },
  account: null,
  accountToken: null,
  lastReportAt: 0,
  wallets: [],
  connections: [],
  history: [],
  transfers: [],
  balanceCache: {},
  priceCache: {}
})

/** Roughly a year of hourly points. */
const MAX_HISTORY = 9000
const MAX_TRANSFERS = 500

export class StoreClosedError extends Error {
  code = 'LOCKED'
  constructor() {
    super('Goldfelty is locked.')
  }
}

export interface MigrationReport {
  /** Addresses version 1 created for the user; now read-only. */
  createdAddresses: string[]
}

/** The version 1 wallet shape, for reading old state files only. */
interface LegacyWallet {
  id: string
  label: string
  kind: 'smart' | 'watch' | 'walletconnect' | 'extension'
  address: string
  chainIds?: number[]
  enabledTokens?: string[]
  color?: string
  createdAt?: number
  archived?: boolean
  providerName?: string | null
}

interface LegacyState {
  settings?: Record<string, unknown>
  account?: (Omit<Account, 'address'> & { backedUp?: boolean }) | null
  wallets?: LegacyWallet[]
  history?: PortfolioSnapshot[]
  transfers?: TransferRecord[]
  balanceCache?: StoreData['balanceCache']
  priceCache?: StoreData['priceCache']
}

export class Store {
  private readonly file: string
  private readonly legacyFile: string
  private key: Buffer | null = null
  private data: StoreData | null = null

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'state.enc')
    this.legacyFile = join(dataDir, 'state.json')
  }

  get isOpen(): boolean {
    return this.data !== null
  }

  /**
   * Open the store with the vault's data key. On the first unlock after an
   * upgrade this also converts the old plaintext state file and removes it,
   * since leaving it would defeat the point of encrypting anything.
   */
  open(key: Buffer): MigrationReport | null {
    this.key = key
    if (existsSync(this.file)) {
      const blob = JSON.parse(readFileSync(this.file, 'utf8')) as SealedBlob
      const stored = JSON.parse(unseal(key, blob)) as Partial<StoreData>
      this.data = {
        ...empty(),
        ...stored,
        // Re-validated on every open, in case an older build wrote looser values.
        settings: normaliseSettings(stored.settings)
      }
      return null
    }

    if (existsSync(this.legacyFile)) {
      const legacy = JSON.parse(readFileSync(this.legacyFile, 'utf8')) as LegacyState
      const { data, report } = migrateLegacy(legacy)
      this.data = data
      this.persist()
      rmSync(this.legacyFile, { force: true })
      return report
    }

    this.data = empty()
    this.persist()
    return null
  }

  /** Flush and forget. After this, nothing decrypted remains in this object. */
  close(): void {
    if (this.data && this.key) this.persist()
    this.data = null
    this.key = null
  }

  private get d(): StoreData {
    if (!this.data) throw new StoreClosedError()
    return this.data
  }

  private persist(): void {
    if (!this.data || !this.key) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(seal(this.key, JSON.stringify(this.data))), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  flush(): void {
    this.persist()
  }

  // ---- settings ----------------------------------------------------------
  get settings(): Settings {
    return this.d.settings
  }

  /** Validated in settings.ts; throws SettingsError on a value it refuses. */
  updateSettings(patch: unknown): Settings {
    this.d.settings = applySettingsPatch(this.d.settings, patch)
    this.persist()
    return this.d.settings
  }

  // ---- account -----------------------------------------------------------
  get account(): Account | null {
    return this.d.account
  }

  setAccount(account: Account | null): void {
    this.d.account = account
    if (!account) this.d.accountToken = null
    this.persist()
  }

  get accountToken(): string | null {
    return this.d.accountToken
  }

  setAccountToken(token: string | null): void {
    this.d.accountToken = token
    this.d.lastReportAt = 0
    this.persist()
  }

  get lastReportAt(): number {
    return this.d.lastReportAt
  }

  markReported(at: number): void {
    this.d.lastReportAt = at
    this.persist()
  }

  // ---- wallets -----------------------------------------------------------
  get wallets(): Wallet[] {
    return this.d.wallets
  }

  activeWallets(): Wallet[] {
    return this.d.wallets.filter((w) => !w.archived)
  }

  wallet(id: string): Wallet | undefined {
    return this.d.wallets.find((w) => w.id === id)
  }

  walletByAddress(address: string): Wallet | undefined {
    const a = address.toLowerCase()
    return this.d.wallets.find((w) => w.address.toLowerCase() === a)
  }

  addWallet(wallet: Wallet): void {
    this.d.wallets.push(wallet)
    this.persist()
  }

  updateWallet(id: string, patch: Partial<Wallet>): Wallet | undefined {
    const index = this.d.wallets.findIndex((w) => w.id === id)
    if (index === -1) return undefined
    this.d.wallets[index] = { ...this.d.wallets[index], ...patch, id }
    this.persist()
    return this.d.wallets[index]
  }

  removeWallet(id: string): void {
    this.d.wallets = this.d.wallets.filter((w) => w.id !== id)
    this.persist()
  }

  // ---- connections -------------------------------------------------------
  get connections(): WalletConnection[] {
    return this.d.connections
  }

  connection(id: string): WalletConnection | undefined {
    return this.d.connections.find((c) => c.id === id)
  }

  upsertConnection(connection: WalletConnection): void {
    const index = this.d.connections.findIndex((c) => c.id === connection.id)
    if (index === -1) this.d.connections.push(connection)
    else this.d.connections[index] = connection
    this.persist()
  }

  removeConnection(id: string): void {
    this.d.connections = this.d.connections.filter((c) => c.id !== id)
    this.persist()
  }

  // ---- history -----------------------------------------------------------
  get history(): PortfolioSnapshot[] {
    return this.d.history
  }

  pushSnapshot(snapshot: PortfolioSnapshot): void {
    const history = this.d.history
    const last = history[history.length - 1]
    // One point per five minutes; a burst of refreshes overwrites rather than
    // crowding the time axis.
    if (last && snapshot.at - last.at < 5 * 60_000) history[history.length - 1] = snapshot
    else history.push(snapshot)
    if (history.length > MAX_HISTORY) this.d.history = history.slice(-MAX_HISTORY)
    this.persist()
  }

  // ---- transfers ---------------------------------------------------------
  get transfers(): TransferRecord[] {
    return this.d.transfers
  }

  addTransfer(record: TransferRecord): void {
    this.d.transfers.unshift(record)
    if (this.d.transfers.length > MAX_TRANSFERS) this.d.transfers = this.d.transfers.slice(0, MAX_TRANSFERS)
    this.persist()
  }

  updateTransfer(id: string, patch: Partial<TransferRecord>): void {
    const index = this.d.transfers.findIndex((t) => t.id === id)
    if (index === -1) return
    this.d.transfers[index] = { ...this.d.transfers[index], ...patch }
    this.persist()
  }

  // ---- caches ------------------------------------------------------------
  cachedBalance(walletId: string, tokenKey: string): { raw: string; at: number } | undefined {
    return this.d.balanceCache[`${walletId}|${tokenKey}`]
  }

  cacheBalance(walletId: string, tokenKey: string, raw: string): void {
    this.d.balanceCache[`${walletId}|${tokenKey}`] = { raw, at: Date.now() }
  }

  cachedPrices(): StoreData['priceCache'] {
    return this.d.priceCache
  }

  cachePrices(prices: Record<string, { price: number; change24h: number }>): void {
    const at = Date.now()
    for (const [id, value] of Object.entries(prices)) this.d.priceCache[id] = { ...value, at }
    this.persist()
  }

  /** Clear wallets, connections and history. Keeps the account and settings. */
  reset(): void {
    const { account, settings, accountToken } = this.d
    this.data = { ...empty(), account, settings, accountToken }
    this.persist()
  }
}

const READONLY_NOTES: Record<string, string> = {
  smart: 'Created by an earlier version of Goldfelty. Nothing can sign for this address.',
  watch: 'Tracked address. Goldfelty shows its balance but cannot send from it.'
}

/** Convert a version 1 plaintext state file. Exported for tests. */
export function migrateLegacy(legacy: LegacyState): { data: StoreData; report: MigrationReport } {
  const createdAddresses: string[] = []

  const wallets: Wallet[] = (legacy.wallets ?? []).map((w) => {
    let kind: WalletKind
    let note: string | null = null
    if (w.kind === 'smart' || w.kind === 'watch') {
      kind = 'readonly'
      note = READONLY_NOTES[w.kind]
      if (w.kind === 'smart') createdAddresses.push(w.address)
    } else if (w.kind === 'walletconnect') {
      kind = 'walletconnect'
    } else {
      kind = 'browser'
    }
    const match = w.providerName ? matchRegistry('', w.providerName) : null
    return {
      id: w.id,
      label: w.label,
      kind,
      address: w.address,
      // Old connections were never persisted, so every one needs reconnecting.
      connectionId: null,
      providerName: w.providerName ?? null,
      providerId: match?.id ?? null,
      chainIds: w.chainIds ?? [],
      enabledTokens: w.enabledTokens ?? [],
      color: w.color ?? '#8e8e93',
      createdAt: w.createdAt ?? Date.now(),
      archived: w.archived ?? false,
      note
    }
  })

  const account = legacy.account
    ? {
        username: legacy.account.username,
        email: legacy.account.email,
        goldfeltyId: legacy.account.goldfeltyId,
        createdAt: legacy.account.createdAt,
        linked: legacy.account.linked,
        address: null
      }
    : null

  return {
    data: {
      ...empty(),
      settings: normaliseSettings(legacy.settings),
      account,
      wallets,
      history: legacy.history ?? [],
      transfers: legacy.transfers ?? [],
      balanceCache: legacy.balanceCache ?? {},
      priceCache: legacy.priceCache ?? {}
    },
    report: { createdAddresses }
  }
}
