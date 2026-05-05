// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Search as SearchIcon,
  X as XIcon,
  Package,
  MapPin,
  Ruler,
  DollarSign,
  BarChart3,
  Settings as SettingsIcon,
  Receipt,
  ClipboardList,
  Box,
  ChevronRight,
  LogOut,
  LayoutDashboard,
} from 'lucide-react'
import { apiClient } from '../../api/client'
import { useAuth } from '../../lib/auth'
import type { InitCountsDto, InitStoreDto } from '../../types/api'
import { buildSidebarSections, SIDEBAR_STATUSES, type SidebarOrderStatus } from './sidebar-data'

type ViewType = 'orders' | 'dashboard' | 'inventory' | 'locations' | 'packages' | 'rates' | 'analysis' | 'settings' | 'billing' | 'manifests'

interface SidebarProps {
  currentStatus: SidebarOrderStatus
  currentView: ViewType
  stores: InitStoreDto[]
  onShowView: (view: ViewType) => void
  onSelectStatus: (status: SidebarOrderStatus) => void
  mobileMenuOpen: boolean
  onCloseMobileMenu?: () => void
  searchValue?: string
  onSearch?: (query: string) => void
  onSelectStore?: (storeId: number | null, status?: SidebarOrderStatus) => void
  activeStore?: number | null
  dateStart?: string
  dateEnd?: string
  showTestOrders?: boolean
  onShowTestOrdersChange?: (show: boolean) => void
}

const STATUS_LABELS: Record<SidebarOrderStatus, string> = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
}

const TOOL_ITEMS: Array<{ view: ViewType; Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; label: string }> = [
  { view: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'inventory', Icon: Package, label: 'Inventory' },
  { view: 'locations', Icon: MapPin, label: 'Locations' },
  { view: 'packages', Icon: Ruler, label: 'Packages' },
  { view: 'rates', Icon: DollarSign, label: 'Rate Shop' },
  { view: 'analysis', Icon: BarChart3, label: 'Analysis' },
  { view: 'settings', Icon: SettingsIcon, label: 'Settings' },
  { view: 'billing', Icon: Receipt, label: 'Billing' },
]

function isTestOrdersStore(store: { storeId: number; name: string; isTest?: boolean }) {
  return store.name.trim().toLowerCase() === 'test orders'
}

export default function Sidebar({
  currentStatus,
  currentView,
  stores,
  onSelectStatus,
  onShowView,
  mobileMenuOpen,
  onCloseMobileMenu,
  searchValue,
  onSearch,
  onSelectStore,
  activeStore,
  dateStart,
  dateEnd,
  showTestOrders = true,
  onShowTestOrdersChange,
}: SidebarProps) {
  const [expandedSections, setExpandedSections] = useState<Set<SidebarOrderStatus>>(new Set(['awaiting_shipment']))
  const [counts, setCounts] = useState<InitCountsDto | null>(null)
  const [localSearchValue, setLocalSearchValue] = useState('')
  const { user, session, signOut } = useAuth()
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)
  const effectiveSearchValue = searchValue ?? localSearchValue

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  useEffect(() => {
    const loadCounts = async () => {
      try {
        setCounts(await apiClient.fetchCounts({ dateStart, dateEnd }))
      } catch (error) {
        console.error('Failed to fetch sidebar counts:', error)
      }
    }

    void loadCounts()
    // 10s interval — tight enough to feel real-time without hammering the DB.
    const intervalId = window.setInterval(() => {
      void loadCounts()
    }, 10000)

    // Refetch immediately whenever the tab becomes visible or regains focus,
    // so a returning user always sees current numbers before the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadCounts()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [dateStart, dateEnd])

  const sidebarSections = useMemo(() => buildSidebarSections(stores, counts), [stores, counts])

  const toggleTestOrders = (event) => {
    event.stopPropagation()
    onShowTestOrdersChange?.(!showTestOrders)
  }

  return (
    <div className={`sidebar !font-sans !bg-white !border-r !border-line antialiased tracking-[-0.005em]${mobileMenuOpen ? ' mobile-open' : ''}`}>
      <div className="sidebar-logo !p-0 !border-b-0 relative overflow-hidden">
        <div className="bg-gradient-to-br from-[#0a1530] via-[#10234a] to-[#1a48c0] px-4 pt-4 pb-3.5 relative">
          {/* subtle radial glow overlay */}
          <div className="pointer-events-none absolute -top-8 -right-6 w-32 h-32 rounded-full bg-brand/30 blur-3xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-10 -left-4 w-24 h-24 rounded-full bg-indigo-400/20 blur-2xl" aria-hidden />
          <div className="relative flex items-center gap-2.5">
            <motion.div
              initial={{ rotate: -8, scale: 0.85 }}
              animate={{ rotate: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 18 }}
              className="w-7 h-7 rounded-[7px] bg-white/95 flex items-center justify-center shadow-md ring-1 ring-white/40"
            >
              <Box size={16} strokeWidth={2.25} className="text-brand" />
            </motion.div>
            <div className="logo-wordmark !text-white !text-[18px] !font-extrabold !tracking-[-0.04em] font-display !leading-none">
              PREP<span className="!text-white/70 !font-light">SHIP</span>
            </div>
          </div>
          <div className="logo-sub !text-white/65 !mt-2 !text-[10px] !font-medium font-sans uppercase !tracking-[0.12em] flex items-center gap-1.5">
            <span className="inline-block w-1 h-1 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            DR PREPPER · Fulfillment
          </div>
        </div>
      </div>

      <div className="sidebar-search !px-2.5 !pt-3 !pb-1.5 !relative">
        <SearchIcon
          size={13}
          strokeWidth={2.25}
          className="!absolute !left-5 !top-1/2 !-translate-y-1/2 !text-ink-3 !pointer-events-none !mt-px"
          aria-hidden
        />
        <input
          type="text"
          placeholder="Search orders, SKUs, tracking…"
          value={effectiveSearchValue}
          onChange={(event) => {
            const next = event.target.value
            if (searchValue === undefined) setLocalSearchValue(next)
            onSearch?.(next)
          }}
          aria-label="Search orders"
          className="!w-full !pl-8 !pr-7 !py-2 !rounded-lg !border !border-line !bg-page/60 !text-[12px] !text-ink placeholder:!text-ink-3 placeholder:!font-normal focus:!bg-white focus:!border-brand/50 focus:!ring-2 focus:!ring-brand/15 !transition-all !duration-150 !outline-none"
        />
        {effectiveSearchValue ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileTap={{ scale: 0.85 }}
            transition={{ duration: 0.12 }}
            className="!absolute !right-5 !top-1/2 !-translate-y-1/2 !mt-px !p-0.5 !rounded !text-ink-3 hover:!text-ink hover:!bg-line/40 !transition-colors !duration-150"
            onClick={() => {
              if (searchValue === undefined) setLocalSearchValue('')
              onSearch?.('')
            }}
            aria-label="Clear search"
          >
            <XIcon size={13} strokeWidth={2.5} />
          </motion.button>
        ) : null}
      </div>

      <div className="sidebar-nav !pt-2 !px-2">
        {SIDEBAR_STATUSES.map((status) => {
          const isActive = currentView === 'orders' && currentStatus === status && activeStore == null
          return (
          <div key={status} className={`ss-section !mb-0.5${expandedSections.has(status) ? ' expanded' : ''}`}>
            <div
              className={`ss-header !rounded-lg !mx-0 !my-0.5 !px-2.5 !py-2 !border-l-0 !text-[12.5px] !font-semibold !transition-all !duration-150 ${isActive ? '!bg-gradient-to-r !from-brand !to-indigo-600 !text-white !shadow-[0_2px_8px_-2px_rgba(42,91,215,0.45)]' : '!text-ink-2 hover:!bg-line/40 hover:!text-ink'}${isActive ? ' active' : ''}`}
              onClick={() => {
                onSelectStatus(status)
                onCloseMobileMenu?.()
              }}
            >
              <span
                className={`ss-arrow !text-[9px] !w-4 !mr-1 !p-0.5 !rounded ${isActive ? '!text-white/70' : '!text-ink-3'}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setExpandedSections((current) => {
                    const next = new Set(current)
                    if (next.has(status)) next.delete(status)
                    else next.add(status)
                    return next
                  })
                }}
              >
                ▶
              </span>
              <span className="ss-label !flex-1">{STATUS_LABELS[status]}</span>
              <span className={`ss-badge !rounded-md !min-w-[24px] !px-1.5 !py-0.5 !text-[10px] !font-bold font-mono tabular-nums ${isActive ? '!bg-white/25 !text-white !backdrop-blur-sm' : '!bg-line/60 !text-ink-2'}`}>
                {counts ? sidebarSections[status].total.toLocaleString() : '—'}
              </span>
            </div>

            <div className="ss-stores">
              {sidebarSections[status].stores.map((store) => {
                const isTestStore = isTestOrdersStore(store)
                const testOrdersToggle = isTestStore ? (
                  <button
                    type="button"
                    className={`ss-test-toggle${showTestOrders ? ' is-on' : ' is-off'}`}
                    aria-label={showTestOrders ? 'Hide Test Orders from all shipments' : 'Show Test Orders in all shipments'}
                    aria-pressed={showTestOrders}
                    title={showTestOrders ? 'Hide Test Orders from all shipments' : 'Show Test Orders in all shipments'}
                    onClick={toggleTestOrders}
                  >
                    <span className="ss-test-toggle-knob" />
                  </button>
                ) : null

                const storeActive = currentView === 'orders' && activeStore === store.storeId && currentStatus === status
                return (
                  <div
                    key={`${status}-${store.storeId}`}
                    className={`ss-store !ml-5 !mr-0 !rounded-md !my-px !pl-3 !pr-2 !py-1 !text-[11.5px] !border-l-0 !transition-colors !duration-100 ${storeActive ? '!bg-brand-bg !text-brand !font-semibold' : '!text-ink-2 hover:!bg-line/40 hover:!text-ink'}${isTestStore ? ' ss-store-test' : ''}${isTestStore && !showTestOrders ? ' ss-store-test-off' : ''}${storeActive ? ' active' : ''}${store.cnt === 0 ? ' ss-store-zero' : ''}`}
                    onClick={() => {
                      onSelectStatus(status)
                      onSelectStore?.(store.storeId, status)
                      onCloseMobileMenu?.()
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="ss-store-name !truncate">{store.name}</span>
                    {testOrdersToggle}
                    <span className={`ss-store-count font-mono tabular-nums !text-[10px] !font-bold ${storeActive ? '!text-brand' : '!text-ink-3'}`}>
                      {store.cnt > 0 ? store.cnt.toLocaleString() : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          )
        })}

        <div className="sidebar-divider !my-3 !mx-2 !h-px !bg-line" />

        <div className="sidebar-tools !px-0">
          <div className="px-2.5 pt-1 pb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-3">Tools</div>
          {TOOL_ITEMS.map((tool) => {
            const active = currentView === tool.view
            const ToolIcon = tool.Icon
            return (
              <motion.div
                key={tool.view}
                whileHover={{ x: 1 }}
                whileTap={{ scale: 0.98 }}
                transition={{ duration: 0.12 }}
                role="button"
                tabIndex={0}
                aria-current={active ? 'page' : undefined}
                aria-label={`Navigate to ${tool.label}`}
                className={`sidebar-tool-item !rounded-lg !mx-0 !my-0.5 !px-2.5 !py-1.5 !text-[12px] !font-medium !transition-colors !duration-150 !flex !items-center !gap-2 !cursor-pointer ${active ? '!bg-brand-bg !text-brand !ring-1 !ring-brand/30' : '!text-ink-2 hover:!bg-line/40 hover:!text-ink'}${active ? ' active' : ''}`}
                onClick={() => {
                  onShowView(tool.view)
                  onCloseMobileMenu?.()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onShowView(tool.view)
                    onCloseMobileMenu?.()
                  }
                }}
              >
                <ToolIcon size={14} strokeWidth={2.25} className={active ? '' : 'opacity-80'} />
                {tool.label}
                {active ? <ChevronRight size={12} strokeWidth={2.5} className="ml-auto" /> : null}
              </motion.div>
            )
          })}
          <motion.div
            whileHover={{ x: 1 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="button"
            tabIndex={0}
            aria-label="Navigate to Manifests"
            className="sidebar-tool-item !rounded-lg !mx-0 !my-0.5 !px-2.5 !py-1.5 !text-[12px] !font-medium !transition-colors !duration-150 !flex !items-center !gap-2 !cursor-pointer !text-ink-2 hover:!bg-line/40 hover:!text-ink"
            onClick={() => {
              onShowView('manifests')
              onCloseMobileMenu?.()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onShowView('manifests')
                onCloseMobileMenu?.()
              }
            }}
          >
            <ClipboardList size={14} strokeWidth={2.25} className="opacity-80" />
            Manifests
          </motion.div>
        </div>
      </div>

      <div className="sidebar-bottom">
        <div><span className="conn-dot" />ShipStation Connected</div>
        <div style={{ marginTop: 2 }}>DR PREPPER USA · Gardena CA</div>
        {session ? (
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              textAlign: 'left',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-secondary, #374151)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={user?.email ?? ''}
              >
                {user?.email ?? 'Signed in'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              title="Sign out"
              aria-label="Sign out"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '5px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--surface, #fff)',
                color: 'var(--text-secondary, #374151)',
                cursor: signingOut ? 'not-allowed' : 'pointer',
                opacity: signingOut ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {signingOut ? 'Signing out…' : '↪ Sign out'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
