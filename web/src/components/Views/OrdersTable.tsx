// PS-166/PS-306/PS-258 (Wave 6): the orders TABLE (thead + tbody) extracted
// from OrdersView.tsx with BYTE-IDENTICAL markup. This is the `<table
// id="ordersTable">` that OrdersView previously rendered inline as the
// <OrdersResultsShell> child (the table slot); it now lives here and OrdersView
// renders <OrdersTable …/> in the exact same position.
//
// VERBATIM / PRESENTATIONAL attestation:
//   The markup below — `id="ordersTable"`, `id="tableHead"`, `id="ordersBody"`,
//   the <colgroup>, every column-header <th> (sortable/draggable/resizable),
//   the dual tbody row-map (the skuSortActive sku-grouped branch + the flat
//   branch), every className, data-attr, style, title, and aria — is a verbatim
//   move. The DOM byte-equality cert (test:orders-dom-parity:browser) snapshots
//   #ordersTable's normalized innerHTML, so any drift fails instantly; this is a
//   pure relocation, so it stays byte-identical.
//
//   This component owns NO data state and NO business decisions. The per-cell
//   dispatcher renderTableCell STAYS in OrdersView (it closes over
//   orderDetailsById / getActiveItems / panel state) and is threaded in as the
//   `renderCell` render-prop, called exactly where renderTableCell(order,
//   column) was called before. Likewise every parent closure used in the
//   thead/tbody — the header click/drag/drop/keydown handlers, finishHeaderDrag,
//   startColumnResize, toggleSkuGroupSelection, openOrderDetails,
//   openShipStationOrder, setKbRowId — is passed in as a prop; their bodies stay
//   in OrdersView. The pure presentational helpers (getActiveItems /
//   getClientPalette / getExpeditedBadge / getIsException) are imported directly
//   from their strict modules (same pure functions OrdersView calls), not
//   re-derived.
//
// LOCKDOWN: this is the awaiting/shipped/cancelled results table render only —
//   it reads no shipped/cancelled data and contains no mutation gate. The
//   isReadOnly flag (which hides the SKU-group select-all checkbox, mirroring
//   the per-row checkbox gate) is passed in from the OrdersView shell and its
//   meaning is UNCHANGED.
import type { ReactNode } from 'react'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import type { GroupedOrdersBySku } from './orders-grouping'
import type { SortKey, TableColumn, TableColumnKey } from './orders-table-columns'

// Mirror of the OrdersView-local SortDirection alias (it is declared inline in
// OrdersView, not exported); kept identical so the sortState prop's `dir` type
// matches the parent's useState exactly.
type SortDirection = 'asc' | 'desc'
import { getActiveItems } from './orders-items'
import { getClientPalette } from './orders-formatting'
import { getExpeditedBadge, getIsException } from './orders-display-state'

export type OrdersTableProps = {
  // ── table shell + columns ──
  visibleColumns: TableColumn[]
  tableWidth: number
  tableDensity: string
  // ── header state (sort / drag / resize) ──
  sortState: { key: SortKey; dir: SortDirection }
  dragColumnKey: TableColumnKey | null
  dragOverColumnKey: TableColumnKey | null
  resizingColumnKey: TableColumnKey | null
  // ── header handlers (bodies stay in OrdersView) ──
  handleHeaderClick: (column: TableColumn) => void
  handleHeaderKeyDown: (event: React.KeyboardEvent<HTMLTableCellElement>, column: TableColumn) => void
  handleHeaderDragStart: (event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) => void
  handleHeaderDragOver: (event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) => void
  handleHeaderDrop: (event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) => void
  finishHeaderDrag: () => void
  startColumnResize: (event: React.MouseEvent<HTMLDivElement>, column: TableColumn) => void
  // ── rows (flat + sku-grouped) ──
  orderedFilteredOrders: OrderSummaryDto[]
  skuSortActive: boolean
  skuOrderGroups: GroupedOrdersBySku<OrderSummaryDto>[]
  orderDetailsById: Map<number, OrderFullDto>
  // ── row selection / highlight state ──
  selectedIdSet: Set<number>
  // panelOrderId is `activeOrderId ?? (… ? selectedOrderIds[0] : null)` in
  // OrdersView; the array index can be undefined, so the inferred type is
  // number | null | undefined. Mirror it exactly (the === row-highlight
  // comparison below behaves identically for undefined).
  panelOrderId: number | null | undefined
  kbRowId: number | null
  transitionalShippedIds: Set<number>
  isReadOnly: boolean
  // ── row + group handlers (bodies stay in OrdersView) ──
  toggleSkuGroupSelection: (orderIds: number[], checked?: boolean) => void
  openOrderDetails: (orderId: number) => void
  openShipStationOrder: (orderId: number) => void
  setKbRowId: (orderId: number | null) => void
  // ── per-cell dispatcher (closes over OrdersView state) ──
  renderCell: (order: OrderSummaryDto, column: TableColumn) => ReactNode
}

export function OrdersTable({
  visibleColumns,
  tableWidth,
  tableDensity,
  sortState,
  dragColumnKey,
  dragOverColumnKey,
  resizingColumnKey,
  handleHeaderClick,
  handleHeaderKeyDown,
  handleHeaderDragStart,
  handleHeaderDragOver,
  handleHeaderDrop,
  finishHeaderDrag,
  startColumnResize,
  orderedFilteredOrders,
  skuSortActive,
  skuOrderGroups,
  orderDetailsById,
  selectedIdSet,
  panelOrderId,
  kbRowId,
  transitionalShippedIds,
  isReadOnly,
  toggleSkuGroupSelection,
  openOrderDetails,
  openShipStationOrder,
  setKbRowId,
  renderCell,
}: OrdersTableProps) {
  return (
    <table
      className={`orders-table density-${tableDensity}`}
      id="ordersTable"
      style={{ minWidth: tableWidth, width: tableWidth, tableLayout: 'fixed' }}
    >
      <colgroup>
        {visibleColumns.map((column) => (
          <col key={column.key} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead id="tableHead">
        <tr>
          {visibleColumns.map((column) => {
            const sortable = column.sort != null
            const sorted = sortable && sortState.key === column.sort
            const headerClasses = [
              sortable ? (sorted ? `sortable sort-${sortState.dir}` : 'sortable') : '',
              dragColumnKey === column.key ? 'col-dragging' : '',
              dragOverColumnKey === column.key ? 'col-drag-over' : '',
              resizingColumnKey === column.key ? 'col-resizing' : '',
            ].filter(Boolean).join(' ')
            return (
              <th
                key={column.key}
                data-col={column.key}
                style={{
                  width: column.width,
                  position: 'relative',
                  ...(column.key === 'qty' ? { textAlign: 'center' } : null),
                }}
                className={headerClasses || undefined}
                draggable={column.key !== 'select'}
                tabIndex={column.key !== 'select' ? 0 : undefined}
                aria-sort={sortable ? (sorted ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                aria-label={column.key !== 'select' ? `${column.label}. Drag to reorder. Use Alt+Arrow to move and Shift+Arrow to resize.` : undefined}
                title={column.key !== 'select' ? 'Drag to reorder. Drag the right edge to resize. Alt+Arrow moves; Shift+Arrow resizes.' : undefined}
                onClick={sortable ? () => handleHeaderClick(column) : undefined}
                onKeyDown={(event) => handleHeaderKeyDown(event, column)}
                onDragStart={(event) => handleHeaderDragStart(event, column.key)}
                onDragOver={(event) => handleHeaderDragOver(event, column.key)}
                onDrop={(event) => handleHeaderDrop(event, column.key)}
                onDragEnd={finishHeaderDrag}
              >
                {column.label}
                {sortable ? <span className="sort-arrow" /> : null}
                {column.key !== 'select' ? (
                  <div
                    className={`col-resizer${resizingColumnKey === column.key ? ' active' : ''}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.label} column`}
                    onMouseDown={(event) => startColumnResize(event, column)}
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => event.stopPropagation()}
                  />
                ) : null}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody id="ordersBody">
        {(skuSortActive ? skuOrderGroups.flatMap((group) => {
          const groupOrderIds = group.orders.map((order) => order.orderId)
          const allGroupSelected = groupOrderIds.length > 0 && groupOrderIds.every((orderId) => selectedIdSet.has(orderId))
          const someGroupSelected = !allGroupSelected && groupOrderIds.some((orderId) => selectedIdSet.has(orderId))
          const header = (
            <tr key={`sku-group-${group.key}`} className="sku-group-header">
              <td
                colSpan={visibleColumns.length}
                style={{
                  padding: '6px 12px',
                  background: 'var(--ss-blue-bg)',
                  borderTop: '2px solid var(--ss-blue)',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: 'var(--ss-blue)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {/* Lockdown — SKU group select-all also hidden
                      on Shipped/Cancelled. Same reason as the
                      per-row checkbox: no bulk-modify pathway. */}
                  {isReadOnly ? null : (
                    <input
                      type="checkbox"
                      checked={allGroupSelected}
                      aria-label={`Select current page SKU group ${group.label}`}
                      ref={(node) => {
                        if (node) node.indeterminate = someGroupSelected
                      }}
                      style={{ width: 16, height: 16, accentColor: 'var(--ss-blue)', cursor: 'pointer', flexShrink: 0 }}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        event.stopPropagation()
                        toggleSkuGroupSelection(groupOrderIds, event.target.checked)
                      }}
                    />
                  )}
                  <span style={{ fontSize: 13 }}>📦</span>
                  <span className="sku-link" style={{ fontSize: 11.5 }} title={group.label}>{group.label}</span>
                  {group.quantity != null ? (
                    <span style={{ fontWeight: 700, color: 'var(--text)' }}>
                      Qty {group.quantity}
                    </span>
                  ) : null}
                  <span style={{ fontWeight: 400, color: 'var(--text2)' }}>
                    SKU group current page · {group.count.toLocaleString()} order{group.count === 1 ? '' : 's'}
                  </span>
                </div>
              </td>
            </tr>
          )

          const rows = group.orders.map((order) => {
            const detail = orderDetailsById.get(order.orderId) ?? null
            const items = getActiveItems(order, detail)
            const uniqueSkus = new Set(items.map((item) => item.sku).filter(Boolean))
            const multiSku = uniqueSkus.size > 1
            const isTransitioningShipped = transitionalShippedIds.has(order.orderId)
            const rowClasses = [
              'order-row',
              selectedIdSet.has(order.orderId) ? 'row-selected' : '',
              panelOrderId === order.orderId ? 'row-panel-open' : '',
              kbRowId === order.orderId ? 'row-kb-focus' : '',
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
                key={order.orderId}
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
                    // See twin <td> below — explicit width
                    // mirrors colgroup + thead so browsers can't
                    // drift body content out of column alignment.
                    style={{ width: column.width, maxWidth: column.width }}
                    title={column.key === 'select' ? 'Use checkbox for multi-select' : 'Open order details; use checkbox for bulk selection'}
                  >
                    {renderCell(order, column)}
                  </td>
                ))}
              </tr>
            )
          })

          return [header, ...rows]
        }) : orderedFilteredOrders.map((order) => {
          const detail = orderDetailsById.get(order.orderId) ?? null
          const items = getActiveItems(order, detail)
          const uniqueSkus = new Set(items.map((item) => item.sku).filter(Boolean))
          const multiSku = uniqueSkus.size > 1
          const rowClasses = [
            'order-row',
            selectedIdSet.has(order.orderId) ? 'row-selected' : '',
            panelOrderId === order.orderId ? 'row-panel-open' : '',
            kbRowId === order.orderId ? 'row-kb-focus' : '',
            multiSku ? 'multi-sku-row' : '',
            getIsException(order) ? 'row-exception' : '',
          ].filter(Boolean).join(' ')
          const clientColor = getClientPalette(order.clientName ?? 'Untagged').border
          const expedited = getExpeditedBadge(order, detail)

          return (
            <tr
              key={order.orderId}
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
        }))}
      </tbody>
    </table>
  )
}
