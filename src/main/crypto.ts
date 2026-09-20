import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/**
 * scrypt parameters. N = 2^17 puts a single guess at roughly 150 ms and 128 MB
 * on a modern laptop, which is the point: it is the only thing standing between
 * a stolen vault file and the seed phrase inside it.
 */
export const KDF_PARAMS = { N: 131072, r: 8, p: 1, keyLength: 32 } as const
const MAXMEM = 256 * 1024 * 1024

export interface KdfDescriptor {
  name: 'scrypt'
  N: number
  r: number
  p: number
  keyLength: number
  salt: string
}

export interface EncryptedBlob {
  version: 1
  kdf: KdfDescriptor
  cipher: 'aes-256-gcm'
  iv: string
  authTag: string
  ciphertext: string
  checksum: string
}

export function newSalt(): Buffer {
  return randomBytes(32)
}

export async function deriveKey(password: string, salt: Buffer, params = KDF_PARAMS): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM
  })
}

export async function deriveKeyFor(password: string, kdf: KdfDescriptor): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: MAXMEM
  })
}

export function encryptWithKey(key: Buffer, plaintext: string, kdf: KdfDescriptor): EncryptedBlob {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    version: 1,
    kdf,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    checksum: sha256(ciphertext)
  }
}

export class WrongPasswordError extends Error {
  code = 'WRONG_PASSWORD'
  constructor() {
    super('Incorrect password.')
  }
}

export class CorruptVaultError extends Error {
  code = 'CORRUPT_VAULT'
  constructor() {
    super('The vault file is damaged and could not be read.')
  }
}

export function decryptWithKey(key: Buffer, blob: EncryptedBlob): string {
  const ciphertext = Buffer.from(blob.ciphertext, 'base64')
  if (blob.checksum !== sha256(ciphertext)) throw new CorruptVaultError()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'))
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // A GCM tag mismatch means either a wrong key or tampering; the checksum
    // above already ruled out accidental corruption, so report a bad password.
    throw new WrongPasswordError()
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Overwrite key material in place so it does not linger in the heap. */
export function wipe(buf: Buffer | null | undefined): void {
  if (buf && buf.length) buf.fill(0)
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4
  label: 'Too weak' | 'Weak' | 'Fair' | 'Strong' | 'Excellent'
  problems: string[]
}

const COMMON = new Set([
  'password', 'password1', '12345678', '123456789', 'qwertyui', 'letmein1',
  'iloveyou', 'admin123', 'welcome1', 'passw0rd', 'goldfelty', 'bitcoin1'
])

export function scorePassword(password: string): PasswordStrength {
  const problems: string[] = []
  if (password.length < 10) problems.push('Use at least 10 characters.')
  if (!/[a-z]/.test(password)) problems.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) problems.push('Add an uppercase letter.')
  if (!/[0-9]/.test(password)) problems.push('Add a number.')
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Add a symbol.')
  if (COMMON.has(password.toLowerCase())) problems.push('This password is too common.')
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.')

  let score = 0
  if (password.length >= 10) score++
  if (password.length >= 16) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score++
  if (COMMON.has(password.toLowerCase()) || password.length < 10) score = 0

  const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Excellent'] as const
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score], problems }
}

/** Minimum bar enforced at onboarding and when changing the password. */
export const MIN_PASSWORD_SCORE = 2
