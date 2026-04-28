// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '../../api/client'
import { useAuth } from '../../lib/auth'
import type { InitCountsDto, InitStoreDto } from '../../types/api'
import { buildSidebarSections, SIDEBAR_STATUSES, type SidebarOrderStatus } from './sidebar-data'

type ViewType = 'orders' | 'inventory' | 'locations' | 'packages' | 'rates' | 'analysis' | 'settings' | 'billing' | 'manifests'

interface SidebarProps {
  currentStatus: SidebarOrderStatus
  currentView: ViewType
  stores: InitStoreDto[]
  onShowView: (view: ViewType) => void
  onSelectStatus: (status: SidebarOrderStatus) => void
  mobileMenuOpen: boolean
  onCloseMobileMenu?: () => void
  onSearch?: (query: string) => void
  onSelectStore?: (storeId: number | null, status?: SidebarOrderStatus) => void
  activeStore?: number | null
}

const STATUS_LABELS: Record<SidebarOrderStatus, string> = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
}

const TOOL_ITEMS: Array<{ view: ViewType; icon: string; label: string }> = [
  { view: 'inventory', icon: '📦', label: 'Inventory' },
  { view: 'locations', icon: '📍', label: 'Locations' },
  { view: 'packages', icon: '📐', label: 'Packages' },
  { view: 'rates', icon: '💰', label: 'Rate Shop' },
  { view: 'analysis', icon: '📊', label: 'Analysis' },
  { view: 'settings', icon: '⚙️', label: 'Settings' },
  { view: 'billing', icon: '🧾', label: 'Billing' },
]

export default function Sidebar({
  currentStatus,
  currentView,
  stores,
  onSelectStatus,
  onShowView,
  mobileMenuOpen,
  onCloseMobileMenu,
  onSearch,
  onSelectStore,
  activeStore,
}: SidebarProps) {
  const [expandedSections, setExpandedSections] = useState<Set<SidebarOrderStatus>>(new Set(['awaiting_shipment']))
  const [counts, setCounts] = useState<InitCountsDto | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const { user, session, signOut } = useAuth()
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)

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
        setCounts(await apiClient.fetchCounts())
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
  }, [])

  const sidebarSections = useMemo(() => buildSidebarSections(stores, counts), [stores, counts])

  return (
    <div className={`sidebar${mobileMenuOpen ? ' mobile-open' : ''}`}>
      <div className="sidebar-logo">
        <div className="logo-wordmark">PREP<span>SHIP</span></div>
        <div className="logo-sub">DR PREPPER Fulfillment</div>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search Orders…"
          value={searchValue}
          onChange={(event) => {
            setSearchValue(event.target.value)
            onSearch?.(event.target.value)
          }}
        />
        {searchValue ? (
          <button
            type="button"
            className="react-sidebar-clear"
            onClick={() => {
              setSearchValue('')
              onSearch?.('')
            }}
            aria-label="Clear search"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="sidebar-nav">
        {SIDEBAR_STATUSES.map((status) => (
          <div key={status} className={`ss-section${expandedSections.has(status) ? ' expanded' : ''}`}>
            <div
              className={`ss-header${currentView === 'orders' && currentStatus === status && activeStore == null ? ' active' : ''}`}
              onClick={() => {
                onSelectStatus(status)
                onCloseMobileMenu?.()
              }}
            >
              <span
                className="ss-arrow"
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
              <span className="ss-label">{STATUS_LABELS[status]}</span>
              <span className="ss-badge">{counts ? sidebarSections[status].total.toLocaleString() : '—'}</span>
            </div>

            <div className="ss-stores">
              {sidebarSections[status].stores.map((store) => {
                return (
                  <div
                    key={`${status}-${store.storeId}`}
                    className={`ss-store${currentView === 'orders' && activeStore === store.storeId && currentStatus === status ? ' active' : ''}${store.cnt === 0 ? ' ss-store-zero' : ''}`}
                    onClick={() => {
                      onSelectStatus(status)
                      onSelectStore?.(store.storeId, status)
                      onCloseMobileMenu?.()
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="ss-store-name">{store.name}</span>
                    <span className="ss-store-count">{store.cnt > 0 ? store.cnt.toLocaleString() : ''}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        <div className="sidebar-divider" />

        <div className="sidebar-tools">
          {TOOL_ITEMS.map((tool) => (
            <div
              key={tool.view}
              className={`sidebar-tool-item${currentView === tool.view ? ' active' : ''}`}
              onClick={() => {
                onShowView(tool.view)
                onCloseMobileMenu?.()
              }}
            >
              <span className="sidebar-tool-icon">{tool.icon}</span> {tool.label}
            </div>
          ))}
          <div
            className="sidebar-tool-item"
            onClick={() => {
              onShowView('manifests')
              onCloseMobileMenu?.()
            }}
          >
            <span className="sidebar-tool-icon">📋</span> Manifests
          </div>
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
