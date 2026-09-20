import { randomUUID } from 'node:crypto'
import type { Vault } from './vault.ts'
import type { Account } from '../shared/types.ts'

/**
 * Client for goldfelty.com account linking.
 *
 * What is sent: the chosen username, the email address, and the owner address
 * with a signature proving the user controls it. What is never sent, under any
 * circumstance: the password, the seed phrase, or any private key. Registration
 * is proof-of-key, not proof-of-password.
 */
export const GOLDFELTY_API = process.env.GOLDFELTY_API_URL ?? 'https://api.goldfelty.com/v1'
const TIMEOUT_MS = 10_000

export const USERNAME_RULES = {
  min: 3,
  max: 24,
  pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/
}

export function validateUsername(username: string): string | null {
  const value = username.trim().toLowerCase()
  if (value.length < USERNAME_RULES.min) return `Usernames need at least ${USERNAME_RULES.min} characters.`
  if (value.length > USERNAME_RULES.max) return `Usernames can be at most ${USERNAME_RULES.max} characters.`
  if (!USERNAME_RULES.pattern.test(value)) {
    return 'Use lowercase letters, numbers, hyphens and underscores only.'
  }
  return null
}

export function validateEmail(email: string): string | null {
  const value = email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Enter a valid email address.'
  return null
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${GOLDFELTY_API}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal
    })
    const text = await response.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!response.ok) {
      throw new Error((body.message as string) ?? `${response.status} ${response.statusText}`)
    }
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

export interface UsernameCheck {
  available: boolean
  /** True when the service could not be reached and the answer is provisional. */
  offline: boolean
  reason?: string
}

export async function checkUsername(username: string): Promise<UsernameCheck> {
  const problem = validateUsername(username)
  if (problem) return { available: false, offline: false, reason: problem }
  try {
    const body = await call<{ available: boolean; reason?: string }>(
      `/accounts/username-available?username=${encodeURIComponent(username.trim().toLowerCase())}`,
      { method: 'GET' }
    )
    return { available: body.available, offline: false, reason: body.reason }
  } catch {
    // The name is claimed for real at registration time; an offline check must
    // not block onboarding.
    return { available: true, offline: true }
  }
}

export interface RegistrationResult {
  account: Account
  /** False when goldfelty.com was unreachable and the account is local for now. */
  linked: boolean
  message?: string
}

/**
 * Register with goldfelty.com, proving ownership of the primary owner key by
 * signing a challenge. Falls back to a local-only account if the service cannot
 * be reached, and records that so Settings can offer to finish linking later.
 */
export async function registerAccount(
  vault: Vault,
  input: { username: string; email: string }
): Promise<RegistrationResult> {
  const username = input.username.trim().toLowerCase()
  const email = input.email.trim()
  const usernameProblem = validateUsername(username)
  if (usernameProblem) throw new Error(usernameProblem)
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new Error(emailProblem)

  const owner = vault.deriveOwner(0)
  const issuedAt = new Date().toISOString()
  const statement = [
    'Goldfelty account registration',
    `username: ${username}`,
    `email: ${email}`,
    `address: ${owner.address}`,
    `issued: ${issuedAt}`
  ].join('\n')

  let signature: string
  try {
    signature = await owner.signMessage(statement)
  } catch (error) {
    throw new Error(`Could not sign the registration request: ${(error as Error).message}`)
  }

  const base: Account = {
    username,
    email,
    goldfeltyId: `local-${randomUUID()}`,
    createdAt: Date.now(),
    backedUp: false,
    linked: false
  }

  try {
    const body = await call<{ id: string }>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ username, email, address: owner.address, statement, signature, issuedAt })
    })
    return { account: { ...base, goldfeltyId: body.id, linked: true }, linked: true }
  } catch (error) {
    return {
      account: base,
      linked: false,
      message: `Created offline — goldfelty.com could not be reached (${(error as Error).message}). You can link this account later from Settings.`
    }
  }
}

/** Retry linking a local-only account. Offered in Settings → Account. */
export async function linkExistingAccount(vault: Vault, account: Account): Promise<RegistrationResult> {
  if (account.linked) return { account, linked: true }
  return registerAccount(vault, { username: account.username, email: account.email })
}
