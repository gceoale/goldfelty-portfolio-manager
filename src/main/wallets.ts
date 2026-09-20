import { randomUUID } from 'node:crypto'
import { getAddress, isAddress } from 'ethers'
import type { Store } from './store.ts'
import type { Vault } from './vault.ts'
import { accountSalt, predictAccountAddress } from './smartAccount.ts'
import { CHAIN_BY_ID, DEFAULT_CHAIN_IDS } from '../shared/chains.ts'
import type { Wallet } from '../shared/types.ts'

/** Wallet accent colours, assigned round-robin so 50+ wallets stay tellable apart. */
export const WALLET_COLORS = [
  '#d4a017', '#4f8ef7', '#41b883', '#e2725b', '#9b7ede', '#e0699c',
  '#2fb3b3', '#f2994a', '#7fa650', '#5c7cfa', '#c2557a', '#6bb5d6'
]

/** Hard ceiling on connected wallets. Well above the 50 the product promises. */
export const MAX_WALLETS = 256

export class WalletLimitError extends Error {
  code = 'WALLET_LIMIT'
  constructor(limit: number) {
    super(`This vault can hold at most ${limit} wallets.`)
  }
}

function validateChains(chainIds: number[]): number[] {
  const valid = [...new Set(chainIds)].filter((id) => CHAIN_BY_ID.has(id))
  return valid.length > 0 ? valid.sort((a, b) => a - b) : [...DEFAULT_CHAIN_IDS]
}

function defaultLabel(index: number): string {
  return `Wallet ${index + 1}`
}

/**
 * Connect one or more smart-contract wallets. Each gets its own owner key
 * derived from the vault seed, so the whole set is recoverable from the single
 * seed phrase the user wrote down at onboarding.
 */
export function connectSmartWallets(
  store: Store,
  vault: Vault,
  options: { count?: number; label?: string; chainIds?: number[]; enabledTokens?: string[] } = {}
): Wallet[] {
  const count = Math.max(1, Math.min(options.count ?? 1, MAX_WALLETS))
  const existing = store.wallets.length
  if (existing + count > MAX_WALLETS) throw new WalletLimitError(MAX_WALLETS)

  const chainIds = validateChains(options.chainIds ?? DEFAULT_CHAIN_IDS)
  const created: Wallet[] = []
  let index = store.nextDerivationIndex()

  for (let i = 0; i < count; i++, index++) {
    const owner = vault.ownerAddress(index)
    const saltNonce = BigInt(index)
    const wallet: Wallet = {
      id: randomUUID(),
      label: options.label
        ? count > 1
          ? `${options.label} ${i + 1}`
          : options.label
        : defaultLabel(existing + i),
      kind: 'smart',
      address: predictAccountAddress(owner, saltNonce),
      ownerAddress: owner,
      derivationIndex: index,
      salt: accountSalt(owner, saltNonce),
      chainIds,
      deployedOn: [],
      enabledTokens: options.enabledTokens ?? [],
      color: WALLET_COLORS[(existing + i) % WALLET_COLORS.length],
      createdAt: Date.now(),
      archived: false,
      connectionId: null,
      providerName: null
    }
    created.push(wallet)
  }

  store.addWallets(created)
  return created
}

export class InvalidAddressError extends Error {
  code = 'INVALID_ADDRESS'
  constructor(value: string) {
    super(`"${value}" is not a valid address.`)
  }
}

/**
 * Track an address the vault does not control. Watch wallets count towards the
 * portfolio but can never appear as a send route.
 */
export function connectWatchWallet(
  store: Store,
  options: { address: string; label?: string; chainIds?: number[] }
): Wallet {
  if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError(MAX_WALLETS)
  if (!isAddress(options.address)) throw new InvalidAddressError(options.address)
  const address = getAddress(options.address)
  const duplicate = store.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  if (duplicate) throw new Error(`That address is already connected as "${duplicate.label}".`)

  const wallet: Wallet = {
    id: randomUUID(),
    label: options.label?.trim() || `Watch ${address.slice(0, 6)}`,
    kind: 'watch',
    address,
    ownerAddress: null,
    derivationIndex: null,
    salt: '0x',
    chainIds: validateChains(options.chainIds ?? DEFAULT_CHAIN_IDS),
    deployedOn: [],
    enabledTokens: [],
    color: WALLET_COLORS[store.wallets.length % WALLET_COLORS.length],
    createdAt: Date.now(),
    archived: false,
    connectionId: null,
    providerName: null
  }
  store.addWallet(wallet)
  return wallet
}

/**
 * Register the accounts an external wallet app just shared with us.
 *
 * These are ordinary EOAs living in MetaMask, Rainbow, a hardware wallet —
 * wherever the user already keeps them. Goldfelty holds no key for them and
 * can only ask that app to sign. Re-connecting an address that is already
 * present re-points it at the new connection rather than duplicating it.
 */
export function connectExternalWallets(
  store: Store,
  options: {
    connectionId: string
    kind: 'walletconnect' | 'extension'
    providerName: string
    accounts: string[]
    chainIds: number[]
  }
): Wallet[] {
  const chainIds = validateChains(options.chainIds)
  const result: Wallet[] = []

  for (const raw of options.accounts) {
    if (!isAddress(raw)) continue
    const address = getAddress(raw)

    const existing = store.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
    if (existing) {
      const updated = store.updateWallet(existing.id, {
        kind: options.kind,
        connectionId: options.connectionId,
        providerName: options.providerName,
        chainIds,
        archived: false
      })
      if (updated) result.push(updated)
      continue
    }

    if (store.wallets.length >= MAX_WALLETS) throw new WalletLimitError(MAX_WALLETS)

    const wallet: Wallet = {
      id: randomUUID(),
      label: `${options.providerName} ${address.slice(0, 6)}`,
      kind: options.kind,
      address,
      // The key is in the user's own wallet app; we have no owner to derive.
      ownerAddress: null,
      derivationIndex: null,
      salt: '0x',
      chainIds,
      // An EOA needs no deployment, so it is live everywhere it is connected.
      deployedOn: chainIds,
      enabledTokens: [],
      color: WALLET_COLORS[store.wallets.length % WALLET_COLORS.length],
      createdAt: Date.now(),
      archived: false,
      connectionId: options.connectionId,
      providerName: options.providerName
    }
    store.addWallet(wallet)
    result.push(wallet)
  }

  return result
}

/** Mark every wallet belonging to a dropped connection as unable to sign. */
export function detachConnection(store: Store, connectionId: string): number {
  let count = 0
  for (const wallet of store.wallets) {
    if (wallet.connectionId !== connectionId) continue
    store.updateWallet(wallet.id, { connectionId: null })
    count++
  }
  return count
}

/**
 * Re-derive every smart wallet's address from the seed. Run after unlocking so
 * a vault restored on another machine rebuilds identical addresses, and any
 * drift (a changed factory constant, a corrupted state file) is corrected.
 */
export function reconcileWallets(store: Store, vault: Vault): { repaired: number } {
  let repaired = 0
  for (const wallet of store.wallets) {
    if (wallet.kind !== 'smart' || wallet.derivationIndex === null) continue
    const owner = vault.ownerAddress(wallet.derivationIndex)
    const saltNonce = BigInt(wallet.derivationIndex)
    const address = predictAccountAddress(owner, saltNonce)
    if (address !== wallet.address || owner !== wallet.ownerAddress) {
      store.updateWallet(wallet.id, { address, ownerAddress: owner, salt: accountSalt(owner, saltNonce) })
      repaired++
    }
  }
  return { repaired }
}

/**
 * Rebuild the wallet list from a restored seed phrase. Used when a user
 * reinstalls the app and has their seed but not their state file.
 */
export function recoverWallets(store: Store, vault: Vault, count: number): Wallet[] {
  const safeCount = Math.max(1, Math.min(count, MAX_WALLETS))
  store.raw.wallets = []
  return connectSmartWallets(store, vault, { count: safeCount, chainIds: DEFAULT_CHAIN_IDS })
}
