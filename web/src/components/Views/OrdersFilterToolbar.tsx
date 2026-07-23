// PS-166/PS-306/PS-258 (Wave 4): the Orders filter/batch/export TOOLBAR
// (the `<div id="filterbar">` block) extracted from OrdersView.tsx with
// BYTE-IDENTICAL markup — every id pin (#filterbar, #newOrderBtn, #dateFilter,
// #customDateWrap, #dateFrom/#dateTo, #colBtnFilter, #btnSelectAll,
// #btnSelectAllMatching, #btnSkuSort, #picklistBtn, #queue-progress-indicator,
// #exportBtn) and every className/attribute is preserved verbatim.
//
// PRESENTATIONAL / handlers-stay-in-parent: this file owns NO async work. The
// export, recalculate, picklist, select-all, and column-prefs persistence
// handlers remain closures in OrdersView and are threaded in as on-prefixed
// callbacks (PS-306). There is no API-client call, no batch logic, and no
// persistence in this file — the components only FIRE the parent-owned
// callbacks. The CSV export's inline body moved into OrdersView's `onExportCsv`
// closure so the network client stays out of this surface; the #exportBtn
// markup is otherwise byte-identical.
//
// The already-extracted <OrdersSearchBar> is composed here as the first child,
// reading the same search props OrdersView threads through.
import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import {
  Calendar,
  CheckSquare,
  Download,
  ListOrdered,
  Loader2,
  Plus,
  Printer as PrinterIcon,
  RefreshCcw,
  Zap,
} from 'lucide-react'
import { OrdersSearchBar } from './OrdersSearchBar'
import type { OrdersDateFilter } from './orders-view-filters'
import type { ColumnPrefs, ResolvedColumnPrefs } from './orders-parity'
import type { TableColumnKey } from './orders-table-columns'
import type { BatchRecalculateScope } from './orders-parity'
import {
  buildRecalculateAllProgressView,
  type RecalculateAllProgressState,
} from './orders-recalculate-all-progress'
import { OrdersRecalculationProgress } from './OrdersRecalculationProgress'

type QueueToolbarProgress = {
  label: string
  detail: string
  pct: number
  tone: string
}

const QUEUE_PROGRESS_HEADER_QUERY = '(min-width: 1440px)'

function useQueueProgressHeaderSlot(): boolean {
  const [useHeaderSlot, setUseHeaderSlot] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(QUEUE_PROGRESS_HEADER_QUERY).matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const query = window.matchMedia(QUEUE_PROGRESS_HEADER_QUERY)
    const update = () => setUseHeaderSlot(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return useHeaderSlot
}

type AllMatchingSelectionLike = {
  active: boolean
  scopeKey: string
} | null

type BatchRecalculateProgressLike = {
  total: number
  completed: number
  updated: number
  blocked: number
  timedOut: number
  percent: number
}

// ── Date filter + custom range ──────────────────────────────────────────────
export type OrdersFilterToolbarDateControlsProps = {
  dateFilter: OrdersDateFilter
  onDateFilterChange?: (value: OrdersDateFilter) => void
  customDateFrom: string
  onCustomDateFromChange: (value: string) => void
  customDateTo: string
  onCustomDateToChange: (value: string) => void
}

export function OrdersFilterToolbarDateControls({
  dateFilter,
  onDateFilterChange,
  customDateFrom,
  onCustomDateFromChange,
  customDateTo,
  onCustomDateToChange,
}: OrdersFilterToolbarDateControlsProps) {
  return (
    <>
      {/* Date filter dropdown */}
      <div className="relative inline-flex items-center">
        <Calendar size={11} strokeWidth={2.25} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden />
        <select
          id="dateFilter"
          value={dateFilter}
          onChange={(event) => onDateFilterChange?.(event.target.value as OrdersDateFilter)}
          aria-label="Filter by date"
          className="
            appearance-none cursor-pointer
            h-8 pl-7 pr-7
            rounded-lg
            bg-surface ring-1 ring-line
            text-[12px] font-medium text-ink-2
            hover:text-ink hover:ring-line-2
            focus:bg-surface focus:ring-2 focus:ring-brand/40
            focus:outline-none
            transition-all duration-150
          "
        >
          <option value="">All Dates</option>
          <option value="this-month">This Month</option>
          <option value="last-month">Last Month</option>
          <option value="last-30">Last 30 Days</option>
          <option value="last-90">Last 90 Days</option>
          <option value="custom">Custom…</option>
        </select>
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 text-[8px] pointer-events-none" aria-hidden>▼</span>
      </div>

      {/* Custom date range — only shown when dateFilter is 'custom' */}
      {dateFilter === 'custom' ? (
        <div id="customDateWrap" className="inline-flex items-center gap-1.5 h-8 px-2 rounded-lg bg-surface-2 ring-1 ring-line">
          <input
            type="date"
            id="dateFrom"
            value={customDateFrom}
            onChange={(event) => onCustomDateFromChange(event.target.value)}
            className="bg-transparent border-0 text-[11.5px] text-ink-2 font-mono tabular-nums focus:outline-none focus:text-ink"
          />
          <span className="text-ink-3 text-[11px]">→</span>
          <input
            type="date"
            id="dateTo"
            value={customDateTo}
            onChange={(event) => onCustomDateToChange(event.target.value)}
            className="bg-transparent border-0 text-[11.5px] text-ink-2 font-mono tabular-nums focus:outline-none focus:text-ink"
          />
        </div>
      ) : null}
    </>
  )
}

// ── Column toggle / reorder dropdown (#colBtnFilter) ────────────────────────
export type OrdersFilterToolbarColumnMenuProps = {
  columnMenuOpen: boolean
  onToggleColumnMenu: () => void
  columnMenuPos: { top: number; right: number } | null
  columnMenuRef: React.MutableRefObject<HTMLDivElement | null>
  resolvedColumnPrefs: ResolvedColumnPrefs
  dropdownDragColumnKey: TableColumnKey | null
  dropdownDragOverColumnKey: TableColumnKey | null
  onDropdownDragStart: (event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) => void
  onDropdownDragOver: (event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) => void
  onDropdownDrop: (event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) => void
  onDropdownDragEnd: () => void
  saveColumnPrefsToServer: (nextPrefs: ColumnPrefs) => Promise<void>
  buildSavedColumnPrefs: (
    columns: Array<{ key: TableColumnKey; label: string; width: number }>,
    hiddenColumns: Set<TableColumnKey>,
    widths: Record<TableColumnKey, number>,
  ) => ColumnPrefs
}

export function OrdersFilterToolbarColumnMenu({
  columnMenuOpen,
  onToggleColumnMenu,
  columnMenuPos,
  columnMenuRef,
  resolvedColumnPrefs,
  dropdownDragColumnKey,
  dropdownDragOverColumnKey,
  onDropdownDragStart,
  onDropdownDragOver,
  onDropdownDrop,
  onDropdownDragEnd,
  saveColumnPrefsToServer,
  buildSavedColumnPrefs,
}: OrdersFilterToolbarColumnMenuProps) {
  return (
    <div className="col-toggle-wrap">
      <button className="btn btn-outline btn-sm" type="button" id="colBtnFilter" style={{ display: 'none' }} onClick={onToggleColumnMenu}>⊞ Columns</button>
      {columnMenuOpen && columnMenuPos ? (
        <div ref={columnMenuRef} className="react-column-menu" style={{ position: 'fixed', top: columnMenuPos.top, right: columnMenuPos.right, background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: 'var(--shadow-lg)', padding: '8px 0', zIndex: 1000, minWidth: 220 }}>
          <div style={{ padding: '0 12px 6px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Toggle &amp; Reorder Columns</div>
          {resolvedColumnPrefs.orderedColumns.filter((column) => column.key !== 'select' && column.key !== 'orderNum').map((column) => {
            const checked = !resolvedColumnPrefs.hiddenColumns.has(column.key)
            return (
              <div
                key={column.key}
                className={[
                  'col-dd-item',
                  dropdownDragColumnKey === column.key ? 'dragging' : '',
                  dropdownDragOverColumnKey === column.key ? 'drag-over' : '',
                ].filter(Boolean).join(' ')}
                draggable
                onDragStart={(event) => onDropdownDragStart(event, column.key)}
                onDragOver={(event) => onDropdownDragOver(event, column.key)}
                onDrop={(event) => onDropdownDrop(event, column.key)}
                onDragEnd={onDropdownDragEnd}
              >
                <span className="col-dd-handle" aria-hidden="true">::</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const nextHidden = new Set(resolvedColumnPrefs.hiddenColumns)
                      if (event.target.checked) nextHidden.delete(column.key)
                      else nextHidden.add(column.key)
                      void saveColumnPrefsToServer(buildSavedColumnPrefs(resolvedColumnPrefs.orderedColumns, nextHidden, resolvedColumnPrefs.widths as any))
                    }}
                  />
                  {column.label}
                </label>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// ── Batch controls: select-all, recalculate, sku-sort, picklist ─────────────
export type OrdersFilterToolbarBatchControlsProps = {
  isReadOnly: boolean
  visibleOrderIds: number[]
  allVisibleSelected: boolean
  someVisibleSelected: boolean
  selectAllCheckboxRef: React.MutableRefObject<HTMLInputElement | null>
  onToggleVisibleSelection: (checked?: boolean) => void
  visibleSelectedCount: number
  total: number
  selectingAllMatching: boolean
  onSelectAllMatchingOrders: () => void
  allMatchingSelection: AllMatchingSelectionLike
  selectionScopeKey: string
  currentStatus: string
  onStartBatchRecalculateBestRates: (scope: BatchRecalculateScope) => void
  batchRecalculateBusy: boolean
  selectedOrderIds: number[]
  onRecalculateAll: () => void
  onFullLiveRecalculateAll: () => void
  recalcAllProgress: RecalculateAllProgressState | null
  recalcAllBusy: boolean
  batchRecalculateProgress: BatchRecalculateProgressLike
  onToggleSkuSort: () => void
  skuSortActive: boolean
  onPrintPicklist: () => void
}

export function OrdersFilterToolbarBatchControls({
  isReadOnly,
  visibleOrderIds,
  allVisibleSelected,
  someVisibleSelected,
  selectAllCheckboxRef,
  onToggleVisibleSelection,
  visibleSelectedCount,
  total,
  selectingAllMatching,
  onSelectAllMatchingOrders,
  allMatchingSelection,
  selectionScopeKey,
  currentStatus,
  onStartBatchRecalculateBestRates,
  batchRecalculateBusy,
  selectedOrderIds,
  onRecalculateAll,
  onFullLiveRecalculateAll,
  recalcAllProgress,
  recalcAllBusy,
  batchRecalculateProgress,
  onToggleSkuSort,
  skuSortActive,
  onPrintPicklist,
}: OrdersFilterToolbarBatchControlsProps) {
  const recalcAllProgressView = recalcAllProgress
    ? buildRecalculateAllProgressView(recalcAllProgress)
    : null
  const recalcAllDetail = recalcAllProgressView
    ? [
        `Updated ${recalcAllProgressView.updated.toLocaleString()}`,
        recalcAllProgressView.failed > 0 ? `Failed ${recalcAllProgressView.failed.toLocaleString()}` : '',
        recalcAllProgressView.skipped > 0 ? `Skipped ${recalcAllProgressView.skipped.toLocaleString()}` : '',
      ].filter(Boolean).join(' · ')
    : ''

  return (
    <>
      {/* Lockdown — Select All hidden in Shipped/Cancelled views.
          Without this, the user could check Select All which would
          ignore the row-level checkbox lockdown (rows hide their
          checkboxes, but Select All operates on visibleOrderIds
          regardless of cell visibility). */}
      {isReadOnly ? null : (
        <div className="inline-flex items-center gap-1.5" aria-label="Order selection scope">
          <label
            id="btnSelectAll"
            title={
              visibleOrderIds.length === 0
                ? 'No visible orders to select'
                : allVisibleSelected
                  ? 'Clear current page selected orders'
                  : 'Select current page orders'
            }
            className={`
            inline-flex items-center gap-1.5
            h-8 px-2.5 rounded-lg ring-1 select-none
            text-[12px] font-medium
            transition-all duration-150
            ${visibleOrderIds.length > 0 ? 'cursor-pointer' : 'cursor-default opacity-50'}
            ${allVisibleSelected || someVisibleSelected
                ? 'bg-brand-bg ring-brand text-brand'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
          `}
          >
            <input
              ref={selectAllCheckboxRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={visibleOrderIds.length === 0}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                event.stopPropagation()
                onToggleVisibleSelection(event.target.checked)
              }}
              style={{ accentColor: 'var(--ss-blue)' }}
              className="w-3.5 h-3.5 cursor-pointer"
              aria-label="Select current page orders"
            />
            <span className="font-mono tabular-nums">
              {visibleSelectedCount > 0
                ? `${visibleSelectedCount}/${visibleOrderIds.length}`
                : 'This Page'}
            </span>
          </label>
          <button
            id="btnSelectAllMatching"
            type="button"
            title={total > 0 ? `Select all ${total.toLocaleString()} matching orders across pages` : 'No matching orders to select'}
            disabled={total === 0 || selectingAllMatching}
            onClick={() => void onSelectAllMatchingOrders()}
            className={`
            inline-flex items-center gap-1.5
            h-8 px-2.5 rounded-lg ring-1
            text-[12px] font-medium
            transition-all duration-150
            ${allMatchingSelection?.active && allMatchingSelection.scopeKey === selectionScopeKey
                ? 'bg-brand-bg ring-brand text-brand'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
            ${total === 0 || selectingAllMatching ? 'opacity-60 cursor-not-allowed' : ''}
          `}
            aria-label={`Select all ${total.toLocaleString()} matching orders across pages`}
          >
            {selectingAllMatching ? <Loader2 size={12.5} className="animate-spin" aria-hidden /> : <CheckSquare size={12.5} strokeWidth={2.25} aria-hidden />}
            <span className="font-mono tabular-nums">All Matches</span>
          </button>
        </div>
      )}

      {currentStatus === 'awaiting_shipment' ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5" aria-label="Strict live best-rate recalculation">
          <button
            type="button"
            onClick={() => void onStartBatchRecalculateBestRates('selected')}
            disabled={batchRecalculateBusy || selectedOrderIds.length === 0}
            title="Recalculate strict live best rates for selected awaiting orders"
            className={`
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1
              text-[12px] font-medium
              transition-all duration-150
              ${batchRecalculateBusy || selectedOrderIds.length === 0
                ? 'opacity-60 cursor-not-allowed bg-surface ring-line text-ink-3'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
            `}
          >
            {batchRecalculateBusy ? <Loader2 size={12.5} className="animate-spin" aria-hidden /> : <RefreshCcw size={12.5} strokeWidth={2.25} />}
            Recalculate Selected
          </button>
          <button
            type="button"
            onClick={() => void onRecalculateAll()}
            disabled={recalcAllBusy || total === 0}
            title="Fast cache-first refresh: reuse exact current rate tuples, live-rate only misses or stale rows"
            className={`
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1
              text-[12px] font-medium
              transition-all duration-150
              ${recalcAllBusy || total === 0
                ? 'opacity-60 cursor-not-allowed bg-surface ring-line text-ink-3'
                : 'bg-brand-bg ring-brand/40 text-brand hover:ring-brand'}
            `}
          >
            {recalcAllBusy ? <Loader2 size={12.5} className="animate-spin" aria-hidden /> : <Zap size={12.5} strokeWidth={2.25} />}
            Recalculate All
          </button>
          <button
            type="button"
            onClick={() => void onFullLiveRecalculateAll()}
            disabled={recalcAllBusy || total === 0}
            title="Full Live Recalculate audit: slow force-live check across all eligible awaiting rows"
            className={`
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1
              text-[12px] font-medium
              transition-all duration-150
              ${recalcAllBusy || total === 0
                ? 'opacity-60 cursor-not-allowed bg-surface ring-line text-ink-3'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
            `}
          >
            <RefreshCcw size={12.5} strokeWidth={2.25} />
            Full Live Audit
          </button>
          {recalcAllProgressView ? (
            <OrdersRecalculationProgress
              kind="all"
              label={recalcAllProgressView.label}
              percent={recalcAllProgressView.percent}
              completed={recalcAllProgressView.completed}
              remaining={recalcAllProgressView.remaining}
              total={recalcAllProgressView.total}
              detail={recalcAllDetail}
              statusMessage={recalcAllProgressView.statusMessage}
              tone={recalcAllProgressView.tone}
            />
          ) : null}
          {batchRecalculateProgress.total > 0 ? (
            <OrdersRecalculationProgress
              kind="selected"
              label="Recalculating selected"
              percent={batchRecalculateProgress.percent}
              completed={batchRecalculateProgress.completed}
              remaining={Math.max(batchRecalculateProgress.total - batchRecalculateProgress.completed, 0)}
              total={batchRecalculateProgress.total}
              detail={`Updated ${batchRecalculateProgress.updated} · Retry ${batchRecalculateProgress.blocked + batchRecalculateProgress.timedOut}`}
              statusMessage="Strict live only: no cached or stale fallback rates are accepted"
            />
          ) : null}
        </div>
      ) : null}

      <button
        id="btnSkuSort"
        type="button"
        onClick={onToggleSkuSort}
        aria-pressed={skuSortActive}
        title="Sort orders by SKU groups"
        className={`
          inline-flex items-center gap-1.5
          h-8 px-2.5 rounded-lg ring-1
          text-[12px] font-medium
          transition-all duration-150
          ${skuSortActive
            ? 'bg-brand-bg ring-brand text-brand'
            : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
        `}
      >
        <ListOrdered size={12.5} strokeWidth={2.25} />
        SKU Sort
        {skuSortActive ? <span className="text-brand">✓</span> : null}
      </button>

      {/* Picklist — relocated next to SKU Sort per UX request
          (was pinned far-right with ml-auto, now flows inline). */}
      {currentStatus === 'awaiting_shipment' ? (
        <button
          id="picklistBtn"
          type="button"
          onClick={() => void onPrintPicklist()}
          title="Print picklist for visible orders"
          className="
            inline-flex items-center gap-1.5
            h-8 px-3 rounded-lg
            ring-1 ring-line bg-surface
            text-[12px] font-semibold text-ink-2
            hover:text-ink hover:ring-line-2 hover:bg-surface-2
            active:scale-95
            transition-all duration-150
          "
        >
          <PrinterIcon size={12.5} strokeWidth={2.25} />
          Picklist
        </button>
      ) : null}
    </>
  )
}

// ── Export: density toggle + queue-progress portal + Export CSV ─────────────
export type OrdersFilterToolbarExportProps = {
  tableDensity: 'narrow' | 'cozy' | 'wide'
  onTableDensityChange: (density: 'narrow' | 'cozy' | 'wide') => void
  currentStatus: string
  queueToolbarProgress: QueueToolbarProgress | null
  csvExporting: boolean
  onExportCsv: () => void
}

export function OrdersFilterToolbarExport({
  tableDensity,
  onTableDensityChange,
  currentStatus,
  queueToolbarProgress,
  csvExporting,
  onExportCsv,
}: OrdersFilterToolbarExportProps) {
  const useHeaderSlot = useQueueProgressHeaderSlot()

  return (
    <>
      {/* Density toggle — segmented control */}
      <div
        role="group"
        aria-label="Row density"
        title="Row density"
        className="inline-flex h-8 overflow-hidden rounded-lg ring-1 ring-line bg-surface"
      >
        {([
          { key: 'narrow', label: '≡', tip: 'Narrow rows' },
          { key: 'cozy', label: '☰', tip: 'Cozy rows (default)' },
          { key: 'wide', label: '⫿', tip: 'Wide rows' },
        ] as const).map((opt, idx, arr) => {
          const isActive = tableDensity === opt.key
          const isLast = idx === arr.length - 1
          return (
            <button
              key={opt.key}
              type="button"
              title={opt.tip}
              aria-pressed={isActive}
              onClick={() => onTableDensityChange(opt.key)}
              className={`px-2.5 text-[13px] font-bold cursor-pointer transition-colors ${isLast ? '' : 'border-r border-line'} ${isActive ? 'bg-brand text-white' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      {(() => {
        if (currentStatus !== 'awaiting_shipment' || !queueToolbarProgress) return null
        const statusLabel = `${queueToolbarProgress.label}. ${queueToolbarProgress.pct}% complete. ${queueToolbarProgress.detail}`
        const widget = (
          <div
            id="queue-progress-indicator"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={statusLabel}
            title={statusLabel}
            className={`relative ${useHeaderSlot ? 'z-[1300]' : 'z-10'} ml-2 w-[clamp(280px,21.5vw,340px)] max-w-[calc(100vw-2rem)] shrink rounded-md border border-line-2 bg-surface px-2.5 py-1.5 shadow-sm`}
          >
            <div className="flex min-w-0 items-start gap-3 text-[11px] leading-tight text-ink-2">
              <span className="min-w-0 whitespace-normal break-words font-extrabold">
                {queueToolbarProgress.label}
              </span>
              <span className="ml-auto shrink-0 whitespace-nowrap font-mono font-bold tabular-nums" style={{ color: queueToolbarProgress.tone }}>
                {queueToolbarProgress.pct}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`${queueToolbarProgress.label}: ${queueToolbarProgress.pct}% complete`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={queueToolbarProgress.pct}
              className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3"
            >
              <div
                className="h-full rounded-full transition-[width] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  width: `${Math.min(100, Math.max(0, queueToolbarProgress.pct))}%`,
                  background: queueToolbarProgress.tone,
                }}
              />
            </div>
            <span
              data-queue-progress-detail
              className="mt-1 block w-full whitespace-normal break-words text-[11px] font-semibold leading-tight"
              style={{ color: queueToolbarProgress.tone }}
            >
              {queueToolbarProgress.detail}
            </span>
          </div>
        )
        // DJ request (2026-06-11): show the progress immediately LEFT of the header Queue
        // button. Home.tsx renders the #queue-progress-slot anchor there; portal into it
        // when present (desktop), else keep the original toolbar position as the fallback.
        const slot = typeof document !== 'undefined' ? document.getElementById('queue-progress-slot') : null
        return slot && useHeaderSlot ? createPortal(widget, slot) : widget
      })()}
      {/* Export CSV — stays on the toolbar row, pushed to the far
          right end via ml-auto, per UX request. */}
      <button
        id="exportBtn"
        type="button"
        title={csvExporting ? 'Preparing CSV export...' : 'Export visible orders as CSV'}
        disabled={csvExporting}
        aria-busy={csvExporting}
        className={`
          ml-auto
          inline-flex items-center gap-1.5
          h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface
          text-[12px] font-medium text-ink-2
          ${csvExporting
            ? 'cursor-wait opacity-75'
            : 'hover:text-ink hover:ring-line-2 active:scale-95'}
          transition-all duration-150
        `}
        onClick={onExportCsv}
      >
        {csvExporting ? (
          <Loader2 size={12.5} strokeWidth={2.25} className="animate-spin" />
        ) : (
          <Download size={12.5} strokeWidth={2.25} />
        )}
        <span className="hidden sm:inline">{csvExporting ? 'Exporting...' : 'Export CSV'}</span>
      </button>
    </>
  )
}

// ── Composed parent toolbar ─────────────────────────────────────────────────
export type OrdersFilterToolbarProps = {
  // Search slot (passed through to the already-extracted OrdersSearchBar)
  searchQuery: string
  onSearchQueryChange?: (value: string) => void
  dateRange: { start?: string; end?: string }
  // New Order
  onOpenNewOrder: () => void
  // Sub-toolbar prop groups
  dateControls: OrdersFilterToolbarDateControlsProps
  columnMenu: OrdersFilterToolbarColumnMenuProps
  batchControls: OrdersFilterToolbarBatchControlsProps
  exportControls: OrdersFilterToolbarExportProps
}

export function OrdersFilterToolbar({
  searchQuery,
  onSearchQueryChange,
  dateRange,
  onOpenNewOrder,
  dateControls,
  columnMenu,
  batchControls,
  exportControls,
}: OrdersFilterToolbarProps) {
  return (
    <div
      id="filterbar"
      className="
        flex items-center gap-2 flex-wrap
        px-4 sm:px-5 py-2.5
        bg-surface border-b border-line
        text-ink
      "
    >
      {/* PS-166 (Wave 2b): search input + clear + PS-210 global-search
          pill render from OrdersSearchBar with byte-identical markup;
          search state stays in Home, threaded through the same props. */}
      <OrdersSearchBar
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        dateRange={dateRange}
      />

      {/* SKU filter dropdown removed per UX request — SKU filtering is
          still reachable via global search (which sets skuFilter when a
          SKU token is matched), so the underlying filter state is kept
          and simply defaults to '' (= all SKUs) with no visible control. */}

      {/* + New Order — primary action, relocated right after Search
          per UX request. Brand-blue gradient fill telegraphs primary. */}
      <button
        id="newOrderBtn"
        type="button"
        title="Create a new manual order"
        onClick={onOpenNewOrder}
        className="
          inline-flex items-center gap-1.5
          h-8 px-3 rounded-lg
          text-[12px] font-bold text-white
          bg-gradient-to-br from-brand to-indigo-600
          shadow-md hover:shadow-lg active:scale-95
          ring-1 ring-brand/30
          transition-all duration-150
        "
      >
        <Plus size={12.5} strokeWidth={2.75} />
        <span className="hidden sm:inline">New Order</span>
      </button>

      <OrdersFilterToolbarDateControls {...dateControls} />

      <OrdersFilterToolbarColumnMenu {...columnMenu} />

      <OrdersFilterToolbarBatchControls {...batchControls} />

      <OrdersFilterToolbarExport {...exportControls} />
    </div>
  )
}
