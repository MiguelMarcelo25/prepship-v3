// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '../../../api/client'
import { useAuth } from '../../../lib/auth'
import type { InitCountsDto, InitStoreDto } from '../../../types/api'
import {
  buildSidebarSections,
  SIDEBAR_STATUSES,
  type SidebarOrderStatus,
} from '../sidebar-data'

export type SidebarViewType =
  | 'orders'
  | 'dashboard'
  | 'inventory'
  | 'locations'
  | 'packages'
  | 'rates'
  | 'analysis'
  | 'settings'
  | 'billing'
  | 'manifests'

export interface SidebarVariantProps {
  currentStatus: SidebarOrderStatus
  currentView: SidebarViewType
  stores: InitStoreDto[]
  onShowView: (view: SidebarViewType) => void
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

/**
 * All shared state, polling, and handlers used by every sidebar variant.
 * Variants stay purely presentational — they read what they need from the
 * controller's return value and render with their own visual language.
 */
export function useSidebarController(props: SidebarVariantProps) {
  const {
    currentStatus,
    currentView,
    stores,
    activeStore = null,
    dateStart,
    dateEnd,
    searchValue,
    onSearch,
    onSelectStatus,
    onSelectStore,
    onShowView,
    onCloseMobileMenu,
    mobileMenuOpen,
    showTestOrders = true,
    onShowTestOrdersChange,
  } = props

  const [expandedSections, setExpandedSections] = useState<Set<SidebarOrderStatus>>(
    new Set(['awaiting_shipment']),
  )
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
    const intervalId = window.setInterval(() => {
      void loadCounts()
    }, 10000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadCounts()
    }
    // Real-time refresh on client active-toggle: dispatched from
    // InventoryView's handleToggleClientActive after a successful PATCH.
    // Without this listener the user would see the toggled client
    // linger in the sidebar count tree for up to 10 seconds before
    // the interval-driven refresh dropped it.
    const onClientActiveChanged = () => {
      void loadCounts()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('prepship:client-active-changed', onClientActiveChanged)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('prepship:client-active-changed', onClientActiveChanged)
    }
  }, [dateStart, dateEnd])

  const sidebarSections = useMemo(
    () => buildSidebarSections(stores, counts),
    [stores, counts],
  )

  const toggleSection = (status: SidebarOrderStatus) => {
    setExpandedSections((current) => {
      const next = new Set(current)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const setSearch = (value: string) => {
    if (searchValue === undefined) setLocalSearchValue(value)
    onSearch?.(value)
  }

  const clearSearch = () => setSearch('')

  const handleSelectStatus = (status: SidebarOrderStatus) => {
    onSelectStatus(status)
    onCloseMobileMenu?.()
  }

  const handleSelectStore = (storeId: number, status: SidebarOrderStatus) => {
    onSelectStatus(status)
    onSelectStore?.(storeId, status)
    onCloseMobileMenu?.()
  }

  const handleShowView = (view: SidebarViewType) => {
    onShowView(view)
    onCloseMobileMenu?.()
  }

  const toggleTestOrders = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation()
    onShowTestOrdersChange?.(!showTestOrders)
  }

  const isTestOrdersStore = (store: { storeId: number; name: string; isTest?: boolean }) =>
    store.name.trim().toLowerCase() === 'test orders'

  return {
    // state
    currentStatus,
    currentView,
    activeStore,
    counts,
    sidebarSections,
    expandedSections,
    effectiveSearchValue,
    showTestOrders,
    mobileMenuOpen,

    // session
    user,
    session,
    signingOut,

    // statuses constant
    SIDEBAR_STATUSES,

    // handlers
    handleSelectStatus,
    handleSelectStore,
    handleShowView,
    handleSignOut,
    toggleSection,
    toggleTestOrders,
    setSearch,
    clearSearch,
    isTestOrdersStore,
  }
}
