// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { apiClient } from '../../api/client'
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
  onSelectStore?: (storeId: number | null) => void
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

  useEffect(() => {
    const loadCounts = async () => {
      try {
        setCounts(await apiClient.fetchCounts())
      } catch (error) {
        console.error('Failed to fetch sidebar counts:', error)
      }
    }

    void loadCounts()
    const intervalId = window.setInterval(() => {
      void loadCounts()
    }, 30000)

    return () => window.clearInterval(intervalId)
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
                onSelectStore?.(null)
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
                      onSelectStore?.(store.storeId)
                      onSelectStatus(status)
                      onCloseMobileMenu?.()
                    }}
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
      </div>
    </div>
  )
}
