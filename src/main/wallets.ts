import { randomUUID } from 'node:crypto'
import { getAddress, isAddress } from 'ethers'
import type { Store } from './store.ts'
import { DEFAULT_CHAIN_IDS } from '../shared/chains.ts'
import { REGISTRY_BY_ID, TRACK_ONLY_BY_ID } from '../shared/walletRegistry.ts'
import type { Wallet, WalletConnection } from '../shared/types.ts'

/**
 * Turning what a wallet app shares into wallets the portfolio tracks.
 *
 * Goldfelty creates no wallets. Each one here is an account that lives in a
 * wallet app the user already has, which signs for it on request.
 */

/** Fallback accents for wallets the registry doesn't know. */
const ACCENTS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68']

/** A ceiling well above what anyone needs, so a runaway wallet can't flood the store. */
export const MAX_WALLETS = 256

export class WalletLimitError extends Error {
  code = 'WALLET_LIMIT'
  constructor() {
    super(`Goldfelty tracks at most ${MAX_WALLETS} accounts.`)
  }
}

function accentFor(connection: WalletConnection, index: number): string {
  return REGISTRY_BY_ID.get(connection.providerId)?.color ?? ACCENTS[index % ACCENTS.length]
}

/**
 * Add or refresh a wallet for every account a connection shared. An address
 * already in the list — from another wallet app, or carried over read-only
 * from an earlier version — is re-pointed at this connection rather than
 * duplicated, so it becomes able to send again.
 */
export function registerConnectionAccounts(store: Store, connection: WalletConnection, enabledChains: number[]): Wallet[] {
  const chainIds = enabledChains.length ? enabledChains : [...DEFAULT_CHAIN_IDS]
  const result: Wallet[] = []
  const many = connection.accounts.length > 1

  connection.accounts.forEach((raw, i) => {
    if (!isAddress(raw)) return
    const address = getAddress(raw)
    const existing = store.walletByAddress(address)

    if (existing) {
      const updated = store.updateWallet(existing.id, {
        kind: connection.kind,
        connectionId: connection.id,
        providerName: connection.name,
        providerId: connection.providerId,
        archived: false,
        note: null,
        chainIds: existing.chainIds.length ? existing.chainIds : chainIds
      })
      if (updated) result.push(updated)
      return
    }

    if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError()
    const wallet: Wallet = {
      id: randomUUID(),
      label: many ? `${connection.name} ${i + 1}` : connection.name,
      kind: connection.kind,
      address,
      connectionId: connection.id,
      providerName: connection.name,
      providerId: connection.providerId,
      chainIds,
      enabledTokens: [],
      color: accentFor(connection, store.wallets.length),
      createdAt: Date.now(),
      archived: false,
      note: null
    }
    store.addWallet(wallet)
    result.push(wallet)
  })

  return result
}

/** Wallets lose their way to sign when their connection goes. They stay listed. */
export function detachConnection(store: Store, connectionId: string): number {
  let count = 0
  for (const wallet of store.wallets) {
    if (wallet.connectionId !== connectionId) continue
    store.updateWallet(wallet.id, { connectionId: null })
    count++
  }
  return count
}

export class TrackError extends Error {
  code = 'BAD_ADDRESS'
}

/**
 * Track an address from a wallet that can't connect (Exodus, for one), so
 * its balances count in the portfolio. Read-only: Goldfelty never offers it
 * to send from or to receive into, because nothing here can sign for it and
 * a typed address can't be proven to be the user's.
 */
export function trackAddress(
  store: Store,
  input: { address: string; label?: string; providerId?: string | null },
  enabledChains: number[]
): Wallet {
  const raw = String(input.address ?? '').trim()
  // A mixed-case address must carry a valid checksum, which catches most typos.
  if (!isAddress(raw)) throw new TrackError('That isn’t a valid address. Copy it from the wallet rather than typing it.')
  const address = getAddress(raw)
  if (store.walletByAddress(address)) throw new TrackError('That address is already in Goldfelty.')
  if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError()

  const app = input.providerId ? TRACK_ONLY_BY_ID.get(input.providerId) : undefined
  const providerName = app?.name ?? null
  const label = String(input.label ?? '').trim().slice(0, 48) || providerName || 'Tracked address'
  const wallet: Wallet = {
    id: randomUUID(),
    label,
    kind: 'readonly',
    address,
    connectionId: null,
    providerName,
    providerId: app?.id ?? null,
    chainIds: enabledChains.length ? enabledChains : [...DEFAULT_CHAIN_IDS],
    enabledTokens: [],
    color: app?.color ?? ACCENTS[store.wallets.length % ACCENTS.length],
    createdAt: Date.now(),
    archived: false,
    note: `Tracked address. Goldfelty shows its balance; send and receive with ${providerName ?? 'the wallet that holds it'}.`
  }
  store.addWallet(wallet)
  return wallet
}
