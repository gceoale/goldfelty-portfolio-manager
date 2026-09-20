import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type {
  AppStatus,
  Chain,
  HistoryRange,
  Portfolio,
  Result,
  Settings,
  TokenDef,
  TransferRecord,
  Wallet
} from '@shared/types.js'
import type { Toast } from '../components/ui.js'

interface AppState {
  status: AppStatus | null
  settings: Settings | null
  wallets: Wallet[]
  portfolio: Portfolio | null
  transfers: TransferRecord[]
  chains: Chain[]
  tokens: TokenDef[]
  maxWallets: number
  range: HistoryRange
  loading: boolean
  refreshing: boolean
  toasts: Toast[]
  setRange: (range: HistoryRange) => void
  refreshStatus: () => Promise<void>
  refreshWallets: () => Promise<void>
  refreshPortfolio: (range?: HistoryRange) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  notify: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  /** Unwrap an IPC result, surfacing failures as a toast and returning null. */
  run: <T>(promise: Promise<Result<T>>, errorTitle?: string) => Promise<T | null>
}

const Context = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Context)
  if (!value) throw new Error('useApp must be used inside <AppProvider>')
  return value
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [transfers, setTransfers] = useState<TransferRecord[]>([])
  const [chains, setChains] = useState<Chain[]>([])
  const [tokens, setTokens] = useState<TokenDef[]>([])
  const [maxWallets, setMaxWallets] = useState(256)
  const [range, setRange] = useState<HistoryRange>('24h')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const inFlight = useRef(false)

  const notify = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((current) => [...current, { ...toast, id }])
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const run = useCallback(
    async <T,>(promise: Promise<Result<T>>, errorTitle = 'Something went wrong'): Promise<T | null> => {
      try {
        const result = await promise
        if (result.ok) return result.data
        notify({ tone: 'error', title: errorTitle, text: result.error })
        return null
      } catch (error) {
        notify({ tone: 'error', title: errorTitle, text: (error as Error).message })
        return null
      }
    },
    [notify]
  )

  const refreshStatus = useCallback(async () => {
    const next = await run(window.goldfelty.app.status(), 'Could not read app status')
    if (next) setStatus(next)
  }, [run])

  const refreshWallets = useCallback(async () => {
    const next = await run(window.goldfelty.wallets.list(), 'Could not load wallets')
    if (next) setWallets(next)
  }, [run])

  const refreshPortfolio = useCallback(
    async (nextRange?: HistoryRange) => {
      // A refresh already running means the answer is seconds away; a second
      // pass would just double the RPC load for a 50-wallet portfolio.
      if (inFlight.current) return
      inFlight.current = true
      setRefreshing(true)
      try {
        const result = await window.goldfelty.portfolio.load(nextRange ?? range)
        if (result.ok) {
          setPortfolio(result.data)
        } else if (result.code !== 'LOCKED') {
          notify({ tone: 'error', title: 'Could not refresh balances', text: result.error })
        }
        const history = await window.goldfelty.portfolio.transfers()
        if (history.ok) setTransfers(history.data)
      } finally {
        inFlight.current = false
        setRefreshing(false)
      }
    },
    [range, notify]
  )

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await run(window.goldfelty.settings.update(patch), 'Could not save that setting')
      if (next) setSettings(next)
    },
    [run]
  )

  // ---- boot --------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      const [statusResult, settingsResult, reference] = await Promise.all([
        window.goldfelty.app.status(),
        window.goldfelty.settings.get(),
        window.goldfelty.app.reference()
      ])
      if (statusResult.ok) setStatus(statusResult.data)
      if (settingsResult.ok) setSettings(settingsResult.data)
      if (reference.ok) {
        setChains(reference.data.chains)
        setTokens(reference.data.tokens)
        setMaxWallets(reference.data.maxWallets)
      }
      setLoading(false)
    })()
  }, [])

  // ---- main-process events ----------------------------------------------
  useEffect(() => {
    const unsubscribers = [
      window.goldfelty.events.onLocked(() => {
        setStatus((current) => (current ? { ...current, locked: true } : current))
        setPortfolio(null)
      }),
      window.goldfelty.events.onUnlocked(() => {
        void refreshStatus()
        void refreshWallets()
      }),
      window.goldfelty.events.onSettingsChanged((next) => setSettings(next)),
      window.goldfelty.events.onPortfolioInvalidate(() => void refreshPortfolio())
    ]
    return () => unsubscribers.forEach((off) => off())
  }, [refreshStatus, refreshWallets, refreshPortfolio])

  // ---- load data once unlocked ------------------------------------------
  const unlocked = status !== null && !status.locked && status.initialized
  useEffect(() => {
    if (!unlocked) return
    void refreshWallets()
    void refreshPortfolio()
    // refreshPortfolio is intentionally left out: it changes with `range`,
    // which has its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked])

  useEffect(() => {
    if (!unlocked) return
    void refreshPortfolio(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  // ---- periodic refresh --------------------------------------------------
  useEffect(() => {
    if (!unlocked || !settings) return
    const seconds = Math.max(15, settings.refreshIntervalSeconds)
    const timer = setInterval(() => void refreshPortfolio(), seconds * 1000)
    return () => clearInterval(timer)
  }, [unlocked, settings, refreshPortfolio])

  // ---- theme -------------------------------------------------------------
  useEffect(() => {
    if (!settings) return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      const resolved = settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme
      document.documentElement.dataset.theme = resolved
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])

  // ---- activity ping for auto-lock --------------------------------------
  useEffect(() => {
    let last = 0
    const ping = (): void => {
      const now = Date.now()
      // Throttle: the main process only needs to know the user is alive.
      if (now - last < 20_000) return
      last = now
      void window.goldfelty.app.touch()
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'focus']
    events.forEach((event) => window.addEventListener(event, ping))
    return () => events.forEach((event) => window.removeEventListener(event, ping))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      status,
      settings,
      wallets,
      portfolio,
      transfers,
      chains,
      tokens,
      maxWallets,
      range,
      loading,
      refreshing,
      toasts,
      setRange,
      refreshStatus,
      refreshWallets,
      refreshPortfolio,
      updateSettings,
      notify,
      dismiss,
      run
    }),
    [
      status,
      settings,
      wallets,
      portfolio,
      transfers,
      chains,
      tokens,
      maxWallets,
      range,
      loading,
      refreshing,
      toasts,
      refreshStatus,
      refreshWallets,
      refreshPortfolio,
      updateSettings,
      notify,
      dismiss,
      run
    ]
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}
