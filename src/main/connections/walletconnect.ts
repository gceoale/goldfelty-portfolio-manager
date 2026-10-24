import { getAddress } from 'ethers'
// Named import, not default: under ESM the default export resolves to the CJS
// namespace object, whose `.init` is undefined. It typechecks either way and
// fails only at runtime, on the first connect.
import { SignClient } from '@walletconnect/sign-client'
import type { PendingConnection, WalletConnection } from '../../shared/types.ts'
import { CHAINS } from '../../shared/chains.ts'

type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>

/**
 * WalletConnect, for phone wallets only.
 *
 * Everything else Goldfelty reaches directly. A phone is the one place that
 * cannot work without a relay, so this is the single third-party service in
 * the connection layer, and the UI labels it as such.
 *
 * Connection ids are the session topic, which survives restarts. Earlier
 * versions minted a fresh id on every launch, which left wallets pointing at
 * a connection that no longer existed.
 */

const METADATA = {
  name: 'Goldfelty',
  description: 'Portfolio manager for the wallets you already use',
  url: 'https://goldfelty.com',
  icons: ['https://goldfelty.com/icon.png']
}

const PAIRING_TTL_MS = 5 * 60_000

/**
 * A project ID identifies this application to the relay, not the person using
 * it. It is a public client identifier compiled into every binary, so it lives
 * in source. MAIN_VITE_WALLETCONNECT_PROJECT_ID overrides it at build time and
 * Settings overrides it per install.
 */
const DEFAULT_PROJECT_ID = '45a3a9aee7eef2930bc09bfb38507bc8'

const BUILT_IN_PROJECT_ID: string = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.MAIN_VITE_WALLETCONNECT_PROJECT_ID ||
  process.env.GOLDFELTY_WALLETCONNECT_PROJECT_ID ||
  DEFAULT_PROJECT_ID
).trim()

export const wcConnectionId = (topic: string): string => `wc:${topic}`

export class WalletConnectService {
  private client: SignClientInstance | null = null
  private initPromise: Promise<SignClientInstance> | null = null
  private override: string | null = null
  private readonly sessions = new Map<string, WalletConnection>()
  private readonly listeners = new Set<() => void>()

  private readonly storagePath: string

  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  setProjectId(projectId: string | null): void {
    const next = projectId?.trim() || null
    if (next === this.override) return
    this.override = next
    this.client = null
    this.initPromise = null
  }

  private get projectId(): string | null {
    return this.override || BUILT_IN_PROJECT_ID || null
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  /** Bring up the client and adopt sessions from a previous run. */
  async resume(): Promise<void> {
    if (!this.projectId) return
    try {
      await this.ensureClient()
    } catch {
      // Offline or relay unreachable. Sessions stay listed as inactive.
    }
  }

  private async ensureClient(): Promise<SignClientInstance> {
    if (!this.projectId) throw new Error('WalletConnect has no project ID.')
    if (this.client) return this.client
    if (!this.initPromise) {
      this.initPromise = SignClient.init({
        projectId: this.projectId,
        metadata: METADATA,
        storageOptions: { database: `${this.storagePath}/walletconnect.db` }
      }).then(
        (client) => {
          this.client = client
          client.on('session_delete', ({ topic }) => this.markInactive(topic))
          client.on('session_expire', ({ topic }) => this.markInactive(topic))
          client.on('session_update', ({ topic, params }) => {
            const existing = this.sessions.get(topic)
            if (!existing) return
            const { accounts, chainIds } = readNamespaces(params.namespaces as never)
            this.sessions.set(topic, { ...existing, accounts, chainIds })
            this.changed()
          })
          for (const session of client.session.getAll()) this.record(session as never)
          this.changed()
          return client
        },
        (error) => {
          this.initPromise = null
          throw error
        }
      )
    }
    return this.initPromise
  }

  private record(session: {
    topic: string
    peer: { metadata: { name: string; icons: string[] } }
    namespaces: Record<string, { accounts?: string[] }>
  }): WalletConnection {
    const { accounts, chainIds } = readNamespaces(session.namespaces)
    const connection: WalletConnection = {
      id: wcConnectionId(session.topic),
      kind: 'walletconnect',
      name: session.peer.metadata.name || 'Phone wallet',
      providerId: 'walletconnect',
      rdns: null,
      // The peer's icon is a remote URL; we don't load remote images, so none.
      icon: null,
      accounts,
      chainIds,
      connectedAt: Date.now(),
      active: true,
      topic: session.topic
    }
    this.sessions.set(session.topic, connection)
    return connection
  }

  private markInactive(topic: string): void {
    const existing = this.sessions.get(topic)
    if (existing) this.sessions.set(topic, { ...existing, active: false })
    this.changed()
  }

  isActive(topic: string): boolean {
    return this.sessions.get(topic)?.active === true
  }

  async connect(chainIds: number[]): Promise<{ pending: PendingConnection; approved: Promise<WalletConnection> }> {
    const client = await this.ensureClient()
    const chains = (chainIds.length ? chainIds : CHAINS.map((c) => c.id)).map((id) => `eip155:${id}`)
    const { uri, approval } = await client.connect({
      // Require one chain and ask for the rest, so single-chain wallets can
      // still connect.
      requiredNamespaces: {
        eip155: { methods: ['eth_sendTransaction', 'personal_sign'], chains: [chains[0]], events: ['chainChanged', 'accountsChanged'] }
      },
      optionalNamespaces: {
        eip155: { methods: ['wallet_switchEthereumChain'], chains, events: ['chainChanged', 'accountsChanged'] }
      }
    })
    if (!uri) throw new Error('WalletConnect did not return a pairing link.')
    const approved = approval().then((session) => {
      const connection = this.record(session as never)
      this.changed()
      return connection
    })
    return { pending: { uri, expiresAt: Date.now() + PAIRING_TTL_MS }, approved }
  }

  async request(topic: string, chainId: number, method: string, params: unknown[]): Promise<unknown> {
    if (!this.isActive(topic)) throw new Error('That phone wallet has disconnected. Reconnect it in Settings.')
    const client = await this.ensureClient()
    return client.request({ topic, chainId: `eip155:${chainId}`, request: { method, params } })
  }

  async disconnect(topic: string): Promise<void> {
    this.sessions.delete(topic)
    if (this.client) {
      try {
        await this.client.disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } })
      } catch {
        // Already gone on the wallet's side.
      }
    }
    this.changed()
  }
}

function readNamespaces(namespaces: Record<string, { accounts?: string[] }>): { accounts: string[]; chainIds: number[] } {
  const accounts = new Set<string>()
  const chainIds = new Set<number>()
  for (const ns of Object.values(namespaces ?? {})) {
    for (const entry of ns?.accounts ?? []) {
      const [, chain, address] = entry.split(':')
      try {
        accounts.add(getAddress(address))
        chainIds.add(Number(chain))
      } catch {
        // not an EVM address
      }
    }
  }
  return { accounts: [...accounts], chainIds: [...chainIds].filter(Number.isFinite) }
}
