// OrdersView perf (2026-07-08): the per-order <tr> — both the flat branch and
// the sku-grouped branch's member rows — extracted from OrdersTable.tsx with
// BYTE-IDENTICAL markup and wrapped in React.memo.
//
// Memo contract (FE-1 slice, audit 2026-07-13): renderCell now has a STABLE
// identity — OrdersView dispatches through a latest-ref useCallback — so this
// memo bails on any render where the row's own props did not change (poll ticks
// with unchanged data, hover crossings, unrelated modal/panel state). Staleness
// safety: every shared cell input that renderCell reads but that is NOT a row
// prop (selection ids, auto-rate entries, batch recalc rows, bundles, filters,
// account state, view status/read-only flag) is folded into the opaque
// cellStateEpoch prop, whose identity changes whenever any of them change — the
// shallow compare then misses and the row repaints from current state before
// any cell could show stale shared state.
//
// This component renders markup only; it owns no data state and no business
// decisions. The select-cell lockdown gate lives inside renderCell (OrdersView)
// and is untouched.
import { memo } from 'react'
import type { ReactNode } from 'react'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import type { TableColumn } from './orders-table-columns'
import { getActiveItems } from './orders-items'
import { getClientPalette } from './orders-formatting'
import { getExpeditedBadge, getIsException } from './orders-display-state'

export type OrderRowProps = {
  order: OrderSummaryDto
  detail: OrderFullDto | null
  visibleColumns: TableColumn[]
  isSelected: boolean
  // panelOrderId can be undefined upstream; the caller compares with === so a
  // plain boolean is equivalent here.
  isPanelOpen: boolean
  isKbFocus: boolean
  // 30-second Print Label success fade. Only the sku-grouped branch threads a
  // live value; the flat branch passes false — mirroring the pre-extraction
  // markup where only the grouped rows carried the ps-shipping-row class.
  isTransitioningShipped: boolean
  openOrderDetails: (orderId: number) => void
  openShipStationOrder: (orderId: number) => void
  setKbRowId: (orderId: number | null) => void
  renderCell: (order: OrderSummaryDto, column: TableColumn) => ReactNode
  // Opaque shared-cell-state snapshot (see the memo contract above). Never read
  // by this component — deliberately NOT destructured below — it participates
  // only in React.memo's default shallow prop compare.
  cellStateEpoch?: unknown
  virtualIndex?: number
  measureElement?: (element: HTMLTableRowElement | null) => void
  stripeEven?: boolean
}

export const OrderRow = memo(function OrderRow({
  order,
  detail,
  visibleColumns,
  isSelected,
  isPanelOpen,
  isKbFocus,
  isTransitioningShipped,
  openOrderDetails,
  openShipStationOrder,
  setKbRowId,
  renderCell,
  virtualIndex,
  measureElement,
  stripeEven,
}: OrderRowProps) {
  const items = getActiveItems(order, detail)
  const uniqueSkus = new Set(items.map((item) => item.sku).filter(Boolean))
  const multiSku = uniqueSkus.size > 1
  const rowClasses = [
    'order-row',
    isSelected ? 'row-selected' : '',
    isPanelOpen ? 'row-panel-open' : '',
    isKbFocus ? 'row-kb-focus' : '',
    multiSku ? 'multi-sku-row' : '',
    getIsException(order) ? 'row-exception' : '',
    stripeEven ? 'row-stripe-even' : '',
    // 30-second continuous fade animation triggered
    // by Print Label success. CSS keyframe is
    // `ps-shipping-fade` in app-shell.css (visible
    // throughout the 30s — opacity goes 1 → 0 with
    // a 4-stop curve so the change is perceivable
    // every few seconds, plus a slight rightward
    // slide so the row looks like it's "leaving"
    // toward the Shipped tab).
    isTransitioningShipped ? 'ps-shipping-row' : '',
  ].filter(Boolean).join(' ')
  const clientColor = getClientPalette(order.clientName ?? 'Untagged').border
  const expedited = getExpeditedBadge(order, detail)

  return (
    <tr
      ref={measureElement}
      id={`row-${order.orderId}`}
      data-index={virtualIndex}
      className={expedited ? `${rowClasses} row-expedited row-expedited--${expedited.tier}` : rowClasses}
      data-expedited={expedited ? expedited.tier : undefined}
      style={{ borderLeft: `3px solid ${clientColor}` }}
      onClick={() => openOrderDetails(order.orderId)}
      onDoubleClick={() => openShipStationOrder(order.orderId)}
      onMouseEnter={() => setKbRowId(order.orderId)}
    >
      {visibleColumns.map((column) => (
        <td
          key={column.key}
          data-col={column.key}
          // Explicit width on the body cell mirrors the
          // colgroup + thead width so browsers never
          // misalign header vs body — even when an inner
          // cell renderer (e.g. cell-itemname's
          // maxWidth: column.width + 90 hover-preview
          // trick) tries to grow content past the
          // declared cell width. With table-layout:
          // fixed the colgroup wins anyway, but the
          // explicit td width is a belt-and-braces
          // guard for subpixel rendering edge cases.
          style={{ width: column.width, maxWidth: column.width }}
          title={column.key === 'select' ? 'Use checkbox for multi-select' : 'Open order details; use checkbox for bulk selection'}
        >
          {renderCell(order, column)}
        </td>
      ))}
    </tr>
  )
})
