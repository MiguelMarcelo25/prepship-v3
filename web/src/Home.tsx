// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ToastContext } from './contexts/ToastContext'
import { apiClient } from './api/client'
import type { SyncWorkerStatusDto } from './types/api'
import { useInitStores } from './hooks'
import Sidebar from './components/Sidebar/Sidebar'
import OrdersView from './components/Views/OrdersView'
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

type ViewType = 'orders' | 'inventory' | 'locations' | 'packages' | 'rates' | 'analysis' | 'settings' | 'billing' | 'manifests'
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
  inventory: 'Inventory',
  locations: 'Locations',
  packages: 'Packages',
  rates: 'Rates',
  analysis: 'Analysis',
  settings: 'Settings',
  billing: 'Billing',
}

const VIEW_PATHS: Record<Exclude<ViewType, 'orders'>, string> = {
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
  const [dateFilter, setDateFilter] = useState<OrdersDateFilter>('last-30')
  const [ordersDateRange, setOrdersDateRange] = useState<{ start?: string; end?: string }>(
    () => getResolvedDateRange('last-30'),
  )
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([])
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
  const [columnMenuRequestId, setColumnMenuRequestId] = useState(0)
  const [labelsActionRequestId, setLabelsActionRequestId] = useState(0)
  const [queueToggleRequestId, setQueueToggleRequestId] = useState(0)
  const [queueBadgeCount, setQueueBadgeCount] = useState(0)
  const [queueOpen, setQueueOpen] = useState(false)
  const [ordersRefreshVersion, setOrdersRefreshVersion] = useState(0)
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
      document.body.style.zoom = ''
      document.body.style.height = ''
      return
    }

    document.body.style.zoom = `${zoomPct}%`
    document.body.style.height = `${(10000 / zoomPct).toFixed(2)}vh`

    return () => {
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
    setSelectedOrderIds([])
    setActiveOrderId(null)
  }, [displayView, currentStatus, activeStore, dateFilter])

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
        onSelectStore={(storeId, statusOverride) => {
          setActiveStore(storeId)
          navigate(`/orders/${statusOverride ?? currentStatus}`)
          closeMobileMenu()
        }}
        activeStore={activeStore}
        dateStart={ordersDateRange.start}
        dateEnd={ordersDateRange.end}
      />

      <div className="main bg-bg-base text-text-primary">
        <div className="topbar relative">
          {syncStatus.status === 'syncing' && syncStatus.total > 0 && (
            <div 
              className="absolute top-0 left-0 h-1 bg-indigo-600 transition-all duration-300 z-50" 
              style={{ width: `${Math.min(100, (syncStatus.page / syncStatus.total) * 100)}%` }} 
            />
          )}
          <button
            id="mobileMenuBtn"
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            style={{ alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 4, color: 'var(--text)' }}
            aria-label="Toggle menu"
          >
            ☰
          </button>

          <div className="topbar-title" id="viewTitle">{viewTitle}</div>

          <div className={`batch-bar${displayView === 'orders' && selectedOrderIds.length > 0 ? ' show' : ''}`} id="batchBar">
            <span id="batchCount">{selectedOrderIds.length} selected</span>
            <div className="batch-btns">
              <button className="batch-btn" type="button">🗂️ Batch</button>
              <button className="batch-btn" type="button">🖨️ Print</button>
              <button
                className="batch-btn"
                type="button"
                onClick={() => {
                  setSelectedOrderIds([])
                  setActiveOrderId(null)
                }}
              >
                ✕
              </button>
            </div>
          </div>

          {displayView === 'orders' ? (
            <div className="topbar-right" id="topbarActions">
              <div className={syncPill.className} id="syncPill">
                <span className="sync-dot" />
                <span id="syncText">
                  {syncPill.text}
                  {syncStatus.status === 'syncing' && syncStatus.total > 0 && (
                    <span className="ml-1.5 opacity-70">
                      ({syncStatus.page}/{syncStatus.total})
                    </span>
                  )}
                </span>
              </div>
              {workerPill ? (
                <div
                  id="workerPill"
                  title={workerPill.title}
                  style={{
                    fontSize: 11,
                    padding: '3px 9px',
                    borderRadius: 999,
                    background: 'var(--surface2, #f3f4f6)',
                    color: workerPill.color,
                    border: '1px solid var(--border, #e5e7eb)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {workerPill.text}
                </div>
              ) : null}
              <button
                className="btn btn-ghost btn-sm"
                id="btnSyncIncr"
                type="button"
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
                ↻
              </button>
              <button
                className="btn btn-ghost btn-sm"
                id="btnSyncFull"
                type="button"
                style={{ fontSize: 11, padding: '4px 8px', color: 'var(--text3)' }}
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
                Full↻
              </button>
              <div className="col-toggle-wrap">
                <button data-columns-anchor="true" className="btn btn-outline btn-sm" type="button" onClick={() => setColumnMenuRequestId((value) => value + 1)}>⊞ Columns</button>
              </div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => setLabelsActionRequestId((value) => value + 1)}>🖨️ Labels</button>
              <button className="btn btn-outline btn-sm" id="pq-toggle-btn" type="button" style={{ position: 'relative', gap: 4 }} onClick={() => setQueueToggleRequestId((value) => value + 1)}>
                {queueOpen ? '✕ Close Queue' : `🖨️ Print Queue${queueBadgeCount > 0 ? ` (${queueBadgeCount})` : ''}`}
                <span
                  id="pq-badge"
                  style={{
                    display: queueBadgeCount > 0 ? 'inline-flex' : 'none',
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    background: '#f59e0b',
                    color: '#000',
                    borderRadius: 99,
                    fontSize: 9,
                    fontWeight: 700,
                    minWidth: 16,
                    height: 16,
                    padding: '0 3px',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {queueBadgeCount}
                </span>
              </button>
            </div>
          ) : null}

          <div className="col-toggle-wrap react-zoom-wrap" style={{ position: 'relative' }}>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={() => setZoomMenuOpen((open) => !open)}
              id="zoomBtn"
              style={{ gap: 4, minWidth: 68 }}
            >
              🔍 <span id="zoomLabel">{zoomPct}%</span>
            </button>
            <div
              id="zoomMenu"
              style={{
                display: zoomMenuOpen ? 'block' : 'none',
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 5px)',
                background: 'var(--surface)',
                border: '1px solid var(--border2)',
                borderRadius: 8,
                boxShadow: 'var(--shadow-lg)',
                padding: '5px 0',
                zIndex: 200,
                minWidth: 130,
              }}
            >
              <div style={{ padding: '4px 12px 3px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text3)' }}>Zoom</div>
              {ZOOM_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`zoom-opt${zoomPct === option.value ? ' active' : ''}`}
                  type="button"
                  onClick={() => {
                    setZoomPct(option.value)
                    setZoomMenuOpen(false)
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {displayView === 'orders' ? (
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
            onQueueStateChange={({ count, isOpen }) => {
              setQueueBadgeCount(count)
              setQueueOpen(isOpen)
            }}
            refreshVersion={ordersRefreshVersion}
          />
        ) : displayView === 'inventory' ? (
          <InventoryView searchQuery={searchQuery} />
        ) : displayView === 'locations' ? (
          <LocationsView />
        ) : displayView === 'packages' ? (
          <PackagesView
            onOpenOrder={(orderId) => {
              setActiveOrderId(orderId)
              navigate(`/orders/${currentStatus}`)
            }}
          />
        ) : displayView === 'rates' ? (
          <RatesView />
        ) : displayView === 'analysis' ? (
          <AnalysisView searchQuery={searchQuery} />
        ) : displayView === 'settings' ? (
          <SettingsView />
        ) : displayView === 'billing' ? (
          <BillingView
            onOpenOrder={(orderId) => {
              setActiveStore(null)
              setActiveOrderId(orderId)
              navigate('/orders/shipped')
            }}
          />
        ) : (
          <PlaceholderView title={viewTitle} />
        )}

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
