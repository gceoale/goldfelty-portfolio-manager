import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  deriveKey,
  deriveKeyFor,
  encryptWithKey,
  decryptWithKey,
  newSalt,
  wipe,
  scorePassword,
  MIN_PASSWORD_SCORE,
  KDF_PARAMS,
  type EncryptedBlob,
  type KdfDescriptor
} from './crypto.ts'

/**
 * The password vault.
 *
 * Goldfelty holds no wallet keys: every wallet is connected, and signs in its
 * own app. What the password protects is what Goldfelty knows about you —
 * which addresses you hold, what they are worth, what you have sent. That
 * lives in an encrypted store, and this vault holds the random key for it,
 * wrapped under a key stretched from the password with scrypt.
 *
 * Version 1 of the vault held a recovery phrase for wallets the app created
 * itself. Unlocking one of those migrates it: the original file is copied
 * aside untouched, still encrypted under the same password, and replaced with
 * a version 2 vault. Nothing that could move funds is ever deleted.
 */

interface PayloadV1 {
  mnemonic: string
  createdAt: number
}

interface PayloadV2 {
  version: 2
  dataKey: string
  createdAt: number
  migratedFromV1?: boolean
}

export class VaultLockedError extends Error {
  code = 'LOCKED'
  constructor() {
    super('Goldfelty is locked.')
  }
}

export class WeakPasswordError extends Error {
  code = 'WEAK_PASSWORD'
  constructor(problems: string[]) {
    super(problems[0] ?? 'That password is not strong enough.')
  }
}

export interface UnlockResult {
  /** Set when this unlock converted a version 1 vault. */
  migratedFromV1: boolean
  backupPath: string | null
}

export class Vault {
  readonly path: string
  readonly backupPath: string
  private dataKey: Buffer | null = null

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'vault.json')
    this.backupPath = join(dataDir, 'vault.v1-backup.json')
  }

  exists(): boolean {
    return existsSync(this.path)
  }

  get isLocked(): boolean {
    return this.dataKey === null
  }

  /** The data key. Only available while unlocked, and only to the main process. */
  key(): Buffer {
    if (!this.dataKey) throw new VaultLockedError()
    return this.dataKey
  }

  private read(): EncryptedBlob {
    return JSON.parse(readFileSync(this.path, 'utf8')) as EncryptedBlob
  }

  private write(blob: EncryptedBlob): void {
    // Temp file and rename, so a crash mid-write cannot leave a half vault.
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // No POSIX modes on Windows; the user data folder's ACLs cover it.
    }
  }

  private async seal(password: string, payload: PayloadV2): Promise<void> {
    const salt = newSalt()
    const kdf: KdfDescriptor = { name: 'scrypt', ...KDF_PARAMS, salt: salt.toString('base64') }
    const key = await deriveKey(password, salt)
    try {
      this.write(encryptWithKey(key, JSON.stringify(payload), kdf))
    } finally {
      wipe(key)
    }
  }

  async create(password: string): Promise<void> {
    if (this.exists()) throw new Error('Goldfelty is already set up on this computer.')
    const strength = scorePassword(password)
    if (strength.score < MIN_PASSWORD_SCORE) throw new WeakPasswordError(strength.problems)

    const dataKey = randomBytes(32)
    await this.seal(password, { version: 2, dataKey: dataKey.toString('base64'), createdAt: Date.now() })
    this.dataKey = dataKey
  }

  async unlock(password: string): Promise<UnlockResult> {
    if (!this.exists()) throw new Error('Goldfelty is not set up on this computer yet.')
    const blob = this.read()
    const key = await deriveKeyFor(password, blob.kdf)
    let payload: PayloadV1 | PayloadV2
    try {
      payload = JSON.parse(decryptWithKey(key, blob)) as PayloadV1 | PayloadV2
    } finally {
      wipe(key)
    }

    if ('version' in payload && payload.version === 2) {
      this.dataKey = Buffer.from(payload.dataKey, 'base64')
      return { migratedFromV1: false, backupPath: null }
    }

    // A version 1 vault. Keep the original exactly as it was, then replace it.
    if (!existsSync(this.backupPath)) copyFileSync(this.path, this.backupPath)
    const dataKey = randomBytes(32)
    await this.seal(password, {
      version: 2,
      dataKey: dataKey.toString('base64'),
      createdAt: (payload as PayloadV1).createdAt ?? Date.now(),
      migratedFromV1: true
    })
    this.dataKey = dataKey
    return { migratedFromV1: true, backupPath: this.backupPath }
  }

  lock(): void {
    wipe(this.dataKey)
    this.dataKey = null
  }

  /** Check a password without changing lock state. */
  async verify(password: string): Promise<boolean> {
    if (!this.exists()) return false
    const blob = this.read()
    const key = await deriveKeyFor(password, blob.kdf)
    try {
      decryptWithKey(key, blob)
      return true
    } catch {
      return false
    } finally {
      wipe(key)
    }
  }

  /** Re-wrap the same data key under a new password. The store is untouched. */
  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const blob = this.read()
    const currentKey = await deriveKeyFor(currentPassword, blob.kdf)
    let payload: PayloadV2
    try {
      payload = JSON.parse(decryptWithKey(currentKey, blob)) as PayloadV2
    } finally {
      wipe(currentKey)
    }
    if (payload.version !== 2) throw new Error('Unlock Goldfelty once before changing the password.')
    const strength = scorePassword(nextPassword)
    if (strength.score < MIN_PASSWORD_SCORE) throw new WeakPasswordError(strength.problems)
    await this.seal(nextPassword, payload)
  }
}
