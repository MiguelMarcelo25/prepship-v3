// ──────────────────────────────────────────────────────────────────
// Table — reusable data-table primitive for the whole project.
//
// Goals
//   - One component every page can use: Clients, future Manifests,
//     future audit logs, anywhere with a list of rows.
//   - Sortable columns (click header → asc → desc → none)
//   - Resizable column widths (drag right edge, persisted)
//   - localStorage persistence (one storageKey gates BOTH sort
//     state and column widths)
//   - Reliable column-width math (table-fixed + colgroup + per-cell
//     overflow-hidden — the full truncation recipe we landed on for
//     the Dashboard table)
//   - Sticky <thead>, configurable density, optional row click
//   - Loading + empty states first-class
//
// API surface (intentionally small — one entry point, opinionated
// defaults, escape hatches for the cases where you need them):
//
//   <Table
//     data={clients}
//     columns={[
//       { key: 'name',  label: 'Name',  width: 200, sortable: true },
//       { key: 'count', label: 'Count', width: 90, align: 'right',
//         sortable: true,
//         render: (row) => row.count.toLocaleString() },
//     ]}
//     rowKey={(row) => row.id}
//     storageKey="clients-table"
//     defaultSort={{ key: 'name', direction: 'asc' }}
//     onRowClick={(row) => openDetail(row)}
//     loading={isLoading}
//     emptyMessage="No clients yet"
//   />
//
// Future tables in this project should consume this component
// rather than rolling their own <table> — operators get consistent
// resize/sort/persist behavior everywhere, and bug fixes land once.
// ──────────────────────────────────────────────────────────────────

import {
  useCallback,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AnalysisPagination } from '../Views/AnalysisPagination'
import { useTableState } from './useTableState'
import {
  getVirtualTablePadding,
  shouldVirtualizeTable,
  TABLE_VIRTUALIZATION_OVERSCAN,
} from './table-virtualization'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Check,
  Eye,
  EyeOff,
  RotateCcw,
} from 'lucide-react'

export type SortDirection = 'asc' | 'desc'
export type ColumnAlign = 'left' | 'right' | 'center'

export interface TableColumn<Row> {
  /** Unique column id. Also used as the default sortValue path
   *  (`row[key]`) when `sortValue` isn't provided. */
  key: string
  /** Header text. */
  label: string
  /** Default width in px. Required because table-fixed needs a
   *  width to honor — without this the column auto-distributes. */
  width: number
  /** Resize floor in px. Defaults to 60. */
  minWidth?: number
  /** Resize ceiling in px. Defaults to 800. Prevents a runaway
   *  resize from busting the layout. */
  maxWidth?: number
  /** Header + cell text-align. Defaults to 'left'. */
  align?: ColumnAlign
  /** True = clickable header that toggles sort. False = no sort. */
  sortable?: boolean
  /** Comparable value pulled from a row for sorting this column.
   *  Strings sort case-insensitively. Defaults to `row[key]`. */
  sortValue?: (row: Row) => string | number | boolean | Date | null | undefined
  /** Cell content. Defaults to `String(row[key] ?? '')`. */
  render?: (row: Row) => ReactNode
  /** When true the column is pinned to its position and isn't
   *  resizable or reorderable (use for row identity / action
   *  columns where stability matters more than tweakability). */
  pinned?: boolean
  /** When true (default) the column appears in the "Columns ▾"
   *  picker and can be hidden by the operator. Set to false for
   *  required columns (row identity, action column) that must
   *  always be visible. */
  hideable?: boolean
  /** When true the column starts hidden — the operator can opt
   *  in via the Columns picker. Useful for low-priority columns
   *  that you want available but not in everyone's face. */
  defaultHidden?: boolean
  /** Optional CSS class added to every cell in this column. */
  className?: string
}

export interface SortState {
  key: string
  direction: SortDirection
}

export interface TableProps<Row> {
  data: Row[]
  columns: TableColumn<Row>[]
  rowKey: (row: Row) => string | number
  /** Persistence key. When set, sort state + column widths persist
   *  to localStorage under `${storageKey}:sort` and `${storageKey}:widths`.
   *  Omit for ephemeral tables. */
  storageKey?: string
  /** Initial sort. Falls through to no-sort when omitted. */
  defaultSort?: SortState | null
  /** Row click handler. Cursor + hover treatment adjust when set. */
  onRowClick?: (row: Row) => void
  /** Visual density. Defaults to 'normal'. */
  density?: 'compact' | 'normal' | 'comfortable'
  loading?: boolean
  emptyMessage?: ReactNode
  /** Optional toolbar slot rendered above the table (e.g. search,
   *  filter chips). Renders inside the same shell so the toolbar
   *  shares the rounded border + shadow. */
  toolbar?: ReactNode
  /** Show the built-in Columns visibility/order/reset control.
   *  Defaults to true. Set false for fixed tables where all columns
   *  should stay visible and no customization button should appear. */
  showColumnControls?: boolean
  /** When set, the Columns ▾ button + popover renders via React
   *  portal into this DOM element instead of inline in the Table's
   *  toolbar. Useful for pages whose page-level toolbar wants to host
   *  the Columns control next to other actions (e.g. Inventory wants
   *  it next to "Import SKUs from Orders"). Pair with a callback ref
   *  on the consumer side:
   *
   *    const [anchor, setAnchor] = useState<HTMLElement | null>(null)
   *    <span ref={setAnchor} />
   *    <Table columnsAnchorEl={anchor} ... />
   *
   *  All state (visibility, order, persistence, click-outside) stays
   *  inside the Table — only the DOM mount location changes. The
   *  popover stays anchored to the portal'd button via the existing
   *  `absolute right-0 top-full` positioning. When unset (default),
   *  the Columns button renders inline in the toolbar as today. */
  columnsAnchorEl?: HTMLElement | null
  /** Optional className applied to the outer shell. Use sparingly —
   *  the default styling is the point. */
  className?: string
  /** When true, Table internally slices `data` and renders a
   *  pagination bar below tbody. Page + pageSize state persist to
   *  `${storageKey}:page` and `${storageKey}:pageSize` if storageKey
   *  is set. Auto-resets to page 1 when data length shrinks or sort
   *  changes (so operators don't land on a now-invalid page). */
  paginated?: boolean
  /** Window large body row sets with TanStack Virtual. Activates only
   *  above the shared threshold; short tables keep the legacy DOM.
   *  Expansion/footer modes stay unvirtualized because they add
   *  independently-sized sibling rows. */
  virtualized?: boolean
  /** Page-size options shown in the pagination bar dropdown.
   *  Defaults to [25, 50, 100]. */
  pageSizeOptions?: number[]
  /** Initial page size. Must be one of pageSizeOptions. Defaults to
   *  50 (or the first option if 50 isn't in the list). */
  defaultPageSize?: number
  /** When true, the pagination bar sticks to the bottom of the page
   *  scroll (position: sticky; bottom: 0) so it stays visible while the
   *  operator scrolls a long table. Opt-in — most tables are short
   *  enough that a normal in-flow bar is fine. */
  stickyPagination?: boolean
  serverPagination?: {
    page: number
    pageSize: number
    totalItems: number
    onPageChange: (page: number) => void
    onPageSizeChange: (pageSize: number) => void
  }
  /** Per-row class name for visual customization — focused rows,
   *  status-tinted rows, etc. Receives the row + its index in the
   *  *paginated/sorted* view (not the original data index). */
  rowClassName?: (row: Row, index: number) => string | undefined
  /** Optional: render an additional row immediately AFTER a given
   *  row (spanning all visible columns). Return `null` to skip.
   *  Used for expandable detail rows — e.g. the Packages page
   *  ledger drawer that unfolds beneath a row when clicked. The
   *  caller owns expansion state; Table just renders whatever is
   *  returned. */
  renderRowExpansion?: (row: Row, index: number) => ReactNode | null
  /** Optional: ref callback fired for each rendered body `<tr>`.
   *  Lets the parent grab handles for scroll-to-row, focus
   *  management, etc. */
  rowRef?: (row: Row, el: HTMLTableRowElement | null) => void
  /** Optional predicate: rows where this returns true are forced
   *  to render AFTER all rows where it returns false, regardless
   *  of the operator's sort choice. Within each group, the
   *  operator's sort still applies. Used by Inventory to pin
   *  deactivated SKUs to the bottom of the list so operators see
   *  active rows first while still having full visibility. */
  pinRowToBottom?: (row: Row) => boolean
  /** Optional: render a totals/summary row pinned to the bottom of
   *  the tbody. Receives the CURRENT visible (post-hide) columns in
   *  their CURRENT order so the caller can align cells with the
   *  rendered grid. Caller returns React cells (typically `<td>`s);
   *  Table wraps them in a `<tr>` with a top border + surface-2
   *  background so the totals visually stand apart. Common shape:
   *
   *    footerRow={(cols) => cols.map((c) => (
   *      <td key={c.key} className="px-3 py-2 text-right font-extrabold">
   *        {c.key === 'total' ? `$${totals.grand}` : ''}
   *      </td>
   *    ))}
   *
   *  Returning null/undefined renders no footer. */
  footerRow?: (visibleColumns: TableColumn<Row>[]) => ReactNode
  /** When true (default), the inner table wrapper uses
   *  `overflow-x: clip` instead of `overflow-x: auto`. `clip` does NOT
   *  establish a scroll container per spec, so `position: sticky` on
   *  the `<thead>` can resolve up to the page's view-content scroll —
   *  the operator sees the column headers pinned at the top while
   *  scrolling rows. The trade-off: very wide tables (e.g. Inventory
   *  with 15+ columns) get visually clipped on the right edge with no
   *  horizontal scrollbar. Set to `false` when wide-table horizontal
   *  scroll matters more than the sticky thead (then operators must
   *  scroll the table sideways instead of seeing pinned headers). */
  stickyHeader?: boolean
}

// PS-157: all table STATE + localStorage persistence (sort, pagination,
// column visibility/order/widths) now lives in `useTableState`. The
// localStorage read/write helpers, comparators, and DEFAULT_PAGE_SIZE_OPTIONS
// moved there with it. Table.tsx is the pure renderer below.

export function Table<Row>({
  data,
  columns,
  rowKey,
  storageKey,
  defaultSort,
  onRowClick,
  density = 'normal',
  loading,
  emptyMessage = 'No data',
  toolbar,
  showColumnControls = true,
  className,
  paginated,
  virtualized = false,
  pageSizeOptions,
  defaultPageSize,
  stickyPagination = false,
  serverPagination,
  rowClassName,
  renderRowExpansion,
  rowRef,
  pinRowToBottom,
  footerRow,
  stickyHeader = true,
  columnsAnchorEl,
}: TableProps<Row>) {
  // PS-157: all table STATE + persistence lives in useTableState now.
  // Destructure with the SAME identifiers the rendering below already
  // references, so the JSX is unchanged (pure behavior-preserving move).
  const {
    sort,
    toggleSort,
    orderedColumns,
    draggingKey,
    dragOverKey,
    setDragOverKey,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    fittedColumnWidths,
    tableMinWidth,
    startResize,
    autoFitColumn,
    tableScrollRef,
    theadRef,
    tbodyRef,
    hiddenKeys,
    toggleHidden,
    resetWidths,
    resetOrder,
    resetAll,
    columnsPickerOpen,
    setColumnsPickerOpen,
    columnsPickerRef,
    pickerColumns,
    visibleCount,
    totalToggleable,
    sortedRows,
    pagedRows,
    effectivePageSizeOptions,
    paginationTotalItems,
    paginationPage,
    paginationPageSize,
    handlePaginationPageChange,
    handlePaginationPageSizeChange,
  } = useTableState<Row>({
    data,
    columns,
    storageKey,
    defaultSort,
    showColumnControls,
    paginated,
    pageSizeOptions,
    defaultPageSize,
    serverPagination,
    pinRowToBottom,
    loading,
  })

  // Density tokens — picked here once, applied to every cell so
  // the row rhythm stays consistent.
  const padding = density === 'compact' ? 'px-3 py-1.5' : density === 'comfortable' ? 'px-4 py-3.5' : 'px-3 py-2.5'
  const fontSize = density === 'compact' ? 'text-[12px]' : 'text-[13px]'
  const headerPadding = density === 'compact' ? 'px-3 py-2' : 'px-3 py-2.5'

  const virtualRowsEnabled =
    virtualized &&
    shouldVirtualizeTable(pagedRows.length) &&
    renderRowExpansion == null &&
    footerRow == null
  const getVirtualRowKey = useCallback(
    (index: number) => {
      const row = pagedRows[index]
      return row == null ? index : rowKey(row)
    },
    [pagedRows, rowKey],
  )
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtualRowsEnabled ? pagedRows.length : 0,
    enabled: virtualRowsEnabled,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => density === 'compact' ? 44 : density === 'comfortable' ? 64 : 54,
    getItemKey: getVirtualRowKey,
    overscan: TABLE_VIRTUALIZATION_OVERSCAN,
  })
  const virtualRows = virtualRowsEnabled ? rowVirtualizer.getVirtualItems() : []
  const renderedRowIndexes = virtualRowsEnabled
    ? virtualRows.map((item) => item.index)
    : pagedRows.map((_, index) => index)
  const { paddingTop: virtualPaddingTop, paddingBottom: virtualPaddingBottom } =
    getVirtualTablePadding(virtualRows, rowVirtualizer.getTotalSize())

  // PS-157: pickerColumns / visibleCount / totalToggleable now come
  // from useTableState (destructured above) — same values, same names.

  // Columns ▾ button + popover. Extracted into a JSX const so the
  // same subtree can either render INLINE in the table's toolbar or
  // be portal'd to an external anchor element (via `columnsAnchorEl`).
  // All state (open/close, click-outside, hidden keys) is captured
  // by closure, so the JSX behaves identically in both mount modes.
  const columnsControlNode = (
    <div className="relative flex-shrink-0" ref={columnsPickerRef}>
      <button
        type="button"
        onClick={() => setColumnsPickerOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md ring-1 text-[11.5px] font-bold transition ${
          columnsPickerOpen
            ? 'bg-brand/10 ring-brand/40 text-brand'
            : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'
        }`}
        title="Show/hide columns, reset widths and order"
      >
        <Columns3 size={13} strokeWidth={2.25} />
        <span>Columns</span>
        <span className="font-mono tabular-nums text-[10px] opacity-70">{visibleCount}/{totalToggleable || orderedColumns.length}</span>
      </button>
      {columnsPickerOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 z-30 w-[260px] rounded-lg bg-surface ring-1 ring-line shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)] overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-line/70 bg-surface-2/40">
            <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-ink-3">Columns</div>
            <div className="text-[10.5px] text-ink-3 mt-0.5">Toggle visibility · drag to reorder · drag edge to resize</div>
          </div>
          <ul className="max-h-[280px] overflow-y-auto py-1">
            {pickerColumns.map((col) => {
              const isHidden = hiddenKeys.includes(col.key)
              return (
                <li key={col.key}>
                  <button
                    type="button"
                    onClick={() => toggleHidden(col.key)}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2 transition"
                  >
                    <span className={`w-4 h-4 rounded ring-1 inline-flex items-center justify-center transition ${
                      isHidden ? 'ring-line bg-transparent' : 'ring-brand bg-brand text-white'
                    }`}>
                      {!isHidden ? <Check size={10} strokeWidth={3} /> : null}
                    </span>
                    <span className={`flex-1 truncate ${isHidden ? 'text-ink-3' : 'text-ink font-medium'}`}>
                      {col.label || <span className="italic text-ink-3">(no label)</span>}
                    </span>
                    {isHidden ? (
                      <EyeOff size={12} strokeWidth={2} className="flex-shrink-0 text-ink-3" />
                    ) : (
                      <Eye size={12} strokeWidth={2} className="flex-shrink-0 text-ink-3" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="border-t border-line/70 bg-surface-2/40 p-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={resetWidths}
              className="flex-1 inline-flex items-center justify-center gap-1 h-7 px-2 rounded text-[10.5px] font-bold text-ink-2 hover:text-ink hover:bg-surface transition"
              title="Reset all column widths to defaults"
            >
              <RotateCcw size={10} strokeWidth={2.25} />
              Widths
            </button>
            <button
              type="button"
              onClick={resetOrder}
              className="flex-1 inline-flex items-center justify-center gap-1 h-7 px-2 rounded text-[10.5px] font-bold text-ink-2 hover:text-ink hover:bg-surface transition"
              title="Reset column order to defaults"
            >
              <RotateCcw size={10} strokeWidth={2.25} />
              Order
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="flex-1 inline-flex items-center justify-center gap-1 h-7 px-2 rounded text-[10.5px] font-bold text-brand hover:bg-brand/10 transition"
              title="Reset widths, order, and visibility"
            >
              <RotateCcw size={10} strokeWidth={2.25} />
              All
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )

  // PS-157: pagination view-model (paginationTotalItems / paginationPage /
  // paginationPageSize / handlePaginationPageChange /
  // handlePaginationPageSizeChange) now comes from useTableState above.

  return (
    // 2026-05-12 sticky fix (round 2): outermost wrapper was
    // `overflow-hidden` which (just like overflow-x:auto and
    // overflow-hidden anywhere else) establishes a scroll context
    // and traps position:sticky inside it. The sticky thead below
    // would pin to THIS wrapper instead of resolving up to the
    // page's view-content scroll. Switching to `overflow-clip`
    // preserves the rounded-corner mask (which is the only reason
    // overflow was set here) but does NOT create a scroll context,
    // so sticky correctly bubbles up to the page scroll. Same fix
    // pattern as Table.tsx:705 (inner wrapper) and the various
    // consumer-side wrappers in InventoryView / PackagesDataTable.
    <div className={`rounded-xl bg-surface ring-1 ring-line shadow-[0_1px_3px_rgba(15,23,42,0.04)] overflow-clip flex flex-col ${className ?? ''}`}>
      {/* Toolbar — operator's slot content on the left, the
          column-control widget always anchored to the right so
          operators have a discoverable entry point for width /
          visibility management.
          2026-05-13: the Columns button JSX is now extracted to a
          const so the same React subtree can either render INLINE in
          the toolbar (default) OR portal into `columnsAnchorEl` for
          consumers that want the button living in their page-level
          toolbar (e.g. Inventory wants it next to "Import SKUs from
          Orders"). All state (open/close, hidden keys, click-outside)
          stays in this component — only the mount location changes. */}
      {(toolbar || (showColumnControls && !columnsAnchorEl)) ? (
      <div className="flex-shrink-0 border-b border-line bg-surface-2/40 px-3 py-2 flex items-center gap-3">
        {toolbar ? <div className="flex-1 min-w-0">{toolbar}</div> : <div className="flex-1" />}
        {showColumnControls && !columnsAnchorEl ? columnsControlNode : null}
      </div>
      ) : null}
      {/* When `columnsAnchorEl` is set, render the Columns button +
          popover via React portal into that external DOM node. The
          popover stays positioned absolute relative to the wrapper
          div, so anchoring still works correctly wherever the portal
          target lives. */}
      {showColumnControls && columnsAnchorEl
        ? createPortal(columnsControlNode, columnsAnchorEl)
        : null}

      {/* 2026-05-13 (third round): per-consumer opt-in via
          `stickyHeader` prop. Default `true`:
            - inner wrapper is `overflow-x-clip`
            - `clip` doesn't establish a scroll container (unlike
              `auto`/`hidden`/`scroll`)
            - `position: sticky` on `<thead>` resolves up through
              `clip` to the page's `.view-content` (overflow-y: auto)
              — column headers actually pin at the top as the
              operator scrolls the row list. This is what the
              Packages page operator was asking for.
            - downside: tables wider than the wrapper get visually
              clipped on the right edge with no horizontal scrollbar.
              Most tables in this project fit, so this is the right
              default.
          Opt out (`stickyHeader={false}`) for tables that genuinely
          need horizontal scroll inside the wrapper — Inventory with
          15+ columns is the prototypical case. Operators on those
          tables can still hide columns via the Columns picker, or
          rely on `.view-content`'s own horizontal scroll once the
          table overflows the viewport. */}
      <div
        ref={tableScrollRef}
        className={virtualRowsEnabled
          ? 'ps-data-table-scroll max-h-[70vh] overflow-auto'
          : stickyHeader
            ? 'ps-data-table-scroll overflow-x-clip'
            : 'ps-data-table-scroll overflow-x-auto'}
      >
        <table className="w-full border-collapse table-fixed" style={{ minWidth: tableMinWidth }}>
          <colgroup>
            {orderedColumns.map((col) => (
              <col key={col.key} style={{ width: fittedColumnWidths[col.key] }} />
            ))}
          </colgroup>

          {/* 2026-05-13: sticky + drop shadow moved from <thead> onto
              each <th> so the floating-header visual works
              consistently across all browsers. Sticky-on-thead was
              correct semantically but browsers render shadows on a
              sticky thead unpredictably (Safari clips, Firefox can
              paint under tbody, Chrome at the thead edge). Moving
              both sticky + shadow onto each <th> means every cell
              paints its own shadow strip, so the effect is uniform
              everywhere. Matches the per-th pattern Analysis uses.
              z-index bumped 10 → 25 to match Analysis as well. The
              0 3px 8px rgba shadow is the canonical "floating
              header" cue from modern dashboards (Notion, Linear,
              Vercel) — barely visible to the eye, but gives the
              headers that "following you while you scroll" feel. */}
          <thead ref={theadRef}>
            <tr>
              {orderedColumns.map((col, columnIndex) => {
                const isActive = sort?.key === col.key
                const align = col.align ?? 'left'
                // PS-042: honor col.align so the header label, body cells, and
                // the caller-driven footer/total row all sit on the same side of
                // the column. Previously `align` was captured but ignored here
                // (hardcoded left), while the footer DID honor it — so total-row
                // values drifted out from under their left-aligned body values.
                const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
                const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
                const isDragging = draggingKey === col.key
                const isDragTarget = dragOverKey === col.key && draggingKey !== null && draggingKey !== col.key
                const reorderable = !col.pinned
                const isLastColumn = columnIndex === orderedColumns.length - 1
                return (
                  <th
                    key={col.key}
                    data-col-key={col.key}
                    // Note: draggable lives on the <th> itself so the
                    // whole header is a drop target. The visible grab
                    // affordance is rendered on the LEFT edge so it
                    // doesn't collide visually with the resize handle
                    // on the right edge.
                    draggable={reorderable}
                    onDragStart={reorderable ? handleDragStart(col) : undefined}
                    onDragOver={reorderable ? handleDragOver(col) : undefined}
                    onDragLeave={reorderable ? () => setDragOverKey((k) => (k === col.key ? null : k)) : undefined}
                    onDrop={reorderable ? handleDrop(col) : undefined}
                    onDragEnd={reorderable ? handleDragEnd : undefined}
                    // `sticky` already establishes a positioning
                    // context for absolutely-positioned children
                    // (like the resize handle on the right edge), so
                    // we drop the previous `relative` — Tailwind's
                    // sticky utility implies position-context just
                    // like relative does, and having both triggers a
                    // cssConflict lint warning.
                    // 2026-05-13:
                    //  • Dropped the reorderable-only `pl-5`. It
                    //    was reserving 20px on the left edge for
                    //    a drag-grip affordance, but that grip has
                    //    been HIDDEN since 2026-05-12 (see the
                    //    block below). The whole header is still
                    //    draggable (draggable={reorderable} on the
                    //    <th> itself) — operators just grab the
                    //    label, not a separate handle.
                    className={`group/th bg-surface-2 sticky top-0 z-[25] shadow-[0_1px_0_var(--border),0_3px_8px_rgba(15,23,42,0.08)] border-b-2 border-line ${headerPadding} ${alignCls} text-[10.5px] font-extrabold uppercase tracking-[0.05em] text-ink-3 ${col.sortable ? 'cursor-pointer select-none hover:bg-line/40' : ''} ${isDragging ? 'opacity-40' : ''} ${isDragTarget ? 'bg-brand-bg shadow-[inset_3px_0_0_0_var(--brand)]' : ''} transition-colors`}
                    onClick={() => toggleSort(col)}
                    aria-sort={isActive ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={reorderable ? `${col.label} — click to sort, drag to reorder, drag right edge to resize, double-click edge to auto-fit` : col.label}
                  >
                    {/* HIDDEN PER USER REQUEST 2026-05-12: drag-grip
                        affordance — 6 dots (2×3) on the left edge of
                        the header. Operators preferred the cleaner
                        header without the always-visible grip. The
                        `title` attribute on each <th> still advertises
                        "drag to reorder" so the affordance survives
                        at the tooltip level. Uncomment to restore. */}
                    {/*
                    {reorderable ? (
                      <span
                        aria-hidden
                        className="absolute left-1 top-1/2 -translate-y-1/2 grid grid-cols-2 gap-[2px] text-ink-3/40 group-hover/th:text-brand transition-colors pointer-events-none"
                      >
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                      </span>
                    ) : null}
                    */}

                    <span className={`inline-flex items-center gap-1 ${justify} w-full ${isActive ? 'text-brand' : ''}`}>
                      <span className="truncate">{col.label}</span>
                      {/* Sort indicator: ↑/↓ ONLY when actively sorted.
                          The previous always-visible ↕ placeholder on
                          unsorted-but-sortable columns was removed
                          2026-05-12 per operator preference. Title
                          attribute on the header still hints at
                          sortability for new users. */}
                      {col.sortable && isActive ? (
                        sort!.direction === 'asc'
                          ? <ArrowUp size={10} strokeWidth={2.5} className="flex-shrink-0" />
                          : <ArrowDown size={10} strokeWidth={2.5} className="flex-shrink-0" />
                      ) : null}
                    </span>

                    {/* Resize handle — 14px hot zone on right edge.
                        Always renders a visible 2px brand-tinted line
                        at full opacity so operators see it without
                        hovering. Hover widens to 3px solid brand-blue
                        AND adds a soft brand-bg vertical strip across
                        the full header height so the affordance is
                        impossible to miss. Double-click auto-fits the
                        column to the widest cell content.
                        Skipped for pinned columns.
                        draggable=false on the inner span so grabbing
                        the resize bar doesn't accidentally start a
                        reorder drag. */}
                    {!col.pinned ? (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${col.label}`}
                        onMouseDown={startResize(col)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(col) }}
                        draggable={false}
                        onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
                        className={`absolute top-0 bottom-0 ${isLastColumn ? 'right-0 w-[10px]' : '-right-[7px] w-[14px]'} cursor-col-resize z-20 group/handle flex items-center justify-center hover:bg-brand/10 transition-colors`}
                        style={{ touchAction: 'none' }}
                        title={`Drag to resize ${col.label} · double-click to auto-fit`}
                      >
                        <span className="block w-[2px] h-3/5 rounded bg-line-2 group-hover/handle:bg-brand group-hover/handle:w-[3px] group-hover/handle:h-full transition-all duration-150" />
                      </div>
                    ) : null}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody ref={tbodyRef}>
            {!loading && sortedRows.length > 0 && virtualRowsEnabled && virtualPaddingTop > 0 ? (
              <tr aria-hidden="true" className="virtual-table-spacer">
                <td
                  colSpan={orderedColumns.length}
                  style={{ height: virtualPaddingTop, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
            {loading ? (
              <tr>
                <td colSpan={orderedColumns.length} className="text-center py-12 text-ink-3">
                  <span className="inline-flex items-center gap-2 text-[12px]">
                    <span className="w-3 h-3 rounded-full border-2 border-line border-t-brand animate-spin" />
                    Loading…
                  </span>
                </td>
              </tr>
            ) : sortedRows.length === 0 ? (
              <tr>
                <td colSpan={orderedColumns.length} className="text-center py-12 text-ink-3 italic text-[13px]">
                  {emptyMessage}
                </td>
              </tr>
            ) : renderedRowIndexes.flatMap((rowIndex) => {
              const row = pagedRows[rowIndex]
              if (!row) return []
              const key = rowKey(row)
              const customRowClass = rowClassName?.(row, rowIndex) ?? ''
              // Expansion content is computed BEFORE rendering so we
              // can decide whether to emit the trailing <tr>. Falsy
              // (null/undefined) = no expansion for this row.
              const expansion = renderRowExpansion ? renderRowExpansion(row, rowIndex) : null
              const out: ReactNode[] = [
                <tr
                  key={`row-${key}`}
                  ref={virtualRowsEnabled
                    ? (el) => {
                        rowVirtualizer.measureElement(el)
                        rowRef?.(row, el)
                      }
                    : rowRef
                      ? (el) => rowRef(row, el)
                      : undefined}
                  data-index={virtualRowsEnabled ? rowIndex : undefined}
                  className={`group border-b border-line/70 last:border-b-0 transition-colors ${onRowClick ? 'cursor-pointer hover:bg-brand-bg/40' : 'hover:bg-surface-2/60'} ${customRowClass}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {orderedColumns.map((col) => {
                    const align = col.align ?? 'left'
                    // PS-042: honor col.align (see header note) so body values
                    // align with the footer/total row and the header within
                    // each column.
                    const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
                    const content = col.render
                      ? col.render(row)
                      : ((row as Record<string, unknown>)[col.key] as ReactNode) ?? ''
                    return (
                      <td
                        key={col.key}
                        data-col-key={col.key}
                        data-col-label={col.label}
                        data-col-align={align}
                        className={`${padding} ${fontSize} ${alignCls} overflow-hidden align-middle text-ink ${col.className ?? ''}`}
                        style={{ width: fittedColumnWidths[col.key], maxWidth: fittedColumnWidths[col.key] }}
                      >
                        {content}
                      </td>
                    )
                  })}
                </tr>,
              ]
              if (expansion) {
                out.push(
                  <tr key={`expand-${key}`} className="border-b border-line/70">
                    <td colSpan={orderedColumns.length} className="bg-surface-2/40 p-0">
                      {expansion}
                    </td>
                  </tr>,
                )
              }
              return out
            })}
            {!loading && sortedRows.length > 0 && virtualRowsEnabled && virtualPaddingBottom > 0 ? (
              <tr aria-hidden="true" className="virtual-table-spacer">
                <td
                  colSpan={orderedColumns.length}
                  style={{ height: virtualPaddingBottom, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
            {/* Footer/totals row — caller-driven via footerRow.
                Stays attached to the bottom of tbody so it sits with
                its parent data even as the table scrolls or paginates
                (callers compute totals from the FULL dataset, not just
                the paged slice, so the displayed sum is consistent
                regardless of which page is showing). */}
            {!loading && footerRow && sortedRows.length > 0 ? (
              <tr className="border-t-2 border-line bg-surface-2/70 font-extrabold">
                {footerRow(orderedColumns)}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {/* Pagination bar — opt-in via `paginated`. Reuses the
          AnalysisPagination component so all paginated tables share
          one control vocabulary (Analysis grid, Packages, Inventory).
          Only renders when there's at least one row, so empty-state
          messages stay clean. */}
      {paginated && !loading && paginationTotalItems > 0 ? (
        <div
          className={
            stickyPagination
              // Sticky to the bottom of the page scroll. Opaque bg + top shadow
              // so the row list scrolls cleanly UNDER the bar. z-20 keeps it
              // above body cells but below the sticky <thead> (z-10 on th, but
              // the header sits at the top so they never overlap).
              ? 'data-table-pagination-bar sticky bottom-0 z-20 border-t border-line bg-surface px-3 py-2 shadow-[0_-1px_3px_rgba(15,23,42,0.06)]'
              : 'data-table-pagination-bar border-t border-line bg-surface-2/40 px-3 py-2'
          }
        >
          {/* totalItems counts only UNPINNED rows so the pagination
              math ("Showing 1-50 of 200 rows") reflects what's
              actually being paginated. Pinned rows live as a footer
              on every page (Inventory's deactivated SKUs); their
              count is surfaced separately by the consumer (the
              toolbar badge in InventoryView). */}
          <TablePaginationBar
            page={paginationPage}
            pageSize={paginationPageSize}
            pageSizeOptions={effectivePageSizeOptions}
            totalItems={paginationTotalItems}
            onPageChange={handlePaginationPageChange}
            onPageSizeChange={handlePaginationPageSizeChange}
          />
        </div>
      ) : null}
    </div>
  )
}

// Thin wrapper around AnalysisPagination so we only import it (and
// pull in its bundle weight) when a consumer actually opts into
// `paginated`. Same API surface, just narrower types.
function TablePaginationBar(props: {
  page: number
  pageSize: number
  pageSizeOptions: number[]
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  return <AnalysisPagination {...props} unitLabel="rows" />
}
