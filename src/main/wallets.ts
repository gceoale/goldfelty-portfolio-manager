import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import { CHAIN_BY_ID, chainIdsForFamily, chainsOfFamily } from '../shared/chains.ts'
import { detectAddress, validateFor } from './addresses.ts'
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

const FAMILY_SUFFIX: Record<string, string> = { utxo: 'Bitcoin', solana: 'Solana', tron: 'Tron', xrp: 'XRP' }

/** The canonical address and chains for one shared account, or null if it isn't valid for the connection. */
function normaliseAccount(connection: WalletConnection, raw: string, enabledChains: number[]): { address: string; chainIds: number[] } | null {
  try {
    if (connection.family === 'utxo') {
      // Bitcoin-family connections say which chain they are for.
      const chain = CHAIN_BY_ID.get(connection.chainIds[0] ?? -1)
      if (!chain || chain.family !== 'utxo') return null
      return { address: validateFor('utxo', chain.key, raw), chainIds: [chain.id] }
    }
    const chainKey = chainsOfFamily(connection.family)[0]?.key ?? ''
    return { address: validateFor(connection.family, chainKey, raw), chainIds: chainIdsForFamily(connection.family, enabledChains) }
  } catch {
    return null
  }
}

/**
 * Add or refresh a wallet for every account a connection shared. An address
 * already in the list — from another wallet app, or tracked read-only — is
 * re-pointed at this connection rather than duplicated, so it becomes able
 * to send.
 */
export function registerConnectionAccounts(store: Store, given: WalletConnection, enabledChains: number[]): Wallet[] {
  // Connections stored before 1.2 have no family; they were all EVM.
  const connection: WalletConnection = { ...given, family: given.family ?? 'evm' }
  const result: Wallet[] = []
  const many = connection.accounts.length > 1
  const suffix = connection.family === 'evm' ? '' : ` (${connection.family === 'utxo' ? (CHAIN_BY_ID.get(connection.chainIds[0])?.name ?? 'Bitcoin') : FAMILY_SUFFIX[connection.family]})`

  connection.accounts.forEach((raw, i) => {
    const account = normaliseAccount(connection, raw, enabledChains)
    if (!account) return
    const { address, chainIds } = account
    const publicKey = connection.publicKeys?.[raw] ?? connection.publicKeys?.[address] ?? null
    const existing = store.walletByAddress(address)

    if (existing) {
      const updated = store.updateWallet(existing.id, {
        kind: connection.kind,
        family: connection.family,
        connectionId: connection.id,
        providerName: connection.name,
        providerId: connection.providerId,
        archived: false,
        note: null,
        publicKey: publicKey ?? existing.publicKey ?? null,
        chainIds: existing.chainIds.length ? existing.chainIds : chainIds
      })
      if (updated) result.push(updated)
      return
    }

    if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError()
    const wallet: Wallet = {
      id: randomUUID(),
      label: (many ? `${connection.name} ${i + 1}` : connection.name) + suffix,
      kind: connection.kind,
      family: connection.family,
      address,
      connectionId: connection.id,
      providerName: connection.name,
      providerId: connection.providerId,
      chainIds,
      enabledTokens: [],
      color: accentFor(connection, store.wallets.length),
      createdAt: Date.now(),
      archived: false,
      note: null,
      publicKey
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
  let detected
  try {
    detected = detectAddress(input.address)
  } catch (error) {
    throw new TrackError((error as Error).message)
  }
  const address = detected.address
  if (store.walletByAddress(address)) throw new TrackError('That address is already in Goldfelty.')
  if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError()

  const app = input.providerId ? TRACK_ONLY_BY_ID.get(input.providerId) : undefined
  const providerName = app?.name ?? null
  const label = String(input.label ?? '').trim().slice(0, 48) || providerName || 'Tracked address'
  const wallet: Wallet = {
    id: randomUUID(),
    label,
    kind: 'readonly',
    family: detected.family,
    address,
    connectionId: null,
    providerName,
    providerId: app?.id ?? null,
    chainIds: detected.chainIds ?? chainIdsForFamily(detected.family, enabledChains),
    enabledTokens: [],
    color: app?.color ?? ACCENTS[store.wallets.length % ACCENTS.length],
    createdAt: Date.now(),
    archived: false,
    note: `Tracked address. Goldfelty shows its balance; send and receive with ${providerName ?? 'the wallet that holds it'}.`
  }
  store.addWallet(wallet)
  return wallet
}
