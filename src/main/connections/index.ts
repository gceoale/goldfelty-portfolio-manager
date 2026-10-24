import { getAddress, isAddress } from 'ethers'
import { BrowserBridge, WalletRequestError } from './browserBridge.ts'
import { FrameConnector, FrameUnavailableError } from './frame.ts'
import { WalletConnectService, wcConnectionId } from './walletconnect.ts'
import { REGISTRY_BY_ID, FRAME_ID, providerIdFor } from '../../shared/walletRegistry.ts'
import { getChain } from '../../shared/chains.ts'
import type { ConnectStage, DetectedWallet, PendingConnection, WalletConnection } from '../../shared/types.ts'

/**
 * One interface over the three ways Goldfelty reaches a wallet.
 *
 * Callers ask for a connection by id and a request goes to the right place:
 * the browser bridge, Frame's socket, or the WalletConnect relay. Nothing
 * here holds a key. Every transaction and signature is approved in the
 * wallet's own interface.
 */

export type { ConnectStage }

export class NotInstalledError extends Error {
  code = 'NOT_INSTALLED'
  readonly homepage: string | null
  constructor(name: string, homepage: string | null) {
    super(`${name} isn’t installed in that browser.`)
    this.homepage = homepage
  }
}

export class ChainMismatchError extends Error {
  code = 'CHAIN_MISMATCH'
  constructor(wallet: string, chain: string) {
    super(`${wallet} is on a different network and didn’t switch to ${chain}. Nothing was sent.`)
  }
}

export interface ConnectionStore {
  readonly connections: WalletConnection[]
  connection(id: string): WalletConnection | undefined
  upsertConnection(connection: WalletConnection): void
  removeConnection(id: string): void
}

export const browserConnectionId = (rdns: string): string => `browser:${rdns}`
export const FRAME_CONNECTION_ID = 'frame'

export class ConnectionManager {
  readonly bridge = new BrowserBridge()
  readonly frame: FrameConnector
  readonly walletConnect: WalletConnectService
  private store: ConnectionStore | null = null
  private readonly listeners = new Set<() => void>()

  private readonly openUrl: (url: string) => Promise<void>

  constructor(dataDir: string, openUrl: (url: string) => Promise<void>, frame?: FrameConnector) {
    this.openUrl = openUrl
    this.frame = frame ?? new FrameConnector()
    this.walletConnect = new WalletConnectService(dataDir)
    this.bridge.onChange(() => this.changed())
    this.walletConnect.onChange(() => this.changed())
    this.frame.onEvent((type, data) => {
      if (type === 'accountsChanged') this.updateAccounts(FRAME_CONNECTION_ID, data)
      this.changed()
    })
    this.bridge.onWalletEvent((event) => {
      if (event.type === 'accountsChanged') this.updateAccounts(browserConnectionId(event.rdns), event.data)
      this.changed()
    })
  }

  /** The store is only available while unlocked. */
  attach(store: ConnectionStore | null): void {
    this.store = store
    this.changed()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  isActive(connection: WalletConnection): boolean {
    switch (connection.kind) {
      case 'browser':
        return !!connection.rdns && this.bridge.hasProvider(connection.rdns)
      case 'frame':
        return this.frame.active
      case 'walletconnect':
        return !!connection.topic && this.walletConnect.isActive(connection.topic)
    }
  }

  list(): WalletConnection[] {
    return (this.store?.connections ?? []).map((c) => ({ ...c, active: this.isActive(c) }))
  }

  detected(): DetectedWallet[] {
    return this.bridge.detected()
  }

  private updateAccounts(connectionId: string, data: unknown): void {
    const existing = this.store?.connection(connectionId)
    if (!existing || !Array.isArray(data)) return
    const accounts = data.filter((a): a is string => typeof a === 'string' && isAddress(a)).map((a) => getAddress(a))
    if (accounts.length) this.store?.upsertConnection({ ...existing, accounts })
  }

  /** A fresh one-time bridge link, starting the bridge if needed. */
  async bridgeLink(): Promise<string> {
    await this.bridge.start()
    return this.bridge.issueLink()!
  }

  /**
   * Connect a browser wallet. If no Goldfelty tab is open yet, opens one in
   * the default browser and waits for the wallet to announce itself there.
   */
  async connectBrowser(providerId: string, progress: (stage: ConnectStage) => void): Promise<WalletConnection> {
    await this.bridge.start()
    const entry = REGISTRY_BY_ID.get(providerId)
    const name = entry?.name ?? this.detected().find((d) => d.providerId === providerId)?.name ?? 'your wallet'

    // Anything already announced under this id wins, whatever its rdns.
    let found = this.detected().find((d) => d.providerId === providerId)
    if (!found) {
      const rdns = entry?.rdns ?? [providerId]
      this.bridge.setWanted({ rdns, name, homepage: entry?.homepage ?? null })
      try {
        if (this.bridge.status().pages === 0) {
          progress({ stage: 'opening-browser', wallet: name })
          await this.openUrl(this.bridge.issueLink()!)
        }
        progress({ stage: 'waiting-for-tab', wallet: name })
        const result = await this.waitForMatch(providerId, rdns, 5 * 60_000)
        if (result === 'missing') throw new NotInstalledError(name, entry?.homepage ?? null)
        if (!result) throw new WalletRequestError('No Goldfelty tab opened in time. Try again.', 'TIMEOUT')
        found = result
      } finally {
        this.bridge.setWanted(null)
      }
    }

    progress({ stage: 'approve-in-wallet', wallet: found.name })
    const accounts = await this.bridge.request(found.rdns, found.name, 'eth_requestAccounts', [])
    const chainHex = await this.bridge.request(found.rdns, found.name, 'eth_chainId', []).catch(() => null)
    const connection: WalletConnection = {
      id: browserConnectionId(found.rdns),
      kind: 'browser',
      family: 'evm',
      name: found.name,
      providerId: found.providerId,
      rdns: found.rdns,
      icon: found.icon,
      accounts: normaliseAccounts(accounts),
      chainIds: chainHex ? [Number(chainHex)] : [],
      connectedAt: Date.now(),
      active: true,
      topic: null
    }
    if (!connection.accounts.length) throw new WalletRequestError(`${found.name} didn’t share any accounts.`, 'NO_ACCOUNTS')
    this.store?.upsertConnection(connection)
    return connection
  }

  /** Wait for a tab to announce the wallet, by registry id or rdns. */
  private async waitForMatch(providerId: string, rdns: string[], timeoutMs: number): Promise<DetectedWallet | 'missing' | null> {
    const direct = await this.bridge.waitForProvider(rdns, timeoutMs)
    if (direct && direct !== 'missing') return direct
    // The registry rdns may be stale; a name match still counts.
    const byName = this.detected().find((d) => providerIdFor(d.rdns, d.name) === providerId)
    return byName ?? direct
  }

  async detectFrame(): Promise<boolean> {
    return this.frame.detect()
  }

  async connectFrame(progress: (stage: ConnectStage) => void): Promise<WalletConnection> {
    if (!(await this.frame.detect())) throw new FrameUnavailableError()
    progress({ stage: 'approve-in-wallet', wallet: 'Frame' })
    const accounts = normaliseAccounts(await this.frame.request('eth_requestAccounts'))
    const chainHex = await this.frame.request('eth_chainId').catch(() => null)
    if (!accounts.length) throw new WalletRequestError('Frame didn’t share any accounts.', 'NO_ACCOUNTS')
    const connection: WalletConnection = {
      id: FRAME_CONNECTION_ID,
      kind: 'frame',
      family: 'evm',
      name: 'Frame',
      providerId: FRAME_ID,
      rdns: null,
      icon: null,
      accounts,
      chainIds: chainHex ? [Number(chainHex)] : [],
      connectedAt: Date.now(),
      active: true,
      topic: null
    }
    this.store?.upsertConnection(connection)
    return connection
  }

  async connectWalletConnect(chainIds: number[]): Promise<{ pending: PendingConnection; approved: Promise<WalletConnection> }> {
    const { pending, approved } = await this.walletConnect.connect(chainIds)
    return {
      pending,
      approved: approved.then((connection) => {
        this.store?.upsertConnection(connection)
        return connection
      })
    }
  }

  private get(id: string): WalletConnection {
    const connection = this.store?.connection(id)
    if (!connection) throw new WalletRequestError('That wallet is no longer connected.', 'NO_CONNECTION')
    return connection
  }

  /** A raw EIP-1193 request, sent to wherever this connection lives. */
  async request(connectionId: string, method: string, params: unknown[], chainId?: number): Promise<unknown> {
    const connection = this.get(connectionId)
    switch (connection.kind) {
      case 'browser':
        return this.bridge.request(connection.rdns!, connection.name, method, params)
      case 'frame':
        return this.frame.request(method, params)
      case 'walletconnect':
        return this.walletConnect.request(connection.topic!, chainId ?? connection.chainIds[0] ?? 1, method, params)
    }
  }

  /**
   * Make sure the wallet is on `chainId` before anything is sent.
   *
   * Browser wallets and Frame send on whatever network they are currently
   * on. Skipping this would broadcast a Base transfer on mainnet, to a token
   * address that means something else there. After switching, the network is
   * read back, and nothing proceeds unless it matches.
   */
  async ensureChain(connectionId: string, chainId: number): Promise<void> {
    const connection = this.get(connectionId)
    if (connection.kind === 'walletconnect') return // chain travels with each request
    const chain = getChain(chainId)
    const hex = `0x${chainId.toString(16)}`
    const current = Number(await this.request(connectionId, 'eth_chainId', []))
    if (current === chainId) return

    try {
      await this.request(connectionId, 'wallet_switchEthereumChain', [{ chainId: hex }])
    } catch (error) {
      const code = (error as { code?: number | string }).code
      if (code === 4902 || code === '4902' || /unrecognized|not added|unknown chain/i.test(String((error as Error).message))) {
        await this.request(connectionId, 'wallet_addEthereumChain', [
          {
            chainId: hex,
            chainName: chain.name,
            nativeCurrency: { name: chain.nativeName, symbol: chain.nativeSymbol, decimals: chain.decimals },
            rpcUrls: chain.rpcUrls,
            blockExplorerUrls: [chain.explorer]
          }
        ])
      } else {
        throw error
      }
    }

    const after = Number(await this.request(connectionId, 'eth_chainId', []))
    if (after !== chainId) throw new ChainMismatchError(connection.name, chain.name)
  }

  async sendTransaction(
    connectionId: string,
    chainId: number,
    tx: { from: string; to: string; value?: string; data?: string }
  ): Promise<string> {
    await this.ensureChain(connectionId, chainId)
    // chainId rides along as well: wallets that check it refuse a mismatch
    // outright, which is a second line of defence behind ensureChain.
    const hash = await this.request(connectionId, 'eth_sendTransaction', [{ ...tx, chainId: `0x${chainId.toString(16)}` }], chainId)
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WalletRequestError('The wallet returned something that isn’t a transaction hash.', 'BAD_HASH')
    }
    return hash
  }

  /** personal_sign over UTF-8 text, sent hex-encoded so every wallet agrees on the bytes. */
  async signMessage(connectionId: string, address: string, message: string): Promise<string> {
    const hex = `0x${Buffer.from(message, 'utf8').toString('hex')}`
    const signature = await this.request(connectionId, 'personal_sign', [hex, address])
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new WalletRequestError('The wallet returned something that isn’t a signature.', 'BAD_SIGNATURE')
    }
    return signature
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.store?.connection(connectionId)
    if (connection?.kind === 'walletconnect' && connection.topic) await this.walletConnect.disconnect(connection.topic)
    this.store?.removeConnection(connectionId)
    this.changed()
  }

  async shutdown(): Promise<void> {
    this.frame.close()
    await this.bridge.stop()
  }
}

export { wcConnectionId }

function normaliseAccounts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((a): a is string => typeof a === 'string' && isAddress(a)).map((a) => getAddress(a)))]
}
