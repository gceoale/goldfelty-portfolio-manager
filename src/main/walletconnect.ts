import { randomUUID } from 'node:crypto'
import { getAddress } from 'ethers'
// Named import, not default: under ESM the default export resolves to the
// CJS namespace object, whose `.init` is undefined. The named export is the
// class. Getting this wrong fails only at runtime, on the first connect.
import { SignClient } from '@walletconnect/sign-client'

/** The instance type, derived from the factory since the export is a value. */
type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>
import type { PendingConnection, WalletConnection } from '../shared/types.ts'
import { CHAINS } from '../shared/chains.ts'

/**
 * WalletConnect v2 — the link to wallets the user already owns.
 *
 * Goldfelty is the dapp side of the protocol: it proposes a session, the user
 * approves it in MetaMask / Rainbow / Phantom / whatever they use, and from
 * then on every transaction is *requested*, never signed here. No key material
 * for these wallets ever reaches this process, which is the entire point.
 */

const METADATA = {
  name: 'Goldfelty Portfolio Manager',
  description: 'Multi-wallet smart-account portfolio manager',
  url: 'https://goldfelty.com',
  icons: ['https://goldfelty.com/icon.png']
}

/** How long a pairing QR stays valid before the user has to start again. */
const PAIRING_TTL_MS = 5 * 60_000

/**
 * The project ID shipped with the build.
 *
 * A WalletConnect project ID identifies *this application* to the relay, not
 * the person using it — it is a public client identifier, in the same category
 * as an RPC key embedded in a web frontend, and is not a secret. One is baked
 * in at build time so the app works out of the box; expecting every user to
 * register their own developer account before they can connect a wallet would
 * be an absurd thing to ask.
 *
 * Goldfelty's own ID is the default below. Committing it leaks nothing: it is
 * compiled into every binary we publish, so anyone who wants it can read it
 * out of a download. Keeping it in source means forks and local builds work
 * without ceremony.
 *
 * Override it at build time with MAIN_VITE_WALLETCONNECT_PROJECT_ID (the
 * release workflow reads a WALLETCONNECT_PROJECT_ID repository variable, so
 * the ID can be rotated without touching code), or per install from
 * Settings → Wallets for anyone who would rather use their own relay quota.
 */
const DEFAULT_PROJECT_ID = '45a3a9aee7eef2930bc09bfb38507bc8'

const BUILT_IN_PROJECT_ID: string =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.MAIN_VITE_WALLETCONNECT_PROJECT_ID ||
    process.env.GOLDFELTY_WALLETCONNECT_PROJECT_ID ||
    DEFAULT_PROJECT_ID).trim()

export class WalletConnectNotConfiguredError extends Error {
  code = 'WC_NO_PROJECT_ID'
  constructor() {
    super(
      'WalletConnect needs a project ID before it can reach any wallet. Create a free one at cloud.reown.com and paste it into Settings → Wallets.'
    )
  }
}

export class WalletConnectService {
  private client: SignClientInstance | null = null
  private initPromise: Promise<SignClientInstance> | null = null
  /** A user-supplied override, if they set one. */
  private override: string | null = null
  private readonly connections = new Map<string, WalletConnection>()
  private onChange: (() => void) | null = null

  constructor(private readonly storagePath: string) {}

  setProjectId(projectId: string | null): void {
    const next = projectId?.trim() || null
    if (next === this.override) return
    this.override = next
    // The client is bound to a project ID, so it has to be rebuilt.
    this.client = null
    this.initPromise = null
  }

  /** The override when the user set one, otherwise whatever shipped. */
  private get projectId(): string | null {
    return this.override || BUILT_IN_PROJECT_ID || null
  }

  get configured(): boolean {
    return !!this.projectId
  }

  /** True when the build shipped an ID, so the user need not supply one. */
  get hasBuiltIn(): boolean {
    return BUILT_IN_PROJECT_ID.length > 0
  }

  onConnectionsChanged(fn: () => void): void {
    this.onChange = fn
  }

  private notify(): void {
    this.onChange?.()
  }

  private async ensureClient(): Promise<SignClientInstance> {
    if (!this.projectId) throw new WalletConnectNotConfiguredError()
    if (this.client) return this.client
    if (!this.initPromise) {
      this.initPromise = SignClient.init({
        projectId: this.projectId,
        metadata: METADATA,
        storageOptions: { database: `${this.storagePath}/walletconnect.db` }
      }).then((client) => {
        this.client = client
        this.bind(client)
        this.adoptExistingSessions(client)
        return client
      })
    }
    return this.initPromise
  }

  private bind(client: SignClientInstance): void {
    client.on('session_delete', ({ topic }) => {
      this.markInactive(topic)
    })
    client.on('session_expire', ({ topic }) => {
      this.markInactive(topic)
    })
    client.on('session_update', ({ topic, params }) => {
      const connection = [...this.connections.values()].find((c) => c.topic === topic)
      if (!connection) return
      const { accounts, chainIds } = readNamespaces(params.namespaces)
      connection.accounts = accounts
      connection.chainIds = chainIds
      this.notify()
    })
  }

  /** Sessions survive restarts, so pick up anything the client already holds. */
  private adoptExistingSessions(client: SignClientInstance): void {
    for (const session of client.session.getAll()) {
      this.record(session)
    }
    if (client.session.getAll().length > 0) this.notify()
  }

  private record(session: {
    topic: string
    peer: { metadata: { name: string; icons: string[] } }
    namespaces: Record<string, unknown>
    expiry: number
  }): WalletConnection {
    const { accounts, chainIds } = readNamespaces(session.namespaces as never)
    const existing = [...this.connections.values()].find((c) => c.topic === session.topic)
    const connection: WalletConnection = {
      id: existing?.id ?? randomUUID(),
      kind: 'walletconnect',
      name: session.peer.metadata.name || 'Wallet',
      icon: session.peer.metadata.icons?.[0] ?? null,
      accounts,
      chainIds,
      connectedAt: existing?.connectedAt ?? Date.now(),
      active: true,
      topic: session.topic
    }
    this.connections.set(connection.id, connection)
    return connection
  }

  private markInactive(topic: string): void {
    for (const connection of this.connections.values()) {
      if (connection.topic === topic) connection.active = false
    }
    this.notify()
  }

  list(): WalletConnection[] {
    return [...this.connections.values()]
  }

  get(id: string): WalletConnection | undefined {
    return this.connections.get(id)
  }

  /**
   * Begin a connection. Returns the pairing URI immediately so the UI can show
   * a QR code, and resolves `approved` once the user accepts in their wallet.
   */
  async connect(chainIds: number[]): Promise<{ pending: PendingConnection; approved: Promise<WalletConnection> }> {
    const client = await this.ensureClient()
    const chains = (chainIds.length > 0 ? chainIds : CHAINS.map((c) => c.id)).map((id) => `eip155:${id}`)

    const { uri, approval } = await client.connect({
      // Required namespaces are a hard gate: a wallet that cannot do all of
      // this refuses outright. Keep it to one chain and ask for the rest as
      // optional, so a single-chain wallet can still connect.
      requiredNamespaces: {
        eip155: {
          methods: ['eth_sendTransaction', 'personal_sign'],
          chains: [chains[0]],
          events: ['chainChanged', 'accountsChanged']
        }
      },
      optionalNamespaces: {
        eip155: {
          methods: ['eth_signTypedData_v4', 'eth_sign', 'wallet_switchEthereumChain'],
          chains,
          events: ['chainChanged', 'accountsChanged']
        }
      }
    })

    if (!uri) throw new Error('WalletConnect did not return a pairing URI.')

    const approved = approval().then((session) => {
      const connection = this.record(session as never)
      this.notify()
      return connection
    })

    return {
      pending: { uri, expiresAt: Date.now() + PAIRING_TTL_MS },
      approved
    }
  }

  /** Ask the connected wallet to send a transaction. It signs, not us. */
  async sendTransaction(
    connectionId: string,
    chainId: number,
    tx: { from: string; to: string; value?: string; data?: string }
  ): Promise<string> {
    const connection = this.connections.get(connectionId)
    if (!connection || !connection.topic) throw new Error('That wallet is no longer connected.')
    if (!connection.active) throw new Error(`${connection.name} has disconnected. Reconnect it in Settings.`)

    const client = await this.ensureClient()
    const hash = await client.request<string>({
      topic: connection.topic,
      chainId: `eip155:${chainId}`,
      request: { method: 'eth_sendTransaction', params: [tx] }
    })
    return hash
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    if (connection.topic && this.client) {
      try {
        await this.client.disconnect({
          topic: connection.topic,
          reason: { code: 6000, message: 'User disconnected' }
        })
      } catch {
        // The session may already be gone on the wallet's side; drop it either way.
      }
    }
    this.connections.delete(connectionId)
    this.notify()
  }
}

/** Pull the agreed accounts and chains out of a session's namespaces. */
function readNamespaces(namespaces: Record<string, { accounts?: string[] }>): {
  accounts: string[]
  chainIds: number[]
} {
  const accounts = new Set<string>()
  const chainIds = new Set<number>()
  for (const namespace of Object.values(namespaces ?? {})) {
    for (const entry of namespace?.accounts ?? []) {
      // Entries look like "eip155:1:0xabc…".
      const [, chain, address] = entry.split(':')
      if (!chain || !address) continue
      try {
        accounts.add(getAddress(address))
        chainIds.add(Number(chain))
      } catch {
        // Skip anything that is not a valid EVM address.
      }
    }
  }
  return { accounts: [...accounts], chainIds: [...chainIds].filter((id) => Number.isFinite(id)) }
}
