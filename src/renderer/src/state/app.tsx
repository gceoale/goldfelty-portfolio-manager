import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  AppStatus,
  Chain,
  HistoryRange,
  Portfolio,
  Result,
  Settings,
  TokenDef,
  TransferRecord,
  Wallet,
  WalletConnection
} from '@shared/types.ts'
import type { RegistryWallet } from '@shared/walletRegistry.ts'

export interface Toast {
  id: number
  tone: 'info' | 'good' | 'bad'
  title: string
  body?: string
}

export interface FeeInfo {
  enabled: boolean
  bps: number
  recipient: string | null
}

export type Page =
  | { name: 'overview' }
  | { name: 'activity' }
  | { name: 'send'; symbol?: string }
  | { name: 'receive'; symbol?: string }
  | { name: 'wallet'; id: string }
  | { name: 'settings' }

interface AppState {
  status: AppStatus | null
  settings: Settings | null
  wallets: Wallet[]
  connections: WalletConnection[]
  portfolio: Portfolio | null
  transfers: TransferRecord[]
  chains: Chain[]
  tokens: TokenDef[]
  registry: RegistryWallet[]
  fee: FeeInfo | null
  range: HistoryRange
  refreshing: boolean
  page: Page
  connectOpen: boolean
  toasts: Toast[]
  go: (page: Page) => void
  openConnect: (open: boolean) => void
  setRange: (range: HistoryRange) => void
  refreshStatus: () => Promise<AppStatus | null>
  refreshData: () => Promise<void>
  refreshPortfolio: (range?: HistoryRange) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>
  notify: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  /** Unwrap an IPC result. Failures become a toast (unless `quiet`) and null. */
  run: <T>(promise: Promise<Result<T>>, failTitle?: string | null) => Promise<T | null>
}

const Context = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Context)
  if (!value) throw new Error('useApp must be used inside <AppProvider>')
  return value
}

const api = window.goldfelty

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [connections, setConnections] = useState<WalletConnection[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [transfers, setTransfers] = useState<TransferRecord[]>([])
  const [chains, setChains] = useState<Chain[]>([])
  const [tokens, setTokens] = useState<TokenDef[]>([])
  const [registry, setRegistry] = useState<RegistryWallet[]>([])
  const [fee, setFee] = useState<FeeInfo | null>(null)
  const [range, setRangeState] = useState<HistoryRange>('30d')
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState<Page>({ name: 'overview' })
  const [connectOpen, openConnect] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const loadingPortfolio = useRef(false)
  const rangeRef = useRef(range)

  const notify = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((current) => [...current.slice(-3), { ...toast, id }])
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), toast.tone === 'bad' ? 9000 : 5000)
  }, [])

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((t) => t.id !== id)), [])

  const run = useCallback(
    async <T,>(promise: Promise<Result<T>>, failTitle: string | null = 'That didn’t work'): Promise<T | null> => {
      const result = await promise
      if (result.ok) return result.data
      if (result.code === 'LOCKED') {
        setStatus((s) => (s ? { ...s, locked: true } : s))
        return null
      }
      if (failTitle !== null) notify({ tone: 'bad', title: failTitle, body: result.error })
      return null
    },
    [notify]
  )

  const refreshStatus = useCallback(async () => {
    const result = await api.app.status()
    if (result.ok) setStatus(result.data)
    return result.ok ? result.data : null
  }, [])

  const refreshPortfolio = useCallback(
    async (next?: HistoryRange) => {
      if (loadingPortfolio.current) return
      loadingPortfolio.current = true
      setRefreshing(true)
      try {
        const [p, t] = await Promise.all([api.portfolio.load(next ?? rangeRef.current), api.portfolio.transfers()])
        if (p.ok) setPortfolio(p.data)
        if (t.ok) setTransfers(t.data)
      } finally {
        loadingPortfolio.current = false
        setRefreshing(false)
      }
    },
    []
  )

  const refreshData = useCallback(async () => {
    const [s, w, c, f] = await Promise.all([api.settings.get(), api.wallets.list(), api.connections.list(), api.app.feeInfo()])
    if (s.ok) setSettings(s.data)
    if (w.ok) setWallets(w.data)
    if (c.ok) setConnections(c.data)
    if (f.ok) setFee(f.data)
  }, [])

  const setRange = useCallback(
    (next: HistoryRange) => {
      rangeRef.current = next
      setRangeState(next)
      void refreshPortfolio(next)
    },
    [refreshPortfolio]
  )

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await run(api.settings.update(patch), 'Couldn’t save that setting')
      if (next) setSettings(next)
      return next !== null
    },
    [run]
  )

  const go = useCallback((next: Page) => setPage(next), [])

  // Reference data and first status.
  useEffect(() => {
    void (async () => {
      const ref = await api.app.reference()
      if (ref.ok) {
        setChains(ref.data.chains)
        setTokens(ref.data.tokens)
        setRegistry(ref.data.registry)
      }
      await refreshStatus()
    })()
  }, [refreshStatus])

  const unlocked = !!status && !status.locked

  // Everything else loads once unlocked, and is dropped on lock.
  useEffect(() => {
    if (!unlocked) {
      setSettings(null)
      setWallets([])
      setConnections([])
      setPortfolio(null)
      setTransfers([])
      openConnect(false)
      return
    }
    void refreshData().then(() => refreshPortfolio())
  }, [unlocked, refreshData, refreshPortfolio])

  // Events from the main process.
  useEffect(() => {
    const offs = [
      api.events.onLocked(() => void refreshStatus()),
      api.events.onUnlocked(() => void refreshStatus()),
      api.events.onSettingsChanged((s) => setSettings(s)),
      api.events.onPortfolioInvalidate(() => {
        void api.wallets.list().then((w) => w.ok && setWallets(w.data))
        void refreshPortfolio()
      }),
      api.events.onConnectionsChanged(() => {
        void api.connections.list().then((c) => c.ok && setConnections(c.data))
        void api.wallets.list().then((w) => w.ok && setWallets(w.data))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [refreshStatus, refreshPortfolio])

  // Periodic refresh while unlocked.
  useEffect(() => {
    if (!unlocked || !settings) return
    const timer = setInterval(() => void refreshPortfolio(), Math.max(15, settings.refreshIntervalSeconds) * 1000)
    return () => clearInterval(timer)
  }, [unlocked, settings, refreshPortfolio])

  // Real input keeps auto-lock away; nothing else does.
  useEffect(() => {
    if (!unlocked) return
    let last = 0
    const touch = (): void => {
      const now = Date.now()
      if (now - last < 20_000) return
      last = now
      void api.app.touch()
    }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, touch))
  }, [unlocked])

  const value = useMemo<AppState>(
    () => ({
      status,
      settings,
      wallets,
      connections,
      portfolio,
      transfers,
      chains,
      tokens,
      registry,
      fee,
      range,
      refreshing,
      page,
      connectOpen,
      toasts,
      go,
      openConnect,
      setRange,
      refreshStatus,
      refreshData,
      refreshPortfolio,
      updateSettings,
      notify,
      dismiss,
      run
    }),
    [status, settings, wallets, connections, portfolio, transfers, chains, tokens, registry, fee, range, refreshing, page, connectOpen, toasts, go, setRange, refreshStatus, refreshData, refreshPortfolio, updateSettings, notify, dismiss, run]
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}
