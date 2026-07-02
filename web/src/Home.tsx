import { Suspense, lazy, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Menu,
  Printer,
  RotateCw,
  Search as SearchIcon,
  Columns3,
  X as XIcon,
  Loader2,
  ZoomIn,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react'
import { ToastContext } from './contexts/ToastContext'
import { apiClient } from './api/client'
import { api } from './lib/api'
// TODO PS-257: SyncWorkerStatusDto is not exported by ./types/api (the worker
// status DTO was never added there). Until v4 grows a real worker contract it's
// aliased to `any` locally — matching the per-file DTO alias precedent used
// across the strict-typing migration pass.
type SyncWorkerStatusDto = any
import { useInitStores } from './hooks'
import PageSkeleton from './components/PageSkeleton'
import Sidebar from './components/Sidebar/Sidebar'
// Clients is the modern card-based page from ./pages/Clients (previously
// mounted as a standalone /clients route in App.tsx). It's lazy-loaded
// here so /inventory and the orders views don't pay its bundle cost on
// initial app boot — only operators who navigate to Clients fetch the
// chunk. Mounted inside Home's shell so the sidebar + topbar render
// alongside the cards.
const ClientsPage = lazy(() => import('./pages/Clients'))
const OrdersView = lazy(() => import('./components/Views/OrdersView'))
const DashboardView = lazy(() => import('./components/Views/DashboardView'))
const InventoryView = lazy(() => import('./components/Views/InventoryView'))
// 2026-05-13: LocationsView import removed from Home — the component
// now mounts inside SettingsView's Ship-From Locations tab. Old
// /locations URLs are redirected to /settings/locations by the
// useEffect inside this file.
// import LocationsView from './components/Views/LocationsView'
const PackagesView = lazy(() => import('./components/Views/PackagesView'))
const RatesView = lazy(() => import('./components/Views/RatesView'))
const AnalysisView = lazy(() => import('./components/Views/AnalysisView'))
const SettingsView = lazy(() => import('./components/Views/SettingsView'))
const BillingView = lazy(() => import('./components/Views/BillingView'))
const ManifestsView = lazy(() => import('./components/Views/ManifestsView'))
import { formatSyncPill } from './components/Views/orders-parity'
import { resolveOrdersDateRangeForFilter } from './components/Views/orders-date-query-contract'
import {
  INVENTORY_TAB_PATHS,
  pathToRoute,
  VALID_STATUSES,
  VIEW_PATHS,
  type ContentView,
  type InventoryRouteTab,
  type OrderStatus,
  type OrdersDateFilter,
  type ViewType,
} from './app-shell/routes'
type AnalysisOpenContext = {
  sku: string
  from?: string
  to?: string
  clientId?: number | null
  requestId: number
}
type ApiTimingRoute = {
  method: string
  path: string
  count: number
  errorCount: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  lastDurationMs: number
  lastStatus: number
  lastObservedAt: string
}
type ApiTimingSnapshot = {
  startedAt: string
  generatedAt: string
  routeCount: number
  routes: ApiTimingRoute[]
}

const ZOOM_OPTIONS = [
  { value: 75, label: '75% — Very Compact' },
  { value: 85, label: '85% — Compact' },
  { value: 100, label: '100% — Default' },
  { value: 115, label: '115% — Comfortable' },
  { value: 125, label: '125% — Large' },
  { value: 150, label: '150% — Extra Large' },
]

const STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
}

function formatTimingMs(value: unknown) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${ms}ms`
}

function formatTimingDate(value: string | null | undefined) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  }).format(date)
}

function timingTone(ms: number) {
  if (ms >= 1000) return 'text-rose-700'
  if (ms >= 500) return 'text-amber-700'
  return 'text-emerald-700'
}

function timingHealthTone(route: ApiTimingRoute | null | undefined) {
  if (!route) return 'text-ink'
  if (route.lastStatus >= 500) return 'text-rose-700'
  if (route.lastStatus >= 400) return 'text-amber-700'
  return timingTone(route.lastDurationMs)
}

// 'locations' is intentionally absent: Ship-From Locations moved into Settings
// (2026-05-13) and pathToRoute rewrites /locations → 'settings' before this map
// is ever read, so displayView never resolves to 'locations'. The key type
// excludes it to match the literal (no runtime 'locations' entry is emitted).
const VIEW_LABELS: Record<Exclude<ViewType, 'orders' | 'manifests' | 'locations'>, string> = {
  dashboard: 'Dashboard',
  inventory: 'Inventory',
  clients: 'Clients',
  packages: 'Packages',
  rates: 'Rates',
  analysis: 'Analysis',
  settings: 'Settings',
  billing: 'Billing',
}

const TEST_ORDERS_VISIBILITY_KEY = 'prepship_show_test_orders'

function PlaceholderView({ title }: { title: string }) {
  return (
    <div className="view-content">
      <div className="react-placeholder-card">
        <div className="react-placeholder-eyebrow">React Parity Rebuild</div>
        <h2>{title}</h2>
        <p>The root shell now uses the same frame contract as the V2 web app. Feature modules can be rebuilt inside this layout next.</p>
      </div>
    </div>
  )
}

export default function Home() {
  const { stores: sidebarStores } = useInitStores()
  const toastContext = useContext(ToastContext)
  const location = useLocation()
  const navigate = useNavigate()
  const initialRoute = pathToRoute(location.pathname)
  const [currentView, setCurrentView] = useState<ViewType>(initialRoute.view)
  const [lastContentView, setLastContentView] = useState<ContentView>(
    initialRoute.view === 'manifests' ? 'orders' : (initialRoute.view as ContentView),
  )
  const [currentStatus, setCurrentStatus] = useState<OrderStatus>(
    initialRoute.status ?? 'awaiting_shipment',
  )
  const [inventoryTab, setInventoryTab] = useState<InventoryRouteTab>(
    initialRoute.inventoryTab ?? 'stock',
  )

  // 2026-05-13: /locations was retired as a top-level destination.
  // Bounce any hits on the old URL straight to the new home — the
  // Settings → Ship-From Locations tab. Use replace:true so back-
  // button history isn't polluted with the dead URL.
  useEffect(() => {
    if (
      location.pathname === '/locations' ||
      location.pathname.startsWith('/locations/')
    ) {
      navigate('/settings/locations', { replace: true })
    }
  }, [location.pathname, navigate])

  // Sync URL → state when the user navigates via back/forward, a Link,
  // or a pasted deep-link such as /orders/awaiting_shipment/12345.
  // Both the status AND the optional active order ID are reflected
  // here, so a refresh on a deep-linked URL re-opens the drawer.
  useEffect(() => {
    const next = pathToRoute(location.pathname)
    setCurrentView(next.view)
    if (next.status) setCurrentStatus(next.status)
    if (next.inventoryTab) setInventoryTab(next.inventoryTab)
    // Only push the URL's orderId into state when the URL has one.
    // When the URL is a plain /orders/:status (no ID), we DON'T clear
    // activeOrderId here — the drawer-close handler does that, and
    // letting it ride avoids a render-cycle race when the URL change
    // is the SAME tick as the user closing the drawer.
    if (next.orderId != null) {
      setActiveOrderId(next.orderId)
    } else if (next.view === 'orders') {
      // Coming back to a bare /orders/:status URL — drop the drawer
      // so deep-link → back-button cleanly returns to the list.
      setActiveOrderId(null)
    }
  }, [location.pathname])
  const [mobileMenuOpen, setMobileMenuOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    // Closed by default on phones, open on tablet/desktop.
    return window.matchMedia('(min-width: 769px)').matches
  })
  const isMobileViewport = () =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  const closeMobileMenu = () => {
    if (isMobileViewport()) setMobileMenuOpen(false)
  }
  const [activeStore, setActiveStore] = useState<number | null>(null)
  const includeInactiveOrders = useMemo(() => {
    const params = new URLSearchParams(location.search)
    const raw = params.get('includeInactiveClients') ?? params.get('includeInactive')
    return raw === '1' || raw === 'true' || raw === 'yes'
  }, [location.search])
  const activeRouteClientName = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return params.get('clientName') || null
  }, [location.search])
  useEffect(() => {
    const route = pathToRoute(location.pathname)
    if (route.view !== 'orders') return
    const params = new URLSearchParams(location.search)
    const clientId = Number.parseInt(params.get('clientId') ?? '', 10)
    const storeId = Number.parseInt(params.get('storeId') ?? '', 10)
    if (Number.isFinite(clientId) && clientId > 0) {
      setActiveStore(-clientId)
    } else if (Number.isFinite(storeId)) {
      setActiveStore(storeId)
    }
  }, [location.pathname, location.search])
  const [searchQuery, setSearchQuery] = useState('')
  // Bumped every time the user navigates via the sidebar (status click,
  // store click, etc). OrdersView watches this counter and clears its
  // own local filters (skuFilter, customDateFrom, customDateTo) so the
  // user gets a 'fresh start' in the new view. Search + dateFilter
  // live up here in Home and are reset directly on the same nav event.
  // Counter is preferred over a boolean reset signal because it's
  // idempotent across rapid clicks — every click produces a distinct
  // value, so the OrdersView useEffect never misses an event.
  const [filterResetVersion, setFilterResetVersion] = useState(0)
  const [dateFilter, setDateFilter] = useState<OrdersDateFilter>('last-30')
  const [ordersDateRange, setOrdersDateRange] = useState<{ start?: string; end?: string }>(
    () => resolveOrdersDateRangeForFilter('last-30'),
  )
  const resetAllOrdersFilters = () => {
    setSearchQuery('')
    setDateFilter('last-30')
    setOrdersDateRange(resolveOrdersDateRangeForFilter('last-30'))
    setFilterResetVersion((v) => v + 1)
  }
  // Separate slot for SKU pre-fills coming from Dashboard clicks. Routed into
  // AnalysisView so we don't pollute the orders/global search box with a SKU
  // that's only meaningful on the Analysis screen. We also carry the Dashboard
  // date/client filters so the click-through compares the exact same window.
  const [analysisInitialContext, setAnalysisInitialContext] = useState<AnalysisOpenContext>({
    sku: '',
    requestId: 0,
  })
  function handleOrdersDateFilterChange(nextFilter: OrdersDateFilter) {
    setDateFilter(nextFilter)
    if (nextFilter !== 'custom') {
      setOrdersDateRange(resolveOrdersDateRangeForFilter(nextFilter))
    }
  }
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([])
  // Initial value pulled from URL so a deep-link like
  // /orders/awaiting_shipment/12345 opens the drawer immediately on
  // first render (no flash of the list, then the drawer popping in).
  const [activeOrderId, setActiveOrderId] = useState<number | null>(initialRoute.orderId)
  const pendingOpenOrderIdRef = useRef<number | null>(null)
  const [externalOpenOrderVersion, setExternalOpenOrderVersion] = useState(0)
  const [columnMenuRequestId, setColumnMenuRequestId] = useState(0)
  const [labelsActionRequestId, setLabelsActionRequestId] = useState(0)
  const [queueToggleRequestId, setQueueToggleRequestId] = useState(0)
  const [queueBadgeCount, setQueueBadgeCount] = useState(0)
  const [queueOpen, setQueueOpen] = useState(false)
  const [ordersRefreshVersion, setOrdersRefreshVersion] = useState(0)
  const [showTestOrders, setShowTestOrdersState] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(TEST_ORDERS_VISIBILITY_KEY) !== 'false'
  })
  const [syncStatus, setSyncStatus] = useState<{
    status: 'idle' | 'syncing' | 'done' | 'error'
    mode: 'idle' | 'incremental' | 'full'
    page: number
    total: number
    lastSync: number | null
    count: number
    error: string | null
  }>({
    status: 'idle',
    mode: 'idle',
    page: 0,
    total: 0,
    lastSync: null,
    count: 0,
    error: null,
  })
  const lastSeenSyncRef = useRef<number>(0)
  const hasSeenInitialSyncStatusRef = useRef(false)
  const lastSeenRateJobRef = useRef<{
    jobId: string
    processed: number
    updated: number
    status: string
  } | null>(null)
  const [workerStatus, setWorkerStatus] = useState<SyncWorkerStatusDto | null>(null)
  const [zoomPct, setZoomPct] = useState(() => {
    if (typeof window === 'undefined') return 100
    const stored = Number.parseInt(window.localStorage.getItem('prepship_zoom') ?? '100', 10)
    if (Number.isNaN(stored)) return 100
    // Clamp: anything below 50% is accidental and makes the UI unreadable.
    if (stored < 50 || stored > 200) return 100
    return stored
  })
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  // Refs + measured anchor for the zoom dropdown. Positioning the menu
  // via the button's getBoundingClientRect (instead of hardcoded
  // top-[60px]) makes it bulletproof against ancestor stacking contexts,
  // backdrop-filter, and any future topbar height change. Recomputed each
  // time the menu opens so it always lines up with the live button.
  const zoomBtnRef = useRef<HTMLButtonElement | null>(null)
  const [zoomMenuAnchor, setZoomMenuAnchor] = useState<{ top: number; right: number } | null>(null)
  // localStorage-backed preference: hide the right-side order detail panel
  // when no order is selected. Default false (panel visible) for back-compat.
  // OrdersView reads this via prop; toggle via the lock pill in the topbar.
  const [hideEmptyPanel, setHideEmptyPanel] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('prepship_hide_empty_panel') === 'true'
  })
  const [apiTimingOpen, setApiTimingOpen] = useState(false)
  const [apiTimingLoading, setApiTimingLoading] = useState(false)
  const [apiTimingError, setApiTimingError] = useState<string | null>(null)
  const [apiTimingSnapshot, setApiTimingSnapshot] = useState<ApiTimingSnapshot | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('prepship_hide_empty_panel', String(hideEmptyPanel))
  }, [hideEmptyPanel])

  const setShowTestOrders = (next: boolean) => {
    setShowTestOrdersState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TEST_ORDERS_VISIBILITY_KEY, String(next))
    }
  }

  const activeStoreName = useMemo(
    () =>
      sidebarStores.find((store) => store.storeId === activeStore)?.storeName ??
      (activeStore != null && activeStore < 0 ? activeRouteClientName : null),
    [sidebarStores, activeStore, activeRouteClientName],
  )

  useEffect(() => {
    if (currentView === 'manifests') return
    setLastContentView(currentView)
  }, [currentView])

  const displayView = currentView === 'manifests' ? lastContentView : currentView
  const manifestOpen = currentView === 'manifests'

  const viewTitle = displayView === 'orders'
    ? activeStoreName
      ? `${STATUS_LABELS[currentStatus]} · ${activeStoreName}`
      : STATUS_LABELS[currentStatus]
    : VIEW_LABELS[displayView as Exclude<ContentView, 'orders' | 'locations'>]

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem('prepship_zoom', String(zoomPct))
    const mobile = window.matchMedia('(max-width:768px)').matches

    if (mobile) {
      document.documentElement.style.removeProperty('--prepship-shell-height')
      document.documentElement.style.removeProperty('--prepship-zoom-scale')
      document.body.style.zoom = ''
      document.body.style.height = ''
      return
    }

    const shellHeight = `${(10000 / zoomPct).toFixed(2)}vh`
    document.documentElement.style.setProperty('--prepship-shell-height', shellHeight)
    document.documentElement.style.setProperty('--prepship-zoom-scale', String(zoomPct / 100))
    document.body.style.zoom = `${zoomPct}%`
    document.body.style.height = shellHeight

    return () => {
      document.documentElement.style.removeProperty('--prepship-shell-height')
      document.documentElement.style.removeProperty('--prepship-zoom-scale')
      document.body.style.zoom = ''
      document.body.style.height = ''
    }
  }, [zoomPct])

  useEffect(() => {
    if (!zoomMenuOpen) return

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      // Clicks inside the trigger button's wrapper (#zoom-wrap) OR inside
      // the portal-rendered menu (#zoomMenu — lives at document.body
      // outside the wrapper) both count as "inside." Match either id so
      // option clicks aren't mistaken for outside-clicks.
      if (target?.closest('#zoom-wrap') || target?.closest('#zoomMenu')) return
      setZoomMenuOpen(false)
    }

    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [zoomMenuOpen])

  useEffect(() => {
    const pendingOrderId = pendingOpenOrderIdRef.current
    if (displayView === 'orders' && pendingOrderId != null) {
      pendingOpenOrderIdRef.current = null
      setSelectedOrderIds([pendingOrderId])
      setActiveOrderId(pendingOrderId)
      return
    }
    setSelectedOrderIds([])
    setActiveOrderId(null)
  }, [displayView, currentStatus, activeStore, dateFilter, externalOpenOrderVersion])

  const openOrderFromContentView = (orderId: number, status?: string | null) => {
    const targetStatus = VALID_STATUSES.includes(status as OrderStatus) ? status as OrderStatus : currentStatus
    pendingOpenOrderIdRef.current = orderId
    setExternalOpenOrderVersion((value) => value + 1)
    navigate(`/orders/${targetStatus}`)
  }

  // Fallback path for content-view links (PackagesView, InventoryView)
  // when a direct id-lookup fails — e.g. the by-number endpoint isn't
  // deployed, or the order was purged. Listens for the custom event
  // dispatched by handleOpenOrderByNumber and routes the operator to
  // the orders list with the order number prefilled in search, so they
  // can find the row manually instead of dead-ending on an error toast.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string }>).detail
      const query = (detail?.query ?? '').trim()
      if (!query) return
      setSearchQuery(query)
      // Try every status one at a time — the order could be in any of
      // the three. Default to awaiting_shipment, but if the user is
      // already on /orders/X navigation to the same path is a no-op
      // and the search-query change alone re-runs the orders fetch.
      navigate(`/orders/${currentStatus}`)
    }
    window.addEventListener('prepship:open-orders-search', handler as EventListener)
    return () => window.removeEventListener('prepship:open-orders-search', handler as EventListener)
  }, [navigate, currentStatus])

  useEffect(() => {
    if (displayView !== 'orders') return

    let active = true
    let initialTimerId: number | null = null

    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const next = await apiClient.fetchLegacySyncStatus()
        if (!active) return
        setSyncStatus(next)

        const nextLastSync = next.lastSync ?? (next.lastSyncedAt ? Date.parse(next.lastSyncedAt) : null)
        if (!hasSeenInitialSyncStatusRef.current) {
          hasSeenInitialSyncStatusRef.current = true
          if (nextLastSync) lastSeenSyncRef.current = nextLastSync
        } else if (next.status === 'done' && nextLastSync && nextLastSync > lastSeenSyncRef.current) {
          lastSeenSyncRef.current = nextLastSync
          setOrdersRefreshVersion((value) => value + 1)
          if (next.count > 0 && next.count <= 10) {
            toastContext?.addToast(`🆕 ${next.count} order${next.count === 1 ? '' : 's'} updated`)
          }
        }

        const rateJob = next.ratePrefetchJob ?? null
        if (rateJob?.jobId) {
          const nextRateJob = {
            jobId: String(rateJob.jobId),
            processed: Number(rateJob.processed ?? 0),
            updated: Number(rateJob.updated ?? 0),
            status: String(rateJob.status ?? 'running'),
          }
          const previous = lastSeenRateJobRef.current
          const changed =
            previous == null
              ? nextRateJob.updated > 0
              : previous.jobId !== nextRateJob.jobId ||
                nextRateJob.updated > previous.updated ||
                nextRateJob.status !== previous.status
          lastSeenRateJobRef.current = nextRateJob
          if (changed) {
            setOrdersRefreshVersion((value) => value + 1)
          }
        } else if (lastSeenRateJobRef.current) {
          const shouldRefresh = lastSeenRateJobRef.current.status === 'running'
          lastSeenRateJobRef.current = null
          if (shouldRefresh) {
            setOrdersRefreshVersion((value) => value + 1)
          }
        }
      } catch (error) {
        if (!active) return
        setSyncStatus((current) => ({ ...current, status: 'error', error: error instanceof Error ? error.message : 'Sync error' }))
      }
    }

    initialTimerId = window.setTimeout(() => {
      void poll()
    }, 5000)
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void poll()
    }, 120_000)

    return () => {
      active = false
      if (initialTimerId !== null) window.clearTimeout(initialTimerId)
      window.clearInterval(intervalId)
    }
  }, [displayView, toastContext])

  // Poll the background [sync-v2] worker lightly so the topbar can show
  // its heartbeat (last cycle time, counts, errors). Separate from the
  // legacy sync poller above — the legacy one tracks user-triggered syncs,
  // this one tracks the always-on background worker.
  useEffect(() => {
    let active = true
    let initialTimerId: number | null = null
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const next = await apiClient.fetchSyncWorkerStatus()
        if (!active) return
        setWorkerStatus(next)
      } catch {
        // Silently ignore — the pill will just not update.
      }
    }
    initialTimerId = window.setTimeout(() => {
      void poll()
    }, 7000)
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void poll()
    }, 120_000)
    return () => {
      active = false
      if (initialTimerId !== null) window.clearTimeout(initialTimerId)
      window.clearInterval(intervalId)
    }
  }, [])

  const syncPill = useMemo(() => formatSyncPill(syncStatus), [syncStatus])
  const apiTimingRoutes = apiTimingSnapshot?.routes ?? []
  const slowestApiRoute = apiTimingRoutes[0] ?? null
  const ordersApiRoute =
    apiTimingRoutes.find((route) => route.method === 'GET' && route.path === '/orders') ?? null
  const apiTimingErrorCount = apiTimingRoutes.reduce(
    (sum, route) => sum + Number(route.errorCount ?? 0),
    0,
  )

  const refreshApiTiming = async () => {
    setApiTimingLoading(true)
    setApiTimingError(null)
    try {
      const snapshot = await api.get<ApiTimingSnapshot>('/observability/api-timing', {
        timeoutMs: 8_000,
      })
      setApiTimingSnapshot(snapshot)
    } catch (error) {
      setApiTimingError(error instanceof Error ? error.message : 'Failed to load API timing')
    } finally {
      setApiTimingLoading(false)
    }
  }

  const openApiTiming = () => {
    setApiTimingOpen(true)
    void refreshApiTiming()
  }

  const applyCompletedSync = (mode: 'incremental' | 'full', result: any) => {
    const lastSync = result?.lastSync
      ?? (result?.lastSyncedAt ? Date.parse(result.lastSyncedAt) : null)
      ?? Date.now()
    const count = Number(result?.count ?? result?.synced ?? 0)
    const total = Number(result?.total ?? result?.pages ?? 0)
    setSyncStatus((current) => ({
      ...current,
      status: 'done',
      mode,
      page: 0,
      total,
      count,
      lastSync,
      error: null,
    }))
    lastSeenSyncRef.current = Math.max(lastSeenSyncRef.current, lastSync ?? 0)
    setOrdersRefreshVersion((value) => value + 1)
  }

  const workerPill = useMemo(() => {
    if (!workerStatus || !workerStatus.enabled) {
      return null
    }
    if (workerStatus.lastError) {
      return { text: `⚠ Worker error`, title: workerStatus.lastError, color: 'var(--red, #dc2626)' }
    }
    if (workerStatus.running) {
      return { text: '⟳ Worker syncing…', title: 'Sync cycle in progress', color: 'var(--ss-blue, #2563eb)' }
    }
    if (workerStatus.lastCycleAt == null) {
      return { text: '⟳ Worker starting…', title: `Interval: ${workerStatus.intervalSeconds}s`, color: 'var(--text3, #6b7280)' }
    }
    const ageSec = Math.max(0, Math.round((Date.now() - workerStatus.lastCycleAt) / 1000))
    const ageText = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago` : `${Math.round(ageSec / 3600)}h ago`
    const countText = workerStatus.lastCycleShipped === 0 && workerStatus.lastCycleIngested === 0
      ? 'idle'
      : `${workerStatus.lastCycleShipped} shipped · ${workerStatus.lastCycleIngested} ingested`
    return {
      text: `⟳ Worker ${ageText}`,
      title:
        `Last cycle ${ageText} · ${workerStatus.lastCycleElapsedMs}ms · ${countText}\n` +
        `Total cycles: ${workerStatus.totalCyclesRun} · all-time ${workerStatus.totalShippedAllTime} shipped / ${workerStatus.totalIngestedAllTime} ingested\n` +
        `Interval: ${workerStatus.intervalSeconds}s`,
      color: 'var(--text3, #6b7280)',
    }
  }, [workerStatus])

  return (
    <>
      <div className="panel-backdrop" id="panelBackdrop" />

      {mobileMenuOpen ? (
        <div
          className="mobile-sidebar-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <Sidebar
        currentStatus={currentStatus}
        currentView={displayView}
        stores={sidebarStores}
        onSelectStatus={(status) => {
          // Sidebar navigation = fresh-start contract. Clearing the
          // active store + all 3 orders filters (search, sku, date)
          // means clicking 'Shipped' from a heavily filtered Awaiting
          // view doesn't carry stale filters into a brand-new context.
          setActiveStore(null)
          resetAllOrdersFilters()
          navigate(`/orders/${status}`)
          closeMobileMenu()
        }}
        onShowView={(view) => {
          navigate(VIEW_PATHS[view as Exclude<ViewType, 'orders' | 'locations'>] ?? '/')
          closeMobileMenu()
        }}
        mobileMenuOpen={mobileMenuOpen}
        onCloseMobileMenu={closeMobileMenu}
        searchValue={searchQuery}
        onSearch={(query) => {
          setSearchQuery(query)
          if (query.trim()) navigate(`/orders/${currentStatus}`)
        }}
        onSelectStore={(storeId, statusOverride) => {
          // Same fresh-start contract as onSelectStatus — clicking a
          // client/store in the sidebar resets all 3 filters so the
          // operator sees the full set of orders for that store, not
          // an unintentionally-narrowed slice from a previous filter.
          setActiveStore(storeId)
          resetAllOrdersFilters()
          navigate(`/orders/${statusOverride ?? currentStatus}`)
          closeMobileMenu()
        }}
        activeStore={activeStore}
        dateStart={ordersDateRange.start}
        dateEnd={ordersDateRange.end}
        showTestOrders={showTestOrders}
        onShowTestOrdersChange={setShowTestOrders}
      />

      <div className="main bg-page text-ink font-sans antialiased tracking-[-0.005em]">
        {/* ────────────────────── TOPBAR ──────────────────────
            Reworked: single sticky header, theme-aware surfaces,
            grouped right-cluster (sync · view controls · zoom),
            consistent 32px-tall buttons, hairline group dividers,
            polished hover/press states, smooth batch-bar swap.
        */}
        <header
          id="topbar"
          className="
            relative flex items-center gap-3
            px-4 sm:px-5 h-14
            bg-surface/85 backdrop-blur-xl
            border-b border-line
            text-ink
            shadow-[0_1px_0_0_rgba(var(--shadow-color,15_23_42)/0.04)]
          "
        >
          {/* Sync progress bar — pinned to the very top edge */}
          <AnimatePresence>
            {syncStatus.status === 'syncing' && syncStatus.total > 0 ? (
              <motion.div
                key="sync-progress"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute top-0 left-0 right-0 h-[2px] bg-line/30 z-50 overflow-hidden"
              >
                <motion.div
                  className="h-full bg-gradient-to-r from-brand via-indigo-500 to-indigo-600 shadow-[0_0_10px_rgba(99,102,241,0.65)]"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, (syncStatus.page / syncStatus.total) * 100)}%` }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* Mobile menu */}
          <button
            id="mobileMenuBtn"
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="md:hidden flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-2 hover:text-ink hover:bg-surface-2 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 transition-all duration-150"
            aria-label="Toggle menu"
          >
            <Menu size={18} strokeWidth={2.25} />
          </button>

          {/* Title — animates out when batch-bar appears */}
          <AnimatePresence mode="wait">
            {false ? (
              <motion.div
                key="batch-bar"
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 380, damping: 28 }}
                className="flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-xl bg-gradient-to-r from-brand to-indigo-600 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.45)] ring-1 ring-white/10 min-w-0"
                id="batchBar"
                role="region"
                aria-label="Bulk actions"
              >
                <span id="batchCount" className="font-mono tabular-nums font-bold text-[12px] text-white whitespace-nowrap">
                  <motion.span
                    key={selectedOrderIds.length}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="inline-block tabular-nums"
                  >
                    {selectedOrderIds.length}
                  </motion.span>{' '}
                  <span className="font-medium opacity-80">selected</span>
                </span>
                {/* "Print Labels" only makes sense on the awaiting_shipment
                    view — it creates new labels via the v2 ShipEngine flow.
                    On Shipped/Cancelled views the action is meaningless
                    (orders already have labels or were cancelled), and the
                    backend would reject it via assertOrderEditable() anyway.
                    We hide the pill rather than showing it disabled because
                    "show then disable" trains operators to feel locked-out
                    when the action is genuinely inapplicable. */}
                {currentStatus === 'awaiting_shipment' ? (
                  <>
                    <div className="w-px h-5 bg-white/20" aria-hidden />
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.94 }}
                      whileHover={{ y: -1 }}
                      transition={{ duration: 0.12 }}
                      className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-white/15 text-white text-[11.5px] font-semibold hover:bg-white/25 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => setLabelsActionRequestId((value) => value + 1)}
                      aria-label={`Print labels for ${selectedOrderIds.length} selected orders`}
                    >
                      <Printer size={12.5} strokeWidth={2.25} />
                      Print Labels
                    </motion.button>
                  </>
                ) : null}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  whileHover={{ rotate: 90 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 24 }}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/10 text-white hover:bg-white/25 transition-colors duration-150"
                  onClick={() => {
                    setSelectedOrderIds([])
                    setActiveOrderId(null)
                  }}
                  aria-label="Clear selection"
                  title="Clear selection"
                >
                  <XIcon size={13} strokeWidth={2.5} />
                </motion.button>
              </motion.div>
            ) : (
              <motion.div
                key="title"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center gap-2.5 min-w-0"
                id="viewTitle"
              >
                <h1 className="text-[15px] font-extrabold font-display tracking-[-0.025em] text-ink truncate">
                  {viewTitle}
                </h1>
              </motion.div>
            )}
          </AnimatePresence>

          {displayView === 'orders' ? (
            <>
              {/* Slot for the "Sending to queue" progress widget — OrdersView portals it here so
                  it sits immediately LEFT of the centered Queue button (DJ request 2026-06-11).
                  Right edge anchored 128px left of center so the wider Close Queue state cannot overlap. */}
              <div
                id="queue-progress-slot"
                className="absolute left-1/2 top-1/2 z-10 hidden md:block"
                style={{ transform: 'translate(calc(-100% - 128px), -50%)' }}
              />
            <button
              id="pq-toggle-btn"
              type="button"
              aria-label={queueOpen ? 'Close print queue panel' : 'Open print queue panel'}
              className="absolute left-1/2 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-2 h-10 px-6 rounded-xl text-white text-[14px] font-bold bg-gradient-to-br from-brand to-indigo-600 ring-1 ring-brand/30 shadow-md hover:shadow-lg active:scale-95 transition-all duration-150 md:inline-flex"
              onClick={() => setQueueToggleRequestId((value) => value + 1)}
            >
              {queueOpen ? (
                <>
                  <XIcon size={16} strokeWidth={2.75} />
                  <span>Close Queue</span>
                </>
              ) : (
                <>
                  <Printer size={16} strokeWidth={2.5} />
                  <span>Queue</span>
                </>
              )}
              <AnimatePresence>
                {queueBadgeCount > 0 ? (
                  <motion.span
                    key="pq-badge-centered"
                    id="pq-badge"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                    className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1 rounded-full bg-amber-400 text-black text-[10px] font-bold font-mono tabular-nums shadow-sm ring-2 ring-white/90"
                  >
                    {queueBadgeCount}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </button>
            </>
          ) : null}

          {/* Spacer pushes the right cluster to the edge */}
          <div className="flex-1 min-w-0" />

          {/* Right cluster — only on /orders. On mobile, when the user
              is in selection mode (≥1 row checked), this whole cluster
              hides so the gradient batch bar gets the full width to
              show "X selected · Print Labels · Clear" cleanly. Same
              UX pattern as iOS Mail / Linear / Gmail: selection mode
              suppresses browse-mode chrome. Desktop (md+) keeps both
              visible since there's plenty of horizontal space. */}
          {displayView === 'orders' ? (
            <div
              className="items-center gap-2 flex-shrink-0 flex"
              id="topbarActions"
            >
              {/* Sync status pill */}
              <button
                type="button"
                className={`hidden md:inline-flex items-center gap-1.5 h-8 pl-2.5 pr-3 rounded-full text-[11.5px] font-medium font-mono tabular-nums whitespace-nowrap transition-colors hover:ring-1 hover:ring-brand/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${syncPill.className}`}
                id="syncPill"
                onClick={openApiTiming}
                aria-label={`${syncPill.text}. ${syncPill.title}`}
                title={syncPill.title}
              >
                <span className="sync-dot" aria-hidden />
                <span id="syncText">
                  {syncPill.text}
                  {syncStatus.status === 'syncing' && syncStatus.total > 0 ? (
                    <span className="ml-1 opacity-70">({syncStatus.page}/{syncStatus.total})</span>
                  ) : null}
                </span>
              </button>

              {/* Worker pill */}
              {workerPill ? (
                <div
                  id="workerPill"
                  title={workerPill.title}
                  className="hidden lg:inline-flex items-center h-8 px-3 rounded-full bg-surface-2 ring-1 ring-line text-[11px] font-mono tabular-nums whitespace-nowrap"
                  style={{ color: workerPill.color }}
                >
                  {workerPill.text}
                </div>
              ) : null}

              {/* Group: sync actions */}
              <div className="inline-flex items-center gap-0.5 h-8 px-1 rounded-lg bg-surface-2 ring-1 ring-line">
                <button
                  id="btnSyncIncr"
                  type="button"
                  disabled={syncStatus.status === 'syncing'}
                  aria-label="Incremental sync"
                  title="Incremental sync (changed orders only)"
                  className="inline-flex items-center justify-center w-7 h-6 rounded-md text-ink-2 hover:text-ink hover:bg-surface active:scale-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                  onClick={async () => {
                    setSyncStatus((current) => ({ ...current, status: 'syncing', mode: 'incremental', page: 0, total: 0, error: null }))
                    try {
                      const result = await apiClient.triggerLegacySync('incremental')
                      applyCompletedSync('incremental', result)
                      toastContext?.addToast('🔄 Incremental sync triggered')
                    } catch (error) {
                      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to trigger sync', 'error')
                    }
                  }}
                >
                  {syncStatus.status === 'syncing' && syncStatus.mode === 'incremental' ? (
                    <Loader2 size={13} strokeWidth={2.5} className="animate-spinSlow text-brand" />
                  ) : (
                    <RotateCw size={13} strokeWidth={2.25} />
                  )}
                </button>
                <button
                  id="btnSyncFull"
                  type="button"
                  disabled={syncStatus.status === 'syncing'}
                  aria-label="Full re-sync"
                  title="Full re-sync (all orders)"
                  className="inline-flex items-center justify-center px-2 h-6 rounded-md text-[10.5px] font-bold uppercase tracking-wide text-ink-3 hover:text-ink hover:bg-surface active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                  onClick={async () => {
                    setSyncStatus((current) => ({ ...current, status: 'syncing', mode: 'full', page: 0, total: 0, error: null }))
                    try {
                      const result = await apiClient.triggerLegacySync('full')
                      applyCompletedSync('full', result)
                      toastContext?.addToast('🔄 Full re-sync triggered')
                    } catch (error) {
                      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to trigger sync', 'error')
                    }
                  }}
                >
                  {syncStatus.status === 'syncing' && syncStatus.mode === 'full' ? (
                    <span className="inline-block animate-spinSlow">↻</span>
                  ) : (
                    'Full'
                  )}
                </button>
              </div>

              {/* Group: view controls */}
              <div className="inline-flex items-center gap-1">
                <button
                  data-columns-anchor="true"
                  type="button"
                  aria-label="Configure visible columns"
                  className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface-2 active:scale-95 transition-all duration-150 text-[12px] font-semibold"
                  onClick={() => setColumnMenuRequestId((value) => value + 1)}
                >
                  <Columns3 size={13} strokeWidth={2.25} />
                  <span className="hidden sm:inline">Columns</span>
                </button>

                {/* "Labels" topbar button removed per user request 2026-05-07.
                    Operators trigger label creation via the per-row Create +
                    Print Label action (side panel) or the in-row "Print Labels"
                    pill that appears when ≥1 order is selected. The standalone
                    Labels topbar button was a redundant entry point. */}

                <button
                  id="pq-toggle-btn-mobile"
                  type="button"
                  aria-label={queueOpen ? 'Close print queue panel' : 'Open print queue panel'}
                  className="relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface-2 active:scale-95 transition-all duration-150 text-[12px] font-semibold md:hidden"
                  onClick={() => setQueueToggleRequestId((value) => value + 1)}
                >
                  {queueOpen ? (
                    <>
                      <XIcon size={13} strokeWidth={2.5} />
                      <span className="hidden sm:inline">Close Queue</span>
                    </>
                  ) : (
                    <>
                      <Printer size={13} strokeWidth={2.25} />
                      <span className="hidden sm:inline">Queue</span>
                    </>
                  )}
                  <AnimatePresence>
                    {queueBadgeCount > 0 ? (
                      <motion.span
                        key="pq-badge-mobile"
                        id="pq-badge-mobile"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                        className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-black text-[9px] font-bold font-mono tabular-nums shadow-sm ring-2 ring-surface"
                      >
                        {queueBadgeCount}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </button>
              </div>

              {/* Hairline divider before zoom (always-visible) */}
              <div className="hidden md:block w-px h-5 bg-line" aria-hidden />
            </div>
          ) : null}

          {/* Hide-empty-panel toggle — only relevant on the Orders view
              where the right detail panel exists. Persists in localStorage
              via Home.tsx's useEffect. Icon flips between PanelRightOpen
              (currently visible / click to hide) and PanelRightClose
              (currently hidden / click to show). Tooltip explains the
              behavior so first-time users don't get confused. */}
          {displayView === 'orders' ? (
            <button
              type="button"
              aria-label={hideEmptyPanel ? 'Show order detail panel when nothing selected' : 'Hide order detail panel when nothing selected'}
              aria-pressed={hideEmptyPanel}
              title={
                hideEmptyPanel
                  ? 'Right panel is hidden when no order is selected — click to keep it visible'
                  : 'Right panel always visible — click to hide it when no order is selected'
              }
              onClick={() => setHideEmptyPanel((open) => !open)}
              className={[
                // Hide on mobile during selection mode (matches the rest
                // of the right cluster) — keep visible on desktop.
                'inline-flex',
                'items-center justify-center h-8 w-8 rounded-lg ring-1 transition-all duration-150 active:scale-95',
                hideEmptyPanel
                  ? 'bg-brand/10 text-brand ring-brand/30 hover:bg-brand/15'
                  : 'bg-surface text-ink-2 ring-line hover:text-ink hover:ring-line-2 hover:bg-surface-2',
              ].join(' ')}
            >
              {hideEmptyPanel ? (
                <PanelRightClose size={14} strokeWidth={2.25} />
              ) : (
                <PanelRightOpen size={14} strokeWidth={2.25} />
              )}
            </button>
          ) : null}

          {/* Zoom trigger — pure Tailwind. The dropdown menu itself is
              rendered separately via React Portal at the bottom of the
              component (see <ZoomMenuPortal/> below) so it lives at
              document.body and can't be clipped by ANY ancestor.
              Hidden on mobile during orders-selection mode (consistent
              with the rest of the right cluster). */}
          <div
            className="relative"
            id="zoom-wrap"
          >
            <button
              id="zoomBtn"
              ref={zoomBtnRef}
              type="button"
              aria-label={`Current zoom ${zoomPct}%, click to change`}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface-2 active:scale-95 transition-all duration-150 text-[12px] font-mono tabular-nums font-semibold min-w-[64px]"
              onClick={(e) => {
                // stopPropagation prevents the click from bubbling to the
                // document-level click-outside handler that's registered
                // when the menu is open — without this, opening the menu
                // could immediately close it on the same click.
                e.stopPropagation()
                if (!zoomMenuOpen && zoomBtnRef.current) {
                  const rect = zoomBtnRef.current.getBoundingClientRect()
                  setZoomMenuAnchor({
                    top: rect.bottom + 6,
                    right: window.innerWidth - rect.right,
                  })
                }
                setZoomMenuOpen((open) => !open)
              }}
            >
              <ZoomIn size={13} strokeWidth={2.25} />
              <span id="zoomLabel">{zoomPct}%</span>
            </button>
          </div>
        </header>

        <AnimatePresence mode="wait">
          <motion.div
            key={displayView}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <Suspense fallback={<PageSkeleton />}>
              {displayView === 'dashboard' ? (
              <DashboardView
                onOpenSku={(sku, context) => {
                  if (!sku) return
                  setAnalysisInitialContext((current) => ({
                    sku,
                    from: context?.from,
                    to: context?.to,
                    clientId: context?.clientId ?? null,
                    requestId: current.requestId + 1,
                  }))
                  navigate('/analysis')
                }}
              />
            ) : displayView === 'orders' ? (
              <OrdersView
                currentStatus={currentStatus}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                activeStore={activeStore}
                dateFilter={dateFilter}
                onDateFilterChange={handleOrdersDateFilterChange}
                onResolvedDateRangeChange={setOrdersDateRange}
                // Counter from Home — bumps every time the user clicks
                // a sidebar entry. OrdersView watches this and clears
                // its local filters (sku, custom date range) so each
                // sidebar nav starts with a clean filter slate.
                filterResetVersion={filterResetVersion}
                selectedOrderIds={selectedOrderIds}
                onSelectedOrderIdsChange={setSelectedOrderIds}
                activeOrderId={activeOrderId}
                onActiveOrderIdChange={(nextId) => {
                  // Mirror the change into the URL so the active order
                  // is shareable / bookmarkable / refresh-survivable.
                  // We use replace=true on close (so back-button doesn't
                  // ping-pong inside one viewing session) and push on
                  // open (so back-button takes you OUT of the drawer
                  // back to the list — natural mobile-app behavior).
                  const currentPath = `/orders/${currentStatus}${activeOrderId != null ? `/${activeOrderId}` : ''}`
                  if (nextId == null) {
                    // Closing the drawer: navigate to the list URL.
                    if (currentPath !== `/orders/${currentStatus}`) {
                      navigate(`/orders/${currentStatus}`, { replace: true })
                    }
                  } else if (nextId !== activeOrderId) {
                    // Opening (or switching) the drawer: push so back works.
                    navigate(`/orders/${currentStatus}/${nextId}`)
                  }
                  // Always update local state too — useEffect re-derives
                  // from URL but immediate local update keeps the UI
                  // responsive without waiting for the route round-trip.
                  setActiveOrderId(nextId)
                }}
                onNavigateView={(view) => {
                  if ((view as string) === 'orders') navigate(`/orders/${currentStatus}`)
                  else navigate(VIEW_PATHS[view as Exclude<ViewType, 'orders' | 'locations'>] ?? '/')
                }}
                columnMenuRequestId={columnMenuRequestId}
                labelsActionRequestId={labelsActionRequestId}
                queueToggleRequestId={queueToggleRequestId}
                stores={sidebarStores}
                onQueueStateChange={({ count, isOpen }) => {
                  setQueueBadgeCount(count)
                  setQueueOpen(isOpen)
                }}
                refreshVersion={ordersRefreshVersion}
                showTestOrders={showTestOrders}
                includeInactiveClients={includeInactiveOrders}
                hideEmptyPanel={hideEmptyPanel}
                onHideEmptyPanelChange={setHideEmptyPanel}
              />
            ) : displayView === 'inventory' ? (
              <InventoryView
                searchQuery={searchQuery}
                activeTab={inventoryTab}
                onTabChange={(tab) => navigate(INVENTORY_TAB_PATHS[tab] ?? INVENTORY_TAB_PATHS.stock)}
                onOpenOrder={openOrderFromContentView}
              />
            ) : displayView === 'clients' ? (
              // The Clients destination is the modern card-based UI from
              // pages/Clients.tsx — lazy-loaded, wrapped in Suspense so
              // the first navigation shows a small loader while the chunk
              // arrives. See the ClientsPage comment above for details.
              <Suspense
                fallback={
                  <div className="flex-1 min-h-0 flex items-center justify-center bg-page">
                    <div className="flex flex-col items-center gap-2 text-ink-3 text-tiny font-sans uppercase tracking-wide">
                      <div className="w-7 h-7 rounded-full border-2 border-line border-t-brand animate-spinSlow" />
                      Loading clients
                    </div>
                  </div>
                }
              >
                <ClientsPage />
              </Suspense>
            ) : displayView === 'packages' ? (
              /* 2026-05-13: displayView === 'locations' branch
                 removed — Ship-From Locations is now a tab inside
                 SettingsView. The /locations URL is rewritten to
                 /settings/locations by the redirect useEffect above
                 before this dispatch ever sees it. ViewType still
                 carries 'locations' for back-compat with stale
                 callers (e.g. SidebarViewType union); none of them
                 should reach this branch in normal flow. */
              <PackagesView onOpenOrder={openOrderFromContentView} />
            ) : displayView === 'rates' ? (
              <RatesView />
            ) : displayView === 'analysis' ? (
              <AnalysisView
                initialSearch={analysisInitialContext.sku}
                initialFrom={analysisInitialContext.from}
                initialTo={analysisInitialContext.to}
                initialClientId={analysisInitialContext.clientId}
                initialRequestId={analysisInitialContext.requestId}
              />
            ) : displayView === 'settings' ? (
              <SettingsView />
            ) : displayView === 'billing' ? (
              <BillingView />
            ) : (
              <PlaceholderView title={viewTitle} />
            )}
            </Suspense>
          </motion.div>
        </AnimatePresence>

        {manifestOpen ? (
          <Suspense fallback={null}>
            <ManifestsView
              open={manifestOpen}
              onClose={() => {
                const target =
                  lastContentView === 'orders'
                    ? `/orders/${currentStatus}`
                    : VIEW_PATHS[lastContentView as Exclude<ViewType, 'orders' | 'locations'>] ?? '/'
                navigate(target)
              }}
            />
          </Suspense>
        ) : null}
      </div>

      {createPortal(
        <AnimatePresence>
          {apiTimingOpen ? (
            <motion.div
              className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/30 px-4 py-16 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="apiTimingTitle"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setApiTimingOpen(false)
              }}
            >
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="w-full max-w-5xl overflow-hidden rounded-2xl bg-surface text-ink shadow-2xl ring-1 ring-line"
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                  <div>
                    <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-brand">
                      Production API timing
                    </div>
                    <h2 id="apiTimingTitle" className="mt-1 text-[20px] font-extrabold tracking-tight text-ink">
                      Timing from the last sync toolbar
                    </h2>
                    <div className="mt-1 text-[12px] text-ink-3">
                      {apiTimingSnapshot?.generatedAt
                        ? `Updated ${formatTimingDate(apiTimingSnapshot.generatedAt)} CA`
                        : 'Click refresh to load the latest backend timing snapshot.'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshApiTiming()}
                      disabled={apiTimingLoading}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-[12px] font-semibold text-ink ring-1 ring-line transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {apiTimingLoading ? (
                        <Loader2 size={13} strokeWidth={2.4} className="animate-spinSlow text-brand" />
                      ) : (
                        <RotateCw size={13} strokeWidth={2.3} />
                      )}
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiTimingOpen(false)}
                      aria-label="Close API timing"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-ink-2 ring-1 ring-line transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <XIcon size={15} strokeWidth={2.4} />
                    </button>
                  </div>
                </div>

                <div className="max-h-[72vh] overflow-y-auto px-5 py-4">
                  {apiTimingError ? (
                    <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-200">
                      {apiTimingError}
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                    <div className="rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-3">
                        Routes
                      </div>
                      <div className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
                        {apiTimingSnapshot?.routeCount ?? 0}
                      </div>
                      <div className="mt-1 text-[11.5px] text-ink-3">tracked in memory</div>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-3">
                        Orders current
                      </div>
                      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${timingHealthTone(ordersApiRoute)}`}>
                        {ordersApiRoute ? formatTimingMs(ordersApiRoute.lastDurationMs) : '-'}
                      </div>
                      <div className="mt-1 text-[11.5px] text-ink-3">
                        p95 {ordersApiRoute ? formatTimingMs(ordersApiRoute.p95Ms) : '-'}
                      </div>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-3">
                        Slowest current
                      </div>
                      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${timingHealthTone(slowestApiRoute)}`}>
                        {slowestApiRoute ? formatTimingMs(slowestApiRoute.lastDurationMs) : '-'}
                      </div>
                      <div className="mt-1 truncate text-[11.5px] text-ink-3">
                        {slowestApiRoute ? `${slowestApiRoute.method} ${slowestApiRoute.path}` : 'no samples yet'}
                      </div>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-3">
                        Errors
                      </div>
                      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${apiTimingErrorCount > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        {apiTimingErrorCount}
                      </div>
                      <div className="mt-1 text-[11.5px] text-ink-3">5xx samples</div>
                    </div>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-xl bg-surface ring-1 ring-line">
                    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                      <div>
                        <div className="text-[12px] font-extrabold text-ink">Hot API Routes</div>
                        <div className="text-[11.5px] text-ink-3">
                          Current shows what is happening now. Typical and spike columns show recent history.
                        </div>
                      </div>
                      {apiTimingLoading ? (
                        <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-3">
                          <Loader2 size={13} strokeWidth={2.4} className="animate-spinSlow text-brand" />
                          Loading
                        </div>
                      ) : null}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-[12px]">
                        <thead className="bg-surface-2 text-[10px] uppercase tracking-wider text-ink-3">
                          <tr>
                            <th className="px-4 py-2 font-bold">Route</th>
                            <th className="px-3 py-2 text-right font-bold">Count</th>
                            <th className="px-3 py-2 text-right font-bold" title="Normal request speed. Half of recent requests were faster than this.">Typical</th>
                            <th className="px-3 py-2 text-right font-bold" title="Slow-but-not-rare spike. 95% of recent requests were faster than this.">Slow Spike</th>
                            <th className="px-3 py-2 text-right font-bold" title="Rare slow spike. 99% of recent requests were faster than this.">Rare Spike</th>
                            <th className="px-3 py-2 text-right font-bold" title="Slowest request still remembered by the API timing window.">Worst</th>
                            <th className="px-3 py-2 text-right font-bold" title="Most recent request speed. This controls the green/red health color.">Current</th>
                            <th className="px-4 py-2 text-right font-bold">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {apiTimingRoutes.length === 0 && !apiTimingLoading ? (
                            <tr>
                              <td colSpan={8} className="px-4 py-6 text-center text-ink-3">
                                No API timing samples yet.
                              </td>
                            </tr>
                          ) : (
                            apiTimingRoutes.slice(0, 12).map((route) => (
                              <tr key={`${route.method}:${route.path}`} className="hover:bg-brand-bg/30">
                                <td className="max-w-[360px] px-4 py-2.5 font-semibold text-ink">
                                  <span className="mr-2 text-ink-3">{route.method}</span>
                                  <span className="break-all">{route.path}</span>
                                  <div className="mt-0.5 text-[10.5px] font-medium text-ink-3">
                                    last seen {formatTimingDate(route.lastObservedAt)} CA
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{route.count}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{formatTimingMs(route.p50Ms)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{formatTimingMs(route.p95Ms)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{formatTimingMs(route.p99Ms)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{formatTimingMs(route.maxMs)}</td>
                                <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${timingHealthTone(route)}`}>{formatTimingMs(route.lastDurationMs)}</td>
                                <td className="px-4 py-2.5 text-right">
                                  <span className={[
                                    'inline-flex min-w-[42px] justify-center rounded-full px-2 py-0.5 text-[10.5px] font-bold tabular-nums',
                                    route.lastStatus >= 500
                                      ? 'bg-rose-100 text-rose-700'
                                      : route.lastStatus >= 400
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-emerald-100 text-emerald-700',
                                  ].join(' ')}>
                                    {route.lastStatus || '-'}
                                  </span>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body
      )}

      {/* Zoom dropdown — portal-rendered at document.body level so it
          escapes EVERY ancestor stacking context, transform,
          backdrop-filter, and overflow:hidden. Position is computed live
          from the trigger button's getBoundingClientRect (set in
          onClick). No max-height — all 6 options always fit. z-[9999]
          stacks above all page-level UI but below modal overlays
          (3000+). */}
      {createPortal(
        <AnimatePresence>
          {zoomMenuOpen ? (
            <motion.div
              id="zoomMenu"
              role="menu"
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              style={
                zoomMenuAnchor
                  ? { top: zoomMenuAnchor.top, right: zoomMenuAnchor.right }
                  : { top: 60, right: 16 }
              }
              className="fixed z-[9999] flex flex-col bg-surface ring-1 ring-line-2 rounded-xl shadow-xl py-1.5 min-w-[200px] origin-top-right"
            >
              <div className="px-3 pt-1.5 pb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-3 select-none">
                Zoom level
              </div>
              {ZOOM_OPTIONS.map((option, idx) => {
                const isActive = zoomPct === option.value
                return (
                  <motion.button
                    key={option.value}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.02, duration: 0.18 }}
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation()
                      setZoomPct(option.value)
                      setZoomMenuOpen(false)
                    }}
                    className={[
                      'block w-full text-left whitespace-nowrap',
                      'px-3.5 py-1.5 text-[12.5px] font-sans',
                      'border-0 bg-transparent cursor-pointer',
                      'transition-colors duration-100',
                      isActive
                        ? 'text-brand font-bold bg-brand/10'
                        : 'text-ink-2 hover:text-ink hover:bg-surface-2',
                    ].join(' ')}
                  >
                    {option.label}
                  </motion.button>
                )
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
