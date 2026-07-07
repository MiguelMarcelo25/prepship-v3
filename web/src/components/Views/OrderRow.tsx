// OrdersView perf (2026-07-08): the per-order <tr> — both the flat branch and
// the sku-grouped branch's member rows — extracted from OrdersTable.tsx with
// BYTE-IDENTICAL markup and wrapped in React.memo.
//
// Why memo is safe here WITHOUT stabilizing renderCell: renderCell is the
// OrdersView-owned dispatcher, recreated on every OrdersView render. So any
// OrdersView render (data refresh, selection, rates arriving…) changes this
// component's renderCell prop and re-renders every row — exactly the
// pre-extraction behavior, no stale-cell risk. The memo only bails out when
// OrdersTable re-renders LOCALLY (its own kbRowId hover/keyboard state) while
// OrdersView did not — then only the rows whose isKbFocus flag flipped
// re-render instead of every cell on the page.
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
      id={`row-${order.orderId}`}
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
