// PS-166 (Wave 2c1): the two leaf cell renderers — the Order # cell and the
// generic diagnostic cell — extracted from OrdersView.tsx with BYTE-IDENTICAL
// markup. The Order # cell carries DOM the e2e suites pin
// (data-testid="off-tab-status-pill", .od-order-link, .ps-shipping-pill, the
// TEST badge); none of it changed. Render-only: OrdersView keeps all state and
// passes the row + an explicit context object (the closure deps the inline
// function used to capture), so behavior is identical and nothing here owns
// component state.
//
// The giant column-switch renderTableCell stays in OrdersView (W2c2);
// it calls these with the same context.
import { Truck } from 'lucide-react'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import { isTestOrder } from './orders-items'
import { copyText } from './orders-display-state'

export type OrderNumberCellContext = {
  orderDetailsById: Map<number, OrderFullDto>
  transitionalShippedIds: Set<number>
  isGlobalSearchActive: boolean
  currentStatus: string
  openDetailDrawer: (orderId: number | null) => void
}

export function renderOrderCell(order: OrderSummaryDto, ctx: OrderNumberCellContext) {
  const { orderDetailsById, transitionalShippedIds, isGlobalSearchActive, currentStatus, openDetailDrawer } = ctx
  const testOrder = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
  const isShipping = transitionalShippedIds.has(order.orderId)
  // PS-210: global search mixes lifecycle statuses into one table. A row
  // whose REAL status differs from the active tab gets an explicit status
  // pill so a Shipped/Cancelled match on the Awaiting tab can never be
  // mistaken for an awaiting order. Display-only — every mutation stays
  // gated by the row's actual orderStatus at the backend
  // (assertOrderEditable rejects shipped/cancelled writes).
  const offTabStatus =
    isGlobalSearchActive && order.orderStatus && order.orderStatus !== currentStatus
      ? order.orderStatus
      : null
  const offTabStatusStyle =
    offTabStatus === 'shipped'
      ? { color: '#fff', background: '#059669' }
      : offTabStatus === 'cancelled'
        ? { color: '#fff', background: '#6b7280' }
        : { color: '#fff', background: '#2563eb' }
  return (
    <div className="order-num" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, minWidth: 0 }}>
      {offTabStatus && (
        <span
          title={`This order's actual status is ${offTabStatus.replace(/_/g, ' ')} — it appears here because search looks across all statuses`}
          data-testid="off-tab-status-pill"
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.5,
            borderRadius: 3,
            flexShrink: 0,
            textTransform: 'uppercase',
            ...offTabStatusStyle,
          }}
        >
          {offTabStatus === 'awaiting_shipment' ? 'AWAITING' : offTabStatus.replace(/_/g, ' ')}
        </span>
      )}
      {testOrder && (
        <span
          title="Sandbox / test order — no real postage, billing, or inventory impact"
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: '#fff',
            background: '#d97706',
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          TEST
        </span>
      )}
      {/* Shipping-in-progress pill — only renders during the 30 s
        fade transition (Create + Print Label flow). Animated truck
        icon + pulsing background give the operator a clear,
        persistent signal that the order is in flight to Shipped.
        See .ps-shipping-pill in app-shell.css for the styles. */}
      {isShipping && (
        <span className="ps-shipping-pill" title="Order is being shipped — will move to Shipped in 30 seconds">
          <Truck size={9} strokeWidth={2.5} />
          Shipping…
        </span>
      )}
      <span
        className="od-order-link"
        title="Open order detail"
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', color: 'var(--ss-blue)' }}
        onClick={(event) => {
          event.stopPropagation()
          openDetailDrawer(order.orderId ?? null)
        }}
      >
        {order.orderNumber ?? `#${order.orderId}`}
      </span>
      <span
        title="Copy"
        style={{ cursor: 'pointer', color: 'var(--text4)', fontSize: 9, opacity: 0.6, transition: 'opacity .1s', flexShrink: 0 }}
        onClick={(event) => {
          event.stopPropagation()
          copyText(order.orderNumber ?? String(order.orderId))
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.opacity = '1'
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.opacity = '0.6'
        }}
      >
        ⎘
      </span>
    </div>
  )
}

export function renderDiagnosticCell(
  value: unknown,
  options: {
    fontSize?: number
    maxWidth?: number
    title?: string
    align?: 'left' | 'center'
    monospace?: boolean
    muted?: boolean
    surface?: boolean
  } = {},
) {
  const display = value == null || value === '' ? '—' : String(value)
  const surface = options.surface ?? !options.muted

  return (
    <span
      style={{
        display: 'block',
        fontSize: options.fontSize ?? 14,
        textAlign: options.align ?? 'left',
        fontFamily: options.monospace ? 'monospace' : undefined,
        color: options.muted ? 'var(--text3)' : 'var(--text2)',
        background: surface ? 'var(--surface2)' : undefined,
        padding: surface ? '4px 6px' : undefined,
        borderRadius: surface ? 3 : undefined,
        maxWidth: options.maxWidth,
        overflow: options.maxWidth ? 'hidden' : undefined,
        textOverflow: options.maxWidth ? 'ellipsis' : undefined,
        whiteSpace: options.maxWidth ? 'nowrap' : undefined,
      }}
      title={options.title ?? display}
    >
      {display}
    </span>
  )
}
