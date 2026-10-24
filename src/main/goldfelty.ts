import { randomUUID } from 'node:crypto'
import { getAddress } from 'ethers'
import type { Account, AccountApiStatus } from '../shared/types.ts'

/**
 * The goldfelty.com account.
 *
 * Signing up sends three things: a username, an email address, and a
 * signature from one of the user's own wallets proving they control an
 * address. The wallet shows the exact text before signing. The password and
 * keys are never sent. Balances are sent only if the user turns on sharing,
 * and then only the portfolio total, its currency and the wallet count.
 *
 * The account is optional. If api.goldfelty.com cannot be reached, the
 * account is kept on this computer and linked later from Settings.
 */

export const GOLDFELTY_API = (process.env.GOLDFELTY_API_URL ?? 'https://api.goldfelty.com/v1').replace(/\/$/, '')
const TIMEOUT_MS = 10_000
const HEALTH_TIMEOUT_MS = 4_000
/** Responses larger than this are not from our API. */
const MAX_RESPONSE = 16_384

export const USERNAME_RULES = { min: 3, max: 24, pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/ }

export function normaliseUsername(username: string): string {
  return String(username ?? '').trim().toLowerCase()
}

export function normaliseEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase()
}

export function validateUsername(username: string): string | null {
  const value = normaliseUsername(username)
  if (value.length < USERNAME_RULES.min) return `Usernames need at least ${USERNAME_RULES.min} characters.`
  if (value.length > USERNAME_RULES.max) return `Usernames can be at most ${USERNAME_RULES.max} characters.`
  if (!USERNAME_RULES.pattern.test(value)) return 'Use lowercase letters, numbers, hyphens and underscores.'
  return null
}

export function validateEmail(email: string): string | null {
  const value = normaliseEmail(email)
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Enter a valid email address.'
  return null
}

/** The service could not be reached at all. The account can stay local. */
export class ApiUnreachableError extends Error {
  code = 'API_UNREACHABLE'
}

/** The service answered and said no. The user has something to fix. */
export class ApiRefusedError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code = 'API_REFUSED') {
    super(message)
    this.status = status
    this.code = code
  }
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(`${GOLDFELTY_API}${path}`, {
      ...init,
      // Never follow a redirect off our own API with a signed body.
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: controller.signal
    })
  } catch (error) {
    throw new ApiUnreachableError(`goldfelty.com couldn’t be reached (${(error as Error).message}).`)
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (text.length > MAX_RESPONSE) throw new ApiUnreachableError('goldfelty.com sent an unexpected response.')
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // An HTML error page from a proxy or a parked domain: the API is not there.
    throw new ApiUnreachableError('goldfelty.com isn’t answering account requests right now.')
  }
  if (response.status >= 500) throw new ApiUnreachableError('goldfelty.com had a problem. Try again later.')
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message.slice(0, 200) : `Request failed (${response.status}).`
    throw new ApiRefusedError(message, response.status)
  }
  return body as T
}

export async function apiStatus(): Promise<AccountApiStatus> {
  try {
    const body = await call<{ ok?: boolean }>('/health', { method: 'GET' }, HEALTH_TIMEOUT_MS)
    return { reachable: body.ok === true, url: GOLDFELTY_API }
  } catch {
    return { reachable: false, url: GOLDFELTY_API }
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
      `/accounts/username-available?username=${encodeURIComponent(normaliseUsername(username))}`,
      { method: 'GET' },
      HEALTH_TIMEOUT_MS
    )
    return { available: body.available === true, offline: false, reason: typeof body.reason === 'string' ? body.reason : undefined }
  } catch (error) {
    if (error instanceof ApiRefusedError) return { available: false, offline: false, reason: error.message }
    return { available: true, offline: true }
  }
}

/** Exactly what the wallet is asked to sign. The API rebuilds and checks it. */
export function registrationStatement(input: { username: string; email: string; address: string; issuedAt: string }): string {
  return [
    'Goldfelty account registration',
    `username: ${input.username}`,
    `email: ${input.email}`,
    `address: ${input.address}`,
    `issued: ${input.issuedAt}`
  ].join('\n')
}

/** Something that can sign as one of the user's addresses: a connected wallet. */
export interface AccountSigner {
  address: string
  name: string
  sign(message: string): Promise<string>
}

export interface RegistrationResult {
  account: Account
  linked: boolean
  message?: string
  /** For reporting totals, when the user has chosen to share them. Main process only. */
  token?: string | null
}

export function localAccount(input: { username: string; email: string }): Account {
  return {
    username: normaliseUsername(input.username),
    email: normaliseEmail(input.email),
    goldfeltyId: `local-${randomUUID()}`,
    createdAt: Date.now(),
    linked: false,
    address: null
  }
}

/**
 * Register with goldfelty.com, proving control of `signer.address`.
 *
 * - Unreachable service: resolves with a local account and `linked: false`.
 * - Service refuses (name taken, bad signature): throws ApiRefusedError, so
 *   the user can change what they typed rather than end up half-registered.
 * - User declines in the wallet: throws, and nothing is sent.
 */
export async function registerAccount(
  input: { username: string; email: string },
  signer: AccountSigner,
  existing: Account | null = null
): Promise<RegistrationResult> {
  const username = normaliseUsername(input.username)
  const email = normaliseEmail(input.email)
  const usernameProblem = validateUsername(username)
  if (usernameProblem) throw new ApiRefusedError(usernameProblem, 400, 'BAD_USERNAME')
  const emailProblem = validateEmail(email)
  if (emailProblem) throw new ApiRefusedError(emailProblem, 400, 'BAD_EMAIL')

  const base: Account = existing ?? localAccount({ username, email })

  // Check the service first, so the user is not asked to sign for nothing.
  const status = await apiStatus()
  if (!status.reachable) {
    return {
      account: { ...base, username, email },
      linked: false,
      message: 'goldfelty.com couldn’t be reached, so your account is saved on this computer. Link it from Settings later.'
    }
  }

  const address = getAddress(signer.address)
  const issuedAt = new Date().toISOString()
  const statement = registrationStatement({ username, email, address, issuedAt })
  const signature = await signer.sign(statement)

  try {
    const body = await call<{ id?: unknown; username?: unknown; token?: unknown }>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ username, email, address, issuedAt, signature })
    })
    if (typeof body.id !== 'string' || !/^gf_[0-9a-f-]{36}$/.test(body.id)) {
      throw new ApiUnreachableError('goldfelty.com sent an unexpected response.')
    }
    // The address may already have had an account, under its original name.
    const confirmedName = typeof body.username === 'string' && !validateUsername(body.username) ? body.username : username
    return {
      account: { ...base, username: confirmedName, email, goldfeltyId: body.id, linked: true, address },
      linked: true,
      token: typeof body.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(body.token) ? body.token : null,
      message: confirmedName !== username ? `That wallet already had the account “${confirmedName}”, so it was linked instead.` : undefined
    }
  } catch (error) {
    if (error instanceof ApiUnreachableError) {
      return { account: { ...base, username, email }, linked: false, message: `${error.message} Your account is saved on this computer for now.` }
    }
    throw error
  }
}

export interface TotalsReport {
  value: number
  currency: string
  wallets: number
}

/**
 * Share the portfolio total with goldfelty.com. Only called when the user has
 * turned sharing on, and only ever sends these three fields.
 */
export async function reportTotals(token: string, totals: TotalsReport): Promise<void> {
  await callAuthed('/reports', token, {
    method: 'POST',
    body: JSON.stringify({ value: Math.max(0, Math.round(totals.value * 100) / 100), currency: totals.currency, wallets: totals.wallets })
  })
}

/** Stop sharing: goldfelty.com deletes what it had. */
export async function withdrawTotals(token: string): Promise<void> {
  await callAuthed('/reports', token, { method: 'DELETE' })
}

async function callAuthed(path: string, token: string, init: RequestInit): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${GOLDFELTY_API}${path}`, {
      ...init,
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (!res.ok && res.status !== 204) throw new ApiRefusedError(`goldfelty.com refused the request (${res.status}).`, res.status)
  } catch (error) {
    if (error instanceof ApiRefusedError) throw error
    throw new ApiUnreachableError('goldfelty.com couldn’t be reached.')
  } finally {
    clearTimeout(timer)
  }
}
