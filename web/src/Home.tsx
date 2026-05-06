// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import { ToastContext } from './contexts/ToastContext'
import { apiClient } from './api/client'
import type { SyncWorkerStatusDto } from './types/api'
import { useInitStores } from './hooks'
import Sidebar from './components/Sidebar/Sidebar'
import OrdersView from './components/Views/OrdersView'
import DashboardView from './components/Views/DashboardView'
import InventoryView from './components/Views/InventoryView'
import LocationsView from './components/Views/LocationsView'
import PackagesView from './components/Views/PackagesView'
import RatesView from './components/Views/RatesView'
import AnalysisView from './components/Views/AnalysisView'
import SettingsView from './components/Views/SettingsView'
import BillingView from './components/Views/BillingView'
import ManifestsView from './components/Views/ManifestsView'
import { formatSyncPill } from './components/Views/orders-parity'
import { getOrdersDateRange } from './components/Views/orders-view-filters'

type ViewType = 'orders' | 'dashboard' | 'inventory' | 'locations' | 'packages' | 'rates' | 'analysis' | 'settings' | 'billing' | 'manifests'
type ContentView = Exclude<ViewType, 'manifests'>
type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'
type OrdersDateFilter = '' | 'this-month' | 'last-month' | 'last-30' | 'last-90' | 'custom'

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

function getResolvedDateRange(filter: OrdersDateFilter) {
  const range = getOrdersDateRange(filter)
  if (!range) return { start: undefined, end: undefined }
  return {
    start: range.start.toISOString().split('T')[0],
    end: range.end.toISOString().split('T')[0],
  }
}

const VIEW_LABELS: Record<Exclude<ViewType, 'orders' | 'manifests'>, string> = {
  dashboard: 'Dashboard',
  inventory: 'Inventory',
  locations: 'Locations',
  packages: 'Packages',
  rates: 'Rates',
  analysis: 'Analysis',
  settings: 'Settings',
  billing: 'Billing',
}

const VIEW_PATHS: Record<Exclude<ViewType, 'orders'>, string> = {
  dashboard: '/dashboard',
  inventory: '/inventory',
  locations: '/locations',
  packages: '/packages',
  rates: '/rates',
  analysis: '/analysis',
  settings: '/settings',
  billing: '/billing',
  manifests: '/manifest',
}

const VALID_STATUSES: OrderStatus[] = ['awaiting_shipment', 'shipped', 'cancelled']
const TEST_ORDERS_VISIBILITY_KEY = 'prepship_show_test_orders'

function pathToRoute(pathname: string): { view: ViewType; status: OrderStatus | null } {
  if (pathname === '/' || pathname === '/orders' || pathname === '/orders/') {
    return { view: 'orders', status: 'awaiting_shipment' }
  }
  const ordersMatch = pathname.match(/^\/orders\/([^/]+)/)
  if (ordersMatch) {
    const candidate = ordersMatch[1] as OrderStatus
    if (VALID_STATUSES.includes(candidate)) return { view: 'orders', status: candidate }
    return { view: 'orders', status: 'awaiting_shipment' }
  }
  for (const [view, path] of Object.entries(VIEW_PATHS) as [Exclude<ViewType, 'orders'>, string][]) {
    if (pathname === path || pathname.startsWith(path + '/')) {
      return { view, status: null }
    }
  }
  return { view: 'orders', status: 'awaiting_shipment' }
}

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

  // Sync URL → state when the user navigates via back/forward or a Link.
  useEffect(() => {
    const next = pathToRoute(location.pathname)
    setCurrentView(next.view)
    if (next.status) setCurrentStatus(next.status)
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
  const [searchQuery, setSearchQuery] = useState('')
  // Separate slot for SKU pre-fills coming from Dashboard clicks. Routed into
  // AnalysisView's `initialSearch` prop so we don't pollute the orders/global
  // search box with a SKU that's only meaningful on the Analysis screen.
  const [analysisInitialSku, setAnalysisInitialSku] = useState('')
  const [dateFilter, setDateFilter] = useState<OrdersDateFilter>('last-30')
  const [ordersDateRange, setOrdersDateRange] = useState<{ start?: string; end?: string }>(
    () => getResolvedDateRange('last-30'),
  )
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([])
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
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

  const setShowTestOrders = (next: boolean) => {
    setShowTestOrdersState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TEST_ORDERS_VISIBILITY_KEY, String(next))
    }
  }

  const activeStoreName = useMemo(
    () => sidebarStores.find((store) => store.storeId === activeStore)?.storeName ?? null,
    [sidebarStores, activeStore],
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
    : VIEW_LABELS[displayView as Exclude<ContentView, 'orders'>]

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
      if (target?.closest('.react-zoom-wrap')) return
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

  useEffect(() => {
    if (displayView !== 'orders') return

    let active = true

    const poll = async () => {
      try {
        const next = await apiClient.fetchLegacySyncStatus()
        if (!active) return
        setSyncStatus(next)

        if (next.status === 'done' && next.count > 0 && (next.lastSync ?? 0) > lastSeenSyncRef.current) {
          lastSeenSyncRef.current = next.lastSync ?? 0
          setOrdersRefreshVersion((value) => value + 1)
          if (next.count <= 10) {
            toastContext?.addToast(`🆕 ${next.count} order${next.count === 1 ? '' : 's'} updated`)
          }
        }
      } catch (error) {
        if (!active) return
        setSyncStatus((current) => ({ ...current, status: 'error', error: error instanceof Error ? error.message : 'Sync error' }))
      }
    }

    void poll()
    const intervalId = window.setInterval(() => {
      void poll()
    }, 10000)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [displayView, toastContext])

  // Poll the background [sync-v2] worker every 15s so the topbar can show
  // its heartbeat (last cycle time, counts, errors). Separate from the
  // legacy sync poller above — the legacy one tracks user-triggered syncs,
  // this one tracks the always-on background worker.
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const next = await apiClient.fetchSyncWorkerStatus()
        if (!active) return
        setWorkerStatus(next)
      } catch {
        // Silently ignore — the pill will just not update.
      }
    }
    void poll()
    const intervalId = window.setInterval(() => void poll(), 15000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [])

  const syncPill = useMemo(() => formatSyncPill(syncStatus), [syncStatus])

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
          setActiveStore(null)
          navigate(`/orders/${status}`)
          closeMobileMenu()
        }}
        onShowView={(view) => {
          navigate(VIEW_PATHS[view as Exclude<ViewType, 'orders'>] ?? '/')
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
          setActiveStore(storeId)
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
            {displayView === 'orders' && selectedOrderIds.length > 0 ? (
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

          {/* Spacer pushes the right cluster to the edge */}
          <div className="flex-1 min-w-0" />

          {/* Right cluster — only on /orders */}
          {displayView === 'orders' ? (
            <div className="flex items-center gap-2 flex-shrink-0" id="topbarActions">
              {/* Sync status pill */}
              <div
                className={`hidden md:inline-flex items-center gap-1.5 h-8 pl-2.5 pr-3 rounded-full text-[11.5px] font-medium font-mono tabular-nums whitespace-nowrap transition-colors ${syncPill.className}`}
                id="syncPill"
              >
                <span className="sync-dot" aria-hidden />
                <span id="syncText">
                  {syncPill.text}
                  {syncStatus.status === 'syncing' && syncStatus.total > 0 ? (
                    <span className="ml-1 opacity-70">({syncStatus.page}/{syncStatus.total})</span>
                  ) : null}
                </span>
              </div>

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

                <button
                  type="button"
                  aria-label="Print labels"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-gradient-to-br from-brand to-indigo-600 text-white shadow-[0_2px_8px_-2px_rgba(99,102,241,0.5)] hover:shadow-[0_4px_14px_-3px_rgba(99,102,241,0.6)] hover:-translate-y-px active:translate-y-0 active:scale-95 transition-all duration-150 text-[12px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-1"
                  onClick={() => setLabelsActionRequestId((value) => value + 1)}
                >
                  <Printer size={13} strokeWidth={2.5} />
                  Labels
                </button>

                <button
                  id="pq-toggle-btn"
                  type="button"
                  aria-label={queueOpen ? 'Close print queue panel' : 'Open print queue panel'}
                  className="relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface-2 active:scale-95 transition-all duration-150 text-[12px] font-semibold"
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
                        key="pq-badge"
                        id="pq-badge"
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

          {/* Zoom — always visible, far right */}
          <div className="relative" id="zoom-wrap">
            <button
              id="zoomBtn"
              type="button"
              aria-label={`Current zoom ${zoomPct}%, click to change`}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface text-ink-2 hover:text-ink hover:ring-line-2 hover:bg-surface-2 active:scale-95 transition-all duration-150 text-[12px] font-mono tabular-nums font-semibold min-w-[64px]"
              onClick={() => setZoomMenuOpen((open) => !open)}
            >
              <ZoomIn size={13} strokeWidth={2.25} />
              <span id="zoomLabel">{zoomPct}%</span>
            </button>
            <AnimatePresence>
              {zoomMenuOpen ? (
                <motion.div
                  id="zoomMenu"
                  role="menu"
                  initial={{ opacity: 0, y: -6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.96 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute right-0 top-[calc(100%+6px)] bg-surface ring-1 ring-line-2 rounded-xl shadow-xl py-1.5 z-[200] min-w-[160px] overflow-hidden origin-top-right"
                >
                  <div className="px-3 pt-1.5 pb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-3">Zoom level</div>
                  {ZOOM_OPTIONS.map((option, idx) => (
                    <motion.button
                      key={option.value}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.02, duration: 0.18 }}
                      className={`zoom-opt${zoomPct === option.value ? ' active' : ''}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setZoomPct(option.value)
                        setZoomMenuOpen(false)
                      }}
                    >
                      {option.label}
                    </motion.button>
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>
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
            {displayView === 'dashboard' ? (
              <DashboardView
                onOpenSku={(sku) => {
                  if (!sku) return
                  setAnalysisInitialSku(sku)
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
                onDateFilterChange={setDateFilter}
                onResolvedDateRangeChange={setOrdersDateRange}
                selectedOrderIds={selectedOrderIds}
                onSelectedOrderIdsChange={setSelectedOrderIds}
                activeOrderId={activeOrderId}
                onActiveOrderIdChange={setActiveOrderId}
                onNavigateView={(view) => {
                  if (view === 'orders') navigate(`/orders/${currentStatus}`)
                  else navigate(VIEW_PATHS[view as Exclude<ViewType, 'orders'>] ?? '/')
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
              />
            ) : displayView === 'inventory' ? (
              <InventoryView searchQuery={searchQuery} onOpenOrder={openOrderFromContentView} />
            ) : displayView === 'locations' ? (
              <LocationsView />
            ) : displayView === 'packages' ? (
              <PackagesView onOpenOrder={openOrderFromContentView} />
            ) : displayView === 'rates' ? (
              <RatesView />
            ) : displayView === 'analysis' ? (
              <AnalysisView initialSearch={analysisInitialSku} />
            ) : displayView === 'settings' ? (
              <SettingsView />
            ) : displayView === 'billing' ? (
              <BillingView />
            ) : (
              <PlaceholderView title={viewTitle} />
            )}
          </motion.div>
        </AnimatePresence>

        <ManifestsView
          open={manifestOpen}
          onClose={() => {
            const target =
              lastContentView === 'orders'
                ? `/orders/${currentStatus}`
                : VIEW_PATHS[lastContentView as Exclude<ViewType, 'orders'>] ?? '/'
            navigate(target)
          }}
        />
      </div>
    </>
  )
}
