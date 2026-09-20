import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { HDNodeWallet, Mnemonic, Wallet as EthWallet } from 'ethers'
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
import type { RecoveryMaterial } from '../shared/types.ts'

/** BIP-44 account root. Owner key for wallet *i* is `${BASE_PATH}/${i}`. */
export const BASE_PATH = "m/44'/60'/0'/0"

interface VaultPayload {
  mnemonic: string
  createdAt: number
}

export class VaultLockedError extends Error {
  code = 'LOCKED'
  constructor() {
    super('The vault is locked.')
  }
}

export class WeakPasswordError extends Error {
  code = 'WEAK_PASSWORD'
  constructor(problems: string[]) {
    super(problems[0] ?? 'That password is not strong enough.')
  }
}

/**
 * Owns all secret material for the app. The decrypted mnemonic lives here, in
 * the main process, and is never sent over IPC; the renderer only ever sees
 * addresses. Everything that needs a signature asks this class for one.
 */
export class Vault {
  private readonly file: string
  private mnemonic: string | null = null
  private unlockedAt = 0
  /** Consumed by the one-and-only recovery reveal during onboarding. */
  private revealTicket: string | null = null

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'vault.json')
  }

  get path(): string {
    return this.file
  }

  exists(): boolean {
    return existsSync(this.file)
  }

  get isLocked(): boolean {
    return this.mnemonic === null
  }

  get unlockedSince(): number {
    return this.unlockedAt
  }

  private read(): EncryptedBlob {
    return JSON.parse(readFileSync(this.file, 'utf8')) as EncryptedBlob
  }

  private write(blob: EncryptedBlob): void {
    // Write to a sibling then rename: a crash mid-write must never leave the
    // user with a half-written vault and an unrecoverable seed.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Windows has no POSIX mode bits; ACL inheritance from the user data
      // directory covers it there.
    }
  }

  /**
   * Create the vault. Returns the recovery material — the only time it is ever
   * produced — along with a ticket the UI must hand back to confirm the backup.
   */
  async create(password: string, importedMnemonic?: string): Promise<{ recovery: RecoveryMaterial; ticket: string }> {
    if (this.exists()) throw new Error('A vault already exists on this computer.')
    const strength = scorePassword(password)
    if (strength.score < MIN_PASSWORD_SCORE) throw new WeakPasswordError(strength.problems)

    const phrase = importedMnemonic
      ? Mnemonic.fromPhrase(importedMnemonic.trim().replace(/\s+/g, ' ')).phrase
      : Mnemonic.fromEntropy(randomBytes(32)).phrase

    const salt = newSalt()
    const kdf: KdfDescriptor = { name: 'scrypt', ...KDF_PARAMS, salt: salt.toString('base64') }
    const key = await deriveKey(password, salt)
    try {
      const payload: VaultPayload = { mnemonic: phrase, createdAt: Date.now() }
      this.write(encryptWithKey(key, JSON.stringify(payload), kdf))
    } finally {
      wipe(key)
    }

    this.mnemonic = phrase
    this.unlockedAt = Date.now()
    this.revealTicket = randomBytes(24).toString('hex')

    const owner = this.deriveOwner(0)
    return {
      recovery: {
        mnemonic: phrase,
        privateKey: owner.privateKey,
        ownerAddress: owner.address,
        derivationPath: `${BASE_PATH}/0`
      },
      ticket: this.revealTicket
    }
  }

  /** Re-issue the recovery material during onboarding only. The ticket burns on use. */
  revealOnce(ticket: string): RecoveryMaterial {
    if (!this.revealTicket || ticket !== this.revealTicket) {
      throw new Error('Recovery material can only be shown while setting up your account.')
    }
    if (!this.mnemonic) throw new VaultLockedError()
    const owner = this.deriveOwner(0)
    return {
      mnemonic: this.mnemonic,
      privateKey: owner.privateKey,
      ownerAddress: owner.address,
      derivationPath: `${BASE_PATH}/0`
    }
  }

  /** Called once the user confirms the backup. After this the reveal is gone for good. */
  closeReveal(): void {
    this.revealTicket = null
  }

  get revealIsOpen(): boolean {
    return this.revealTicket !== null
  }

  async unlock(password: string): Promise<void> {
    if (!this.exists()) throw new Error('No vault on this computer yet.')
    const blob = this.read()
    const key = await deriveKeyFor(password, blob.kdf)
    try {
      const payload = JSON.parse(decryptWithKey(key, blob)) as VaultPayload
      this.mnemonic = payload.mnemonic
      this.unlockedAt = Date.now()
    } finally {
      wipe(key)
    }
  }

  lock(): void {
    this.mnemonic = null
    this.unlockedAt = 0
    this.revealTicket = null
  }

  /** Verify a password without changing lock state — used to gate sending. */
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

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const blob = this.read()
    const currentKey = await deriveKeyFor(currentPassword, blob.kdf)
    let payload: VaultPayload
    try {
      payload = JSON.parse(decryptWithKey(currentKey, blob)) as VaultPayload
    } finally {
      wipe(currentKey)
    }
    const strength = scorePassword(nextPassword)
    if (strength.score < MIN_PASSWORD_SCORE) throw new WeakPasswordError(strength.problems)

    const salt = newSalt()
    const kdf: KdfDescriptor = { name: 'scrypt', ...KDF_PARAMS, salt: salt.toString('base64') }
    const nextKey = await deriveKey(nextPassword, salt)
    try {
      this.write(encryptWithKey(nextKey, JSON.stringify(payload), kdf))
    } finally {
      wipe(nextKey)
    }
  }

  /** The EOA that owns the smart account at BIP-44 index `index`. */
  deriveOwner(index: number): HDNodeWallet {
    if (!this.mnemonic) throw new VaultLockedError()
    if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
      throw new Error(`Invalid derivation index ${index}`)
    }
    return HDNodeWallet.fromPhrase(this.mnemonic, '', `${BASE_PATH}/${index}`)
  }

  /** A connected signer for the owner of a wallet, bound to a provider. */
  ownerSigner(index: number, provider: Parameters<EthWallet['connect']>[0]): EthWallet {
    const hd = this.deriveOwner(index)
    return new EthWallet(hd.privateKey, provider)
  }

  /** Addresses only — safe to hand to the renderer. */
  ownerAddress(index: number): string {
    return this.deriveOwner(index).address
  }
}
