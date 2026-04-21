// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { apiClient } from '../../api/client'
import type { InitCountsDto, InitStoreDto } from '../../types/api'
import { buildSidebarSections, SIDEBAR_STATUSES, type SidebarOrderStatus } from './sidebar-data'
import {
  IconBadge,
  IconCheckCircle,
  IconChevronRight,
  IconInbox,
  IconXCircle,
  type IconTone,
} from './sidebar-icons'

const STATUS_META: Record<
  SidebarOrderStatus,
  { label: string; icon: ReactNode; tone: IconTone }
> = {
  awaiting_shipment: { label: 'Awaiting', icon: <IconInbox />, tone: 'amber' },
  shipped: { label: 'Shipped', icon: <IconCheckCircle />, tone: 'emerald' },
  cancelled: { label: 'Cancelled', icon: <IconXCircle />, tone: 'rose' },
}

interface SidebarOrdersProps {
  currentStatus: SidebarOrderStatus
  isOrdersView: boolean
  activeStore: number | null | undefined
  stores: InitStoreDto[]
  onSelectStatus: (status: SidebarOrderStatus) => void
  onSelectStore: (status: SidebarOrderStatus, storeId: number) => void
  filter?: string
  dateStart?: string
  dateEnd?: string
}

function CountBadge({ count, active }: { count: number | null; active: boolean }) {
  return (
    <span
      className={[
        'inline-flex h-[22px] min-w-[40px] items-center justify-center rounded-full px-3 text-[12px] font-bold tabular-nums ml-2 transition-colors',
        active
          ? 'bg-indigo-600 text-white dark:bg-indigo-500'
          : 'bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)]',
      ].join(' ')}
    >
      {count != null ? count.toLocaleString() : '—'}
    </span>
  )
}

function StoreItem({
  store,
  active,
  onClick,
}: {
  store: { storeId: number; name: string; cnt: number }
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex h-9 w-full items-center justify-start gap-2 rounded-lg pl-14 pr-3 text-[12.5px] transition-colors',
        active
          ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
          : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-primary)]',
      ].join(' ')}
    >
      <div
        className={[
          'flex shrink-0 items-center justify-center w-4 text-[14px] transition-all',
          active ? 'opacity-100 text-indigo-600' : 'opacity-30',
        ].join(' ')}
      >
        &bull;
      </div>
      <span className="flex-1 truncate text-left text-[13px]">{store.name}</span>
      {store.cnt > 0 && <CountBadge count={store.cnt} active={active} />}
    </button>
  )
}

function StatusSection({
  status,
  meta,
  section,
  isOrdersView,
  currentStatus,
  activeStore,
  filter,
  expanded,
  stores,
  onToggle,
  onSelectStatus,
  onSelectStore,
}: {
  status: SidebarOrderStatus
  meta: { label: string; icon: ReactNode; tone: IconTone }
  section: { total: number; stores: { storeId: number; name: string; cnt: number }[] }
  isOrdersView: boolean
  currentStatus: SidebarOrderStatus
  activeStore: number | null | undefined
  filter: string
  expanded: boolean
  stores: InitStoreDto[]
  onToggle: () => void
  onSelectStatus: (status: SidebarOrderStatus) => void
  onSelectStore: (status: SidebarOrderStatus, storeId: number) => void
}) {
  const isStatusActive = isOrdersView && currentStatus === status
  const isFullyActive = isStatusActive && activeStore == null
  const isDrilledIn = isStatusActive && activeStore != null

  const storeList = filter
    ? section.stores.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : section.stores

  if (filter && storeList.length === 0 && !meta.label.toLowerCase().includes(filter.toLowerCase())) {
    return null
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelectStatus(status)
          onToggle()
        }}
        className={[
          'group flex h-11 w-full items-center justify-start gap-3 rounded-xl px-3 transition-colors',
          isFullyActive
            ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
            : isDrilledIn
              ? 'bg-indigo-50/50 text-indigo-600 dark:bg-indigo-500/5 dark:text-indigo-300/80'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-primary)]',
        ].join(' ')}
      >
        <div
          className={[
            'flex shrink-0 items-center justify-center transition-transform duration-200',
            expanded ? 'rotate-90 text-indigo-600' : 'rotate-0 opacity-40',
          ].join(' ')}
        >
          <IconChevronRight />
        </div>
        <IconBadge tone={meta.tone} active={isStatusActive}>
          {meta.icon}
        </IconBadge>
        <span className="flex-1 truncate text-left text-[14.5px]">{meta.label}</span>
        <CountBadge count={section.total} active={isFullyActive} />
      </button>

      {expanded && stores.length > 0 && storeList.length > 0 && (
        <div className="mt-1 mb-2 flex flex-col gap-0.5">
          {storeList.map((store) => (
            <StoreItem
              key={`${status}-${store.storeId}`}
              store={store}
              active={isOrdersView && activeStore === store.storeId && currentStatus === status}
              onClick={() => onSelectStore(status, store.storeId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function SidebarOrders({
  currentStatus,
  isOrdersView,
  activeStore,
  stores,
  onSelectStatus,
  onSelectStore,
  filter = '',
  dateStart,
  dateEnd,
}: SidebarOrdersProps) {
  const [counts, setCounts] = useState<InitCountsDto | null>(null)
  const [expanded, setExpanded] = useState<Set<SidebarOrderStatus>>(
    () => new Set(['awaiting_shipment']),
  )

  useEffect(() => {
    const dateFilter = { dateStart, dateEnd }
    const load = async () => {
      try {
        setCounts(await apiClient.fetchCounts(dateFilter))
      } catch (error) {
        console.error('Failed to fetch sidebar counts:', error)
      }
    }
    void load()
    const id = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(id)
  }, [dateStart, dateEnd])

  const sections = useMemo(() => buildSidebarSections(stores, counts), [stores, counts])

  const grandTotal = useMemo(() => {
    if (!counts) return null
    return SIDEBAR_STATUSES.reduce((sum, s) => sum + sections[s].total, 0)
  }, [counts, sections])

  const toggleExpanded = (status: SidebarOrderStatus) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // "All" should be visible if no filter or if "all" matches the filter
  const showAll = !filter || 'all orders'.includes(filter.toLowerCase())

  return (
    <div>
      {/* <div className="mb-3 flex items-center justify-between px-1">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          <span className="text-white dark:text-white">&bull;</span>&ensp;Orders
        </span>
        {grandTotal != null && (
          <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {grandTotal.toLocaleString()} total
          </span>
        )}
      </div> */}

      <div className="flex flex-col gap-1">
        {SIDEBAR_STATUSES.map((status) => (
          <StatusSection
            key={status}
            status={status}
            meta={STATUS_META[status]}
            section={sections[status]}
            isOrdersView={isOrdersView}
            currentStatus={currentStatus}
            activeStore={activeStore}
            filter={filter}
            expanded={expanded.has(status)}
            stores={stores}
            onToggle={() => toggleExpanded(status)}
            onSelectStatus={onSelectStatus}
            onSelectStore={onSelectStore}
          />
        ))}
      </div>
    </div>
  )
}
