import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '../../../api/client'
import { endpointQueryKeys } from '../../../lib/endpoint-query-keys'
import { queryClient } from '../../../lib/query-client'
import { useAuth } from '../../../lib/auth'
import {
  buildSidebarSections,
  SIDEBAR_STATUSES,
  type SidebarOrderStatus,
} from '../sidebar-data'

// TODO PS-257: InitCountsDto / InitStoreDto are not (yet) exported from
// ../../../types/api. Locally aliased to the same structural `any`-record
// shape that file uses for its DTO shims so this surface can drop the
// type-suppression directive without changing emitted JS.
type InitCountsDto = Record<string, any>
type InitStoreDto = Record<string, any>

export type SidebarViewType =
  | 'orders'
  | 'dashboard'
  | 'inventory'
  | 'clients'
  | 'locations'
  | 'packages'
  | 'rates'
  | 'analysis'
  | 'settings'
  | 'automations'
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
  const lastCountsLoadRef = useRef(0)

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
      if (document.visibilityState !== 'visible') return
      lastCountsLoadRef.current = Date.now()
      try {
        const filter = { dateStart, dateEnd }
        setCounts(await queryClient.fetchQuery({
          queryKey: endpointQueryKeys.counts(filter),
          queryFn: () => apiClient.fetchCounts(filter),
          staleTime: 120_000,
        }))
      } catch (error) {
        console.error('Failed to fetch sidebar counts:', error)
      }
    }
    const initialTimerId = window.setTimeout(() => {
      void loadCounts()
    }, 2500)
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadCounts()
    }, 180_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCountsLoadRef.current > 120_000) {
        void loadCounts()
      }
    }
    // Real-time refresh on client active-toggle: dispatched from
    // InventoryView's handleToggleClientActive after a successful PATCH.
    // Without this listener the user would see the toggled client
    // linger in the sidebar count tree for up to 10 seconds before
    // the interval-driven refresh dropped it.
    const onClientActiveChanged = () => {
      void queryClient.invalidateQueries({ queryKey: endpointQueryKeys.countsRoot })
      void loadCounts()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('prepship:client-active-changed', onClientActiveChanged)
    return () => {
      window.clearTimeout(initialTimerId)
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('prepship:client-active-changed', onClientActiveChanged)
    }
  }, [dateStart, dateEnd])

  const sidebarSections = useMemo(
    () => buildSidebarSections(stores as Parameters<typeof buildSidebarSections>[0], counts),
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
