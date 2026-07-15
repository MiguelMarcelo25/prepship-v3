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
//   openShipStationOrder — is passed in as a prop; their bodies stay in
//   OrdersView. The ONE piece of UI state owned here is the row hover/keyboard
//   focus (kbRowId + the Arrow/Enter/Ctrl-C row-nav listener, moved DOWN from
//   OrdersView 2026-07-08): table-local focus means a hover crossing re-renders
//   this table only — and via the memoized ./OrderRow only the two rows whose
//   focus flag flipped — instead of the whole OrdersView shell. Escape
//   (rate-browser close / clear selection) stays in OrdersView with its owners.
//   The per-row <tr> markup moved VERBATIM to ./OrderRow.
//
// LOCKDOWN: this is the awaiting/shipped/cancelled results table render only —
//   it reads no shipped/cancelled data and contains no mutation gate. The
//   isReadOnly flag (which hides the SKU-group select-all checkbox, mirroring
//   the per-row checkbox gate) is passed in from the OrdersView shell and its
//   meaning is UNCHANGED.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import type { GroupedOrdersBySku } from './orders-grouping'
import type { SortKey, TableColumn, TableColumnKey } from './orders-table-columns'
import {
  getVirtualTablePadding,
  shouldVirtualizeTable,
  TABLE_VIRTUALIZATION_OVERSCAN,
} from '../ui/table-virtualization'

// Mirror of the OrdersView-local SortDirection alias (it is declared inline in
// OrdersView, not exported); kept identical so the sortState prop's `dir` type
// matches the parent's useState exactly.
type SortDirection = 'asc' | 'desc'
import { OrderRow } from './OrderRow'

export type OrdersTableProps = {
  // ── table shell + columns ──
  visibleColumns: TableColumn[]
  tableWidth: number
  tableDensity: string
  scrollElementRef: RefObject<HTMLDivElement>
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
  transitionalShippedIds: Set<number>
  isReadOnly: boolean
  // ── row + group handlers (bodies stay in OrdersView) ──
  toggleSkuGroupSelection: (orderIds: number[], checked?: boolean) => void
  openOrderDetails: (orderId: number) => void
  openShipStationOrder: (orderId: number) => void
  // ── row-nav collaborators (bodies stay in OrdersView; called by the
  //    table-local Arrow/Enter/Ctrl-C keyboard listener) ──
  updateSelection: (orderIds: number[]) => void
  copyText: (text: string) => void
  showToast: (message: string) => void
  // ── per-cell dispatcher (closes over OrdersView state) ──
  renderCell: (order: OrderSummaryDto, column: TableColumn) => ReactNode
  // FE-1 slice (audit 2026-07-13): opaque snapshot of the shared cell-visible
  // OrdersView state that renderCell reads but that is NOT threaded as a row
  // prop (selection ids, rate entries, batch rows, bundles, filters…). This
  // table never reads it — it is forwarded to <OrderRow> so the memo's shallow
  // compare re-renders rows whenever any shared cell input changes, now that
  // renderCell itself has a render-stable identity.
  cellStateEpoch: unknown
}

type OrdersTableRenderEntry =
  | { kind: 'group'; key: string; group: GroupedOrdersBySku<OrderSummaryDto> }
  | { kind: 'order'; key: string; order: OrderSummaryDto; transitioning: boolean }

export function OrdersTable({
  visibleColumns,
  tableWidth,
  tableDensity,
  scrollElementRef,
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
  transitionalShippedIds,
  isReadOnly,
  toggleSkuGroupSelection,
  openOrderDetails,
  openShipStationOrder,
  updateSelection,
  copyText,
  showToast,
  renderCell,
  cellStateEpoch,
}: OrdersTableProps) {
  // Row hover/keyboard focus is table-local (moved down from OrdersView): a
  // hover crossing re-renders only this table, and the memoized <OrderRow>
  // bails out every row whose isKbFocus flag did not flip.
  const [kbRowId, setKbRowId] = useState<number | null>(null)
  const tableRows = useMemo<OrdersTableRenderEntry[]>(() => {
    if (!skuSortActive) {
      return orderedFilteredOrders.map((order) => ({
        kind: 'order',
        key: `order-${order.orderId}`,
        order,
        transitioning: false,
      }))
    }
    return skuOrderGroups.flatMap((group) => [
      { kind: 'group' as const, key: `sku-group-${group.key}`, group },
      ...group.orders.map((order) => ({
        kind: 'order' as const,
        key: `order-${order.orderId}`,
        order,
        transitioning: transitionalShippedIds.has(order.orderId),
      })),
    ])
  }, [orderedFilteredOrders, skuOrderGroups, skuSortActive, transitionalShippedIds])
  const virtualRowsEnabled = shouldVirtualizeTable(tableRows.length)
  const getVirtualRowKey = useCallback(
    (index: number) => tableRows[index]?.key ?? index,
    [tableRows],
  )
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtualRowsEnabled ? tableRows.length : 0,
    enabled: virtualRowsEnabled,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => {
      if (tableRows[index]?.kind === 'group') return 38
      if (tableDensity === 'narrow') return 42
      if (tableDensity === 'wide') return 72
      return 58
    },
    getItemKey: getVirtualRowKey,
    overscan: TABLE_VIRTUALIZATION_OVERSCAN,
  })
  const virtualRows = virtualRowsEnabled ? rowVirtualizer.getVirtualItems() : []
  const renderedRows = virtualRowsEnabled
    ? virtualRows.map((item) => ({ index: item.index, entry: tableRows[item.index] }))
    : tableRows.map((entry, index) => ({ index, entry }))
  const { paddingTop: virtualPaddingTop, paddingBottom: virtualPaddingBottom } =
    getVirtualTablePadding(virtualRows, rowVirtualizer.getTotalSize())
  const rowIndexByOrderId = useMemo(() => {
    const indexes = new Map<number, number>()
    tableRows.forEach((entry, index) => {
      if (entry.kind === 'order') indexes.set(entry.order.orderId, index)
    })
    return indexes
  }, [tableRows])

  // Arrow/Enter/Ctrl-C row navigation (moved VERBATIM from the OrdersView
  // keydown listener; the Escape branch — rate-browser close / clear selection
  // — stays in OrdersView with the state it operates on).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = kbRowId != null ? orderedFilteredOrders.findIndex((order) => order.orderId === kbRowId) : -1
        const nextIndex = Math.max(0, Math.min(orderedFilteredOrders.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)))
        const nextOrder = orderedFilteredOrders[nextIndex]
        if (!nextOrder) return
        setKbRowId(nextOrder.orderId)
        const virtualIndex = rowIndexByOrderId.get(nextOrder.orderId)
        if (virtualRowsEnabled && virtualIndex != null) {
          rowVirtualizer.scrollToIndex(virtualIndex, { align: 'auto' })
        } else {
          document.getElementById(`row-${nextOrder.orderId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
        return
      }

      if (event.key === 'Enter' && kbRowId != null) {
        updateSelection([kbRowId])
        return
      }

      if (event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey) && !event.shiftKey && kbRowId != null) {
        const order = orderedFilteredOrders.find((candidate) => candidate.orderId === kbRowId)
        if (order?.orderNumber) {
          copyText(order.orderNumber)
          showToast(`📋 Copied: ${order.orderNumber}`)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [kbRowId, orderedFilteredOrders, rowIndexByOrderId, virtualRowsEnabled, rowVirtualizer])

  return (
    <table
      className={`orders-table density-${tableDensity}${virtualRowsEnabled ? ' is-virtualized' : ''}`}
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
        {virtualRowsEnabled && virtualPaddingTop > 0 ? (
          <tr aria-hidden="true" className="virtual-table-spacer">
            <td colSpan={visibleColumns.length} style={{ height: virtualPaddingTop, padding: 0, border: 0 }} />
          </tr>
        ) : null}
        {virtualRowsEnabled ? renderedRows.map(({ entry, index }) => {
          if (!entry) return null
          if (entry.kind === 'group') {
            const { group } = entry
            const groupOrderIds = group.orders.map((order) => order.orderId)
            const allGroupSelected = groupOrderIds.length > 0 && groupOrderIds.every((orderId) => selectedIdSet.has(orderId))
            const someGroupSelected = !allGroupSelected && groupOrderIds.some((orderId) => selectedIdSet.has(orderId))
            return (
              <tr
                key={`sku-group-${group.key}`}
                ref={rowVirtualizer.measureElement}
                data-index={index}
                className="sku-group-header"
              >
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
                    {/* Lockdown: virtualization preserves the existing SKU group select-all gate. */}
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
          }

          const { order } = entry
          return (
            <OrderRow
              key={order.orderId}
              order={order}
              detail={orderDetailsById.get(order.orderId) ?? null}
              visibleColumns={visibleColumns}
              isSelected={selectedIdSet.has(order.orderId)}
              isPanelOpen={panelOrderId === order.orderId}
              isKbFocus={kbRowId === order.orderId}
              isTransitioningShipped={entry.transitioning}
              openOrderDetails={openOrderDetails}
              openShipStationOrder={openShipStationOrder}
              setKbRowId={setKbRowId}
              renderCell={renderCell}
              cellStateEpoch={cellStateEpoch}
              virtualIndex={index}
              measureElement={rowVirtualizer.measureElement}
              stripeEven={(index + 1) % 2 === 0}
            />
          )
        }) : null}
        {virtualRowsEnabled && virtualPaddingBottom > 0 ? (
          <tr aria-hidden="true" className="virtual-table-spacer">
            <td colSpan={visibleColumns.length} style={{ height: virtualPaddingBottom, padding: 0, border: 0 }} />
          </tr>
        ) : null}
        {!virtualRowsEnabled && (skuSortActive ? skuOrderGroups.flatMap((group) => {
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

          const rows = group.orders.map((order) => (
            <OrderRow
              key={order.orderId}
              order={order}
              detail={orderDetailsById.get(order.orderId) ?? null}
              visibleColumns={visibleColumns}
              isSelected={selectedIdSet.has(order.orderId)}
              isPanelOpen={panelOrderId === order.orderId}
              isKbFocus={kbRowId === order.orderId}
              isTransitioningShipped={transitionalShippedIds.has(order.orderId)}
              openOrderDetails={openOrderDetails}
              openShipStationOrder={openShipStationOrder}
              setKbRowId={setKbRowId}
              renderCell={renderCell}
              cellStateEpoch={cellStateEpoch}
            />
          ))

          return [header, ...rows]
        }) : orderedFilteredOrders.map((order) => (
          <OrderRow
            key={order.orderId}
            order={order}
            detail={orderDetailsById.get(order.orderId) ?? null}
            visibleColumns={visibleColumns}
            isSelected={selectedIdSet.has(order.orderId)}
            isPanelOpen={panelOrderId === order.orderId}
            isKbFocus={kbRowId === order.orderId}
            // Only the sku-grouped rows carried the ps-shipping-row fade class
            // before the OrderRow extraction — the flat branch stays without it.
            isTransitioningShipped={false}
            openOrderDetails={openOrderDetails}
            openShipStationOrder={openShipStationOrder}
            setKbRowId={setKbRowId}
            renderCell={renderCell}
            cellStateEpoch={cellStateEpoch}
          />
        )))}
      </tbody>
    </table>
  )
}
