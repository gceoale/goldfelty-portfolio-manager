import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, UpgradeNotice } from '../shared/types.ts'

/**
 * The little the app needs before it is unlocked: the theme to draw the lock
 * screen in, which name to greet, whether setup finished, and how many wrong
 * passwords have been tried.
 *
 * Nothing here says what you own or where the app sends requests. Wallets,
 * balances, history and every other setting live in the encrypted store.
 */

/** Wrong passwords allowed before each further try has to wait. */
export const FREE_ATTEMPTS = 5
/** The wait doubles per failure past the free ones, up to this. */
export const MAX_WAIT_MS = 15 * 60_000

interface PrefsData {
  schemaVersion: 3
  theme: Settings['theme']
  greetingName: string | null
  onboarded: boolean
  upgradeNotice: UpgradeNotice | null
  failedUnlocks: number
  unlockRetryAt: number | null
  /** Download and install updates without asking first. Readable while locked. */
  autoUpdate: boolean
}

interface LegacyState {
  settings?: { theme?: Settings['theme'] }
  account?: { username?: string; backedUp?: boolean } | null
}

const THEMES = new Set(['dark', 'light', 'system'])

const fresh = (): PrefsData => ({
  schemaVersion: 3,
  theme: 'system',
  greetingName: null,
  onboarded: false,
  upgradeNotice: null,
  failedUnlocks: 0,
  unlockRetryAt: null,
  autoUpdate: true
})

export class Prefs {
  private readonly file: string
  private data: PrefsData

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'prefs.json')
    this.data = this.load(dataDir)
  }

  private load(dataDir: string): PrefsData {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PrefsData>
        return {
          ...fresh(),
          theme: THEMES.has(String(parsed.theme)) ? (parsed.theme as Settings['theme']) : 'system',
          greetingName: typeof parsed.greetingName === 'string' ? parsed.greetingName.slice(0, 40) : null,
          onboarded: parsed.onboarded === true,
          upgradeNotice: parsed.upgradeNotice ?? null,
          failedUnlocks: Math.max(0, Number(parsed.failedUnlocks) || 0),
          unlockRetryAt: Number(parsed.unlockRetryAt) || null,
          autoUpdate: parsed.autoUpdate !== false
        }
      } catch {
        // A damaged prefs file costs a theme and a greeting, nothing more.
        return fresh()
      }
    }

    // First run of this version over a version 1 install.
    const legacyFile = join(dataDir, 'state.json')
    if (existsSync(legacyFile)) {
      try {
        const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as LegacyState
        this.data = {
          ...fresh(),
          theme: THEMES.has(String(legacy.settings?.theme)) ? legacy.settings!.theme! : 'system',
          greetingName: legacy.account?.username ?? null,
          onboarded: !!legacy.account?.backedUp
        }
        this.persist()
        return this.data
      } catch {
        // Unreadable legacy file: start clean rather than refuse to launch.
      }
    }
    return fresh()
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get theme(): Settings['theme'] {
    return this.data.theme
  }

  setTheme(theme: Settings['theme']): void {
    if (this.data.theme === theme) return
    this.data.theme = theme
    this.persist()
  }

  get greetingName(): string | null {
    return this.data.greetingName
  }

  setGreetingName(name: string | null): void {
    this.data.greetingName = name ? name.slice(0, 40) : null
    this.persist()
  }

  get onboarded(): boolean {
    return this.data.onboarded
  }

  finishOnboarding(greetingName: string | null): void {
    this.data.onboarded = true
    this.data.greetingName = greetingName ? greetingName.slice(0, 40) : null
    this.persist()
  }

  get upgradeNotice(): UpgradeNotice | null {
    return this.data.upgradeNotice
  }

  setUpgradeNotice(notice: UpgradeNotice | null): void {
    this.data.upgradeNotice = notice
    this.persist()
  }

  // ---- unlock throttling -------------------------------------------------
  // Persisted, so quitting and relaunching does not reset the count. It
  // slows guessing at the lock screen; against a copied vault file the
  // defence is scrypt, which this does not replace.

  /** When the next attempt may be made, or null if it may be made now. */
  unlockRetryAt(now = Date.now()): number | null {
    const at = this.data.unlockRetryAt
    return at && at > now ? at : null
  }

  recordFailedUnlock(now = Date.now()): number | null {
    this.data.failedUnlocks += 1
    const over = this.data.failedUnlocks - FREE_ATTEMPTS
    this.data.unlockRetryAt = over > 0 ? now + Math.min(MAX_WAIT_MS, 1000 * 2 ** (over - 1)) : null
    this.persist()
    return this.data.unlockRetryAt
  }

  recordSuccessfulUnlock(): void {
    if (this.data.failedUnlocks === 0 && this.data.unlockRetryAt === null) return
    this.data.failedUnlocks = 0
    this.data.unlockRetryAt = null
    this.persist()
  }

  get autoUpdate(): boolean {
    return this.data.autoUpdate
  }

  setAutoUpdate(on: boolean): void {
    if (this.data.autoUpdate === on) return
    this.data.autoUpdate = on
    this.persist()
  }

  get failedUnlocks(): number {
    return this.data.failedUnlocks
  }
}
