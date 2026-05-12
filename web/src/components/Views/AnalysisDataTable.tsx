// @ts-nocheck
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { AnalysisSkuDto } from '@prepshipv2/contracts/analysis/contracts'
import {
  AnalysisTableHeader,
  type AnalysisTableColumn,
  type ColumnWidths,
} from './AnalysisTableHeader'
import {
  formatAnalysisMoney,
  type AnalysisSortDir,
  type AnalysisSortKey,
  type AnalysisTotals,
} from './analysis-parity'
import { UnitsTrendSparkline } from './UnitsTrendSparkline'
import './AnalysisDataTable.css'

// Hover-zoom thumbnail preview state, ported from InventoryView so the
// /analysis SKU table behaves identically to /inventory: hovering a
// product image pops a 170px square preview that follows the cursor.
//
// State shape mirrors InventoryView's ThumbnailPreviewState — keeps the
// behavior uniform across pages without lifting state into a context
// (the two views' lifecycles are independent enough that a shared
// context would just add coupling for no real benefit).
interface ThumbnailPreviewState {
  src: string
  left: number
  top: number
  zoom: number
}

function positionThumbnailPreview(cursorX: number, cursorY: number) {
  const zoom = (Number.parseFloat(document.body.style.zoom) || 100) / 100
  const width = 170
  const height = 170
  const gap = 14
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  // Flip the preview to the LEFT/UP edge when it would overflow the
  // viewport on the right/bottom — keeps it always on-screen even
  // for items in the last column or last row.
  const rawLeft = cursorX + gap + width > viewportWidth ? cursorX - width - gap : cursorX + gap
  const rawTop = cursorY + gap + height > viewportHeight ? cursorY - height - gap : cursorY + gap

  return {
    left: rawLeft / zoom,
    top: rawTop / zoom,
    zoom: 1 / zoom,
  }
}

export type AnalysisColumnSize = 'narrow' | 'medium' | 'wide'

interface AnalysisDataTableProps {
  columns: AnalysisTableColumn[]
  sortKey: AnalysisSortKey
  sortDir: AnalysisSortDir
  onSort: (key: AnalysisSortKey) => void
  columnWidths: ColumnWidths
  onResizeColumn: (key: AnalysisSortKey, width: number) => void
  onResetColumn: (key: AnalysisSortKey) => void
  columnSize: AnalysisColumnSize
  rows: AnalysisSkuDto[]
  totals: AnalysisTotals
  maxQty: number
  loading: boolean
  error: string | null
  emptyMessage: string
  onRowClick: (invSkuId: number) => void
  /**
   * Pipe-through for the header's drag-reorder callback. Passed
   * verbatim — see AnalysisTableHeader.onReorder for semantics.
   */
  onReorder?: (fromKey: AnalysisSortKey, toKey: AnalysisSortKey) => void
}

// Horizontal scroll wrapper for the analysis table. Wide mode pins
// the table to a 1400px minimum (see tableClassesFor), so on smaller
// viewports the rightmost columns ("TOTAL SHIP", "EXP ORDERS", …)
// would clip off the right edge without a way to reach them. By
// scrolling horizontally inside the shell instead of overflowing the
// page, the operator can swipe/scroll the table independently while
// the rest of the page stays put. Vertical sticky `<thead>` still
// works because vertical sticky resolves against the page-level
// `view-content` scroll container (a different ancestor); the
// horizontal scroll axis here doesn't interfere. Use `overflow-x-auto`
// (not -scroll) so the scrollbar only appears when actually needed.
// No overflow rule on this wrapper — it's intentional. Adding any
// non-visible overflow (even `overflow-x: auto; overflow-y: visible`)
// makes the wrapper a scroll container per the CSS spec's "non-visible
// + visible → both auto" rule. Sticky <thead> then resolves against
// this wrapper instead of the page-level .view-content scroll
// container, and since the wrapper auto-heights to its content there's
// no vertical overflow to "stick" against — so the thead silently
// scrolls away with the page. By keeping overflow:visible here, the
// thead's sticky resolves against .view-content (overflow-y:auto from
// app-shell.css:523), giving operators a column-header bar that pins
// to the top of the visible area as they scroll long row lists. Trade-
// off: wide tables in WIDE column-size mode horizontally scroll at the
// page level instead of inside the wrapper. Acceptable because (a) most
// operators stay in MEDIUM where the table fits, (b) sticky thead is
// vastly more useful than wrapper-contained horizontal scroll.
const SHELL_CLASSES =
  'border border-line rounded-[10px] bg-surface shadow-[0_1px_3px_rgba(15,23,42,.05),0_1px_2px_rgba(15,23,42,.03)]'

const TABLE_BASE_CLASSES = 'w-full border-separate border-spacing-0'

function tableClassesFor(size: AnalysisColumnSize) {
  // table-fixed is critical for column-resize sanity: with table-auto,
  // the browser treats <th width> as a hint and rebalances neighbor
  // columns to satisfy min-w-full — so widening Orders also widens
  // Client, which is exactly the bug operators reported. table-fixed
  // honors <colgroup>/<col> widths verbatim; one column moves, others
  // stay put. Same pattern Packages and Inventory use successfully.
  if (size === 'narrow') return `${TABLE_BASE_CLASSES} table-fixed min-w-full text-[14px]`
  if (size === 'wide') return `${TABLE_BASE_CLASSES} table-fixed min-w-[1400px] text-[14px]`
  return `${TABLE_BASE_CLASSES} table-fixed min-w-full text-[14px]`
}

// Per-column default widths, tightened 2026-05-12 so the 11-column
// table fits comfortably in MEDIUM mode at typical operator viewports
// (1366-1500px laptop minus ~250px sidebar = ~1116-1250px available).
// Old defaults summed to 1170px without name (which flex-fills); on
// 1166px available the table overflowed and pushed the rightmost
// columns ("EXP ORDERS $XX.XX") past the viewport edge. New defaults
// sum to ~1000px without name → ~1150-1200px with name → fits 1250px
// available comfortably.
//
// 'name' deliberately has NO default so it flex-fills the remaining
// space — long product names stay readable while everything else is
// pinned. Override from columnWidths takes precedence, so operators
// can still drag any column to whatever width they want; if they
// drag wide enough that the total exceeds viewport, page-level
// horizontal scroll engages (acceptable for explicit-resize cases).
//
// Sticky <thead> requires this wrapper NOT to have overflow:auto
// (see SHELL_CLASSES comment), so the page-level scroll is the only
// fallback for genuine table overflow. The tighter defaults make
// that fallback rarely needed in practice.
const ANALYSIS_COLUMN_DEFAULT_WIDTHS: Partial<Record<AnalysisSortKey, number>> = {
  // name: undefined  → flex-fill
  sku: 120,
  client: 120,
  orders: 75,
  pending: 75,
  external: 95,
  qty: 110,
  trend: 85,
  stdOrders: 110,
  expOrders: 110,
  total: 115,
}

function cellPaddingFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'px-1.5 py-2.5'
  if (size === 'wide') return 'px-5 py-2.5'
  return 'px-3 py-2.5'
}

function nameMaxWidthFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'max-w-[140px]'
  if (size === 'wide') return 'max-w-[320px]'
  return 'max-w-[220px]'
}

function pillSizeFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'px-1.5 py-px text-[10px]'
  if (size === 'wide') return 'px-2.5 py-0.5 text-xs2'
  return 'px-2 py-0.5 text-[10.5px]'
}

function skuClassesFor(size: AnalysisColumnSize, isLink: boolean) {
  return [
    cellPaddingFor(size),
    'text-[14px]',
    "font-bold tabular-nums font-['JetBrains_Mono','Fira_Code',ui-monospace,monospace] !text-[#1d4ed8]",
    isLink ? 'underline decoration-[1px] underline-offset-2 decoration-[#1d4ed8]' : '',
    'border-b border-line align-middle',
  ]
    .filter(Boolean)
    .join(' ')
}

function clientClassesFor(size: AnalysisColumnSize) {
  return `${cellPaddingFor(size)} text-[14px] text-ink-2 border-b border-line align-middle`
}

const TD_BASE = 'border-b border-line align-middle text-ink'

export function AnalysisDataTable({
  columns,
  sortKey,
  sortDir,
  onSort,
  columnWidths,
  onResizeColumn,
  onResetColumn,
  columnSize,
  rows,
  totals,
  maxQty,
  loading,
  error,
  emptyMessage,
  onRowClick,
  onReorder,
}: AnalysisDataTableProps) {
  const showRows = !loading && !error && rows.length > 0
  const showEmpty = !loading && !error && rows.length === 0

  const cellPadding = cellPaddingFor(columnSize)
  const nameMaxWidth = nameMaxWidthFor(columnSize)
  const pillSize = pillSizeFor(columnSize)

  // Hover-zoom preview: tracks cursor + image src while hovered. The
  // mousemove listener is only registered while a preview is active
  // (gated by the `if (!thumbnailPreview) return` early-out) so we
  // don't leak handlers across the entire app when nothing is hovered.
  const [thumbnailPreview, setThumbnailPreview] = useState<ThumbnailPreviewState | null>(null)
  useEffect(() => {
    if (!thumbnailPreview) return
    const handleMove = (event: MouseEvent) => {
      setThumbnailPreview((current) => {
        if (!current) return current
        return {
          ...current,
          ...positionThumbnailPreview(event.clientX, event.clientY),
        }
      })
    }
    document.addEventListener('mousemove', handleMove)
    return () => document.removeEventListener('mousemove', handleMove)
  }, [thumbnailPreview])

  function showThumbnailPreview(src: string, event: ReactMouseEvent<HTMLImageElement>) {
    if (!src) return
    setThumbnailPreview({
      src,
      ...positionThumbnailPreview(event.clientX, event.clientY),
    })
  }
  function hideThumbnailPreview() {
    setThumbnailPreview(null)
  }

  return (
    <div className={SHELL_CLASSES}>
      <table id="analysis-table" className={tableClassesFor(columnSize)}>
        {/* Colgroup pins per-column widths so table-fixed has a
            definite layout for every visible column. Operator drags
            on the resize handle update columnWidths[key] which
            overrides the default here. 'name' deliberately gets no
            width → flex-fills remaining space (long product names
            stay readable). Iterates `columns` so reorder/hide are
            honored. */}
        <colgroup>
          {columns.map((column) => {
            const explicitWidth = columnWidths[column.key]
            const fallbackWidth = ANALYSIS_COLUMN_DEFAULT_WIDTHS[column.key]
            const width = explicitWidth ?? fallbackWidth
            return <col key={column.key} style={width ? { width } : undefined} />
          })}
        </colgroup>
        <AnalysisTableHeader
          columns={columns}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          widths={columnWidths}
          onResizeColumn={onResizeColumn}
          onResetColumn={onResetColumn}
          columnSize={columnSize}
          onReorder={onReorder}
        />
        <tbody id="analysis-tbody">
          {error ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-12 text-center text-danger text-[13px] font-semibold">
                Error: {error}
              </td>
            </tr>
          ) : showEmpty ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-12 text-center text-ink-3 text-[13px]">
                {emptyMessage}
              </td>
            </tr>
          ) : showRows ? (
            rows.map((row) => {
              const qtyBarWidth = Math.round((row.qty / maxQty) * 80)
              const isClickable = Boolean(row.invSkuId)
              // Per-UNIT shipping average (boss directive 2026-05-07):
              // divide by total UNITS shipped via this class, not by
              // order count. So a 2-unit / $23 order shows $11.50/unit
              // instead of $23/order. The API allocates mixed-SKU label
              // costs by item units before returning the class totals.
              // Falls back to ship-count divisor if qty total is missing
              // (older API response).
              const stdQtyDivisor =
                (row as { standardShipQtyTotal?: number }).standardShipQtyTotal ??
                row.standardShipCount
              const expQtyDivisor =
                (row as { expeditedShipQtyTotal?: number }).expeditedShipQtyTotal ??
                row.expeditedShipCount
              const stdAvg =
                stdQtyDivisor > 0
                  ? (row.standardShipTotal ?? 0) / stdQtyDivisor
                  : 0
              const expAvg =
                expQtyDivisor > 0
                  ? (row.expeditedShipTotal ?? 0) / expQtyDivisor
                  : 0

              const rowClasses = [
                'transition-[background,box-shadow] duration-150',
                'even:bg-[#fafbfc]',
                isClickable
                  ? 'cursor-pointer hover:bg-[#eef4ff] hover:shadow-[inset_3px_0_0_var(--ss-blue)]'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <tr
                  key={`${row.sku || row.name}-${row.clientName}`}
                  className={rowClasses}
                  title={isClickable ? 'View SKU details' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  onKeyDown={
                    isClickable
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onRowClick(row.invSkuId as number)
                          }
                        }
                      : undefined
                  }
                  onClick={
                    isClickable ? () => onRowClick(row.invSkuId as number) : undefined
                  }
                >
                  {/* Cells render dynamically from the `columns` prop so
                      the user's chosen ORDER and VISIBILITY (drag-reorder
                      + show/hide toggle controls in AnalysisView) are
                      honored without duplicating JSX. Each renderer
                      below produces the exact same markup the hardcoded
                      version produced — only the dispatch is data-driven. */}
                  {columns.map((col) => {
                    switch (col.key) {
                      case 'name':
                        return (
                          <td
                            key="name"
                            className={`${cellPadding} ${nameMaxWidth} font-medium text-ink ${TD_BASE}`}
                            title={row.name}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-line bg-surface-2 overflow-hidden"
                                aria-hidden
                              >
                                {row.imageUrl ? (
                                  <img
                                    src={row.imageUrl}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover cursor-zoom-in"
                                    onMouseEnter={(e) => showThumbnailPreview(row.imageUrl as string, e)}
                                    onMouseLeave={hideThumbnailPreview}
                                    onError={(e) => {
                                      (e.currentTarget as HTMLImageElement).style.display = 'none'
                                    }}
                                  />
                                ) : (
                                  <span className="text-[9px] font-semibold text-ink-3 uppercase tracking-wider">—</span>
                                )}
                              </span>
                              <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                                {row.name}
                              </span>
                            </div>
                          </td>
                        )
                      case 'sku':
                        return (
                          <td key="sku" className={skuClassesFor(columnSize, isClickable)}>
                            {row.sku || <span className="text-line-2">—</span>}
                          </td>
                        )
                      case 'client':
                        return (
                          <td key="client" className={clientClassesFor(columnSize)}>
                            {row.clientName || '—'}
                          </td>
                        )
                      case 'orders':
                        return (
                          <td key="orders" className={`${cellPadding} text-right whitespace-nowrap tabular-nums font-bold ${TD_BASE}`}>
                            {row.orders}
                          </td>
                        )
                      case 'pending':
                        return (
                          <td key="pending" className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                            {row.pendingOrders > 0 ? (
                              <span
                                className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(224,122,0,.12)] text-[#b86200]`}
                              >
                                {row.pendingOrders}
                                <span className="text-[9px] font-semibold opacity-75">pend</span>
                              </span>
                            ) : (
                              <span className="text-line-2">—</span>
                            )}
                          </td>
                        )
                      case 'external':
                        return (
                          <td key="external" className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                            {row.externalOrders > 0 ? (
                              <span
                                className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(138,149,163,.16)] text-ink-2`}
                              >
                                {row.externalOrders}
                                <span className="text-[9px] font-semibold opacity-75">ext</span>
                              </span>
                            ) : (
                              <span className="text-line-2">—</span>
                            )}
                          </td>
                        )
                      case 'qty':
                        return (
                          <td key="qty" className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                            <span className="inline-flex items-center justify-end gap-[7px]">
                              <span
                                className="h-1.5 rounded-[3px] opacity-65 min-w-[1px] bg-gradient-to-r from-brand to-[#5b8def]"
                                style={{ width: qtyBarWidth }}
                              />
                              <span className="font-semibold text-[14px] min-w-[36px] text-right tabular-nums">
                                {row.qty.toLocaleString()}
                              </span>
                            </span>
                          </td>
                        )
                      case 'trend':
                        return (
                          <td key="trend" className={`${cellPadding} whitespace-nowrap align-middle text-center ${TD_BASE}`}>
                            <span className="inline-flex items-center justify-center">
                              <UnitsTrendSparkline
                                series={(row as { dailyQty?: number[] }).dailyQty ?? []}
                              />
                            </span>
                          </td>
                        )
                      case 'stdOrders':
                        return (
                          <td key="stdOrders" className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                            {row.standardShipCount > 0 ? (
                              <>
                                <span className="font-bold">{row.standardShipCount}</span>
                                <span className="ml-1.5 text-[10.5px] font-semibold tabular-nums text-ok">
                                  {formatAnalysisMoney(stdAvg)}
                                </span>
                              </>
                            ) : (
                              <span className="text-line-2">—</span>
                            )}
                          </td>
                        )
                      case 'expOrders':
                        return (
                          <td key="expOrders" className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                            {row.expeditedShipCount > 0 ? (
                              <>
                                <span
                                  className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(224,122,0,.12)] text-[#b86200]`}
                                >
                                  {row.expeditedShipCount}
                                </span>
                                <span className="ml-1.5 text-[10.5px] font-semibold tabular-nums text-ink-3">
                                  {formatAnalysisMoney(expAvg)}
                                </span>
                              </>
                            ) : (
                              <span className="text-line-2">—</span>
                            )}
                          </td>
                        )
                      case 'total':
                        return (
                          <td key="total" className={`${cellPadding} text-right whitespace-nowrap tabular-nums font-extrabold text-[14px] text-ink ${TD_BASE}`}>
                            {row.totalShipping > 0 ? (
                              formatAnalysisMoney(row.totalShipping)
                            ) : (
                              <span className="text-ink-3">—</span>
                            )}
                          </td>
                        )
                      default:
                        return null
                    }
                  })}
                </tr>
              )
            })
          ) : null}
        </tbody>
        <tfoot id="analysis-tfoot">
          {showRows ? (
            <tr className="bg-gradient-to-b from-[#f8fafc] to-[#eef3f8] border-t-2 border-line font-bold">
              {/* Footer cells render in the same dynamic order as the
                  body. The previous version used colSpan={3} to merge
                  name+sku+client into one "TOTALS X SKUs" cell — that
                  trick doesn't compose with reorder/hide, so we now
                  show the "TOTALS X SKUs" badge in the FIRST visible
                  column instead. Other columns render their aggregate
                  (or '—' for those without one, like trend). */}
              {columns.map((col, idx) => {
                const isFirstVisible = idx === 0
                const footerTotalsBadge = isFirstVisible ? (
                  <>
                    <span className="text-ink-3 font-extrabold text-[10px] uppercase tracking-[0.06em] mr-2.5">
                      TOTALS
                    </span>
                    {totals.skuCount.toLocaleString()} SKUs
                  </>
                ) : null
                const ftBase = `${cellPadding} border-t-2 border-line tabular-nums`
                switch (col.key) {
                  case 'name':
                  case 'sku':
                  case 'client':
                    // Identity columns get the TOTALS badge if they're
                    // the first visible column, otherwise stay empty.
                    return (
                      <td key={col.key} className={`${ftBase} text-[14px] text-ink`}>
                        {footerTotalsBadge}
                      </td>
                    )
                  case 'orders':
                    return (
                      <td key="orders" className={`${ftBase} text-right text-[14px] text-ink`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalOrders.toLocaleString()}
                      </td>
                    )
                  case 'pending':
                    return (
                      <td key="pending" className={`${ftBase} text-right text-[14px] text-[#b86200]`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalPending > 0 ? totals.totalPending.toLocaleString() : '—'}
                      </td>
                    )
                  case 'external':
                    return (
                      <td key="external" className={`${ftBase} text-right text-[14px] text-ink-3`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalExternal > 0 ? totals.totalExternal.toLocaleString() : '—'}
                      </td>
                    )
                  case 'qty':
                    return (
                      <td key="qty" className={`${ftBase} text-right text-[14px] text-ink`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalQty.toLocaleString()}
                      </td>
                    )
                  case 'trend':
                    // Trend has no meaningful aggregate (averaging
                    // trend scores across SKUs is misleading), so the
                    // footer cell stays blank.
                    return (
                      <td key="trend" className={`${ftBase} text-center text-[14px] text-ink-3`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        <span className="text-line-2">—</span>
                      </td>
                    )
                  case 'stdOrders':
                    return (
                      <td key="stdOrders" className={`${ftBase} text-right text-[14px] text-ink`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalStdCount > 0 ? totals.totalStdCount.toLocaleString() : '—'}
                      </td>
                    )
                  case 'expOrders':
                    return (
                      <td key="expOrders" className={`${ftBase} text-right text-[14px] text-[#b86200]`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalExpCount > 0 ? totals.totalExpCount.toLocaleString() : '—'}
                      </td>
                    )
                  case 'total':
                    return (
                      <td key="total" className={`${ftBase} text-right text-[13px] text-ink font-extrabold`}>
                        {isFirstVisible ? footerTotalsBadge : null}
                        {totals.totalShipping > 0 ? formatAnalysisMoney(totals.totalShipping) : '—'}
                      </td>
                    )
                  default:
                    return null
                }
              })}
            </tr>
          ) : null}
        </tfoot>
      </table>

      {/* Hover-zoom preview overlay — fixed-position floating panel
          that follows the cursor while hovering a thumbnail. Reuses
          the .inventory-thumb-preview CSS class from InventoryView
          so the visual treatment is identical (170px square, white
          card, soft shadow). pointer-events:none in the CSS lets
          subsequent mousemoves keep firing on the underlying img
          for smooth cursor tracking. */}
      {thumbnailPreview ? (
        <div
          className="inventory-thumb-preview"
          style={{
            left: `${thumbnailPreview.left}px`,
            top: `${thumbnailPreview.top}px`,
            zoom: String(thumbnailPreview.zoom),
          }}
        >
          <img src={thumbnailPreview.src} alt="" />
        </div>
      ) : null}
    </div>
  )
}
