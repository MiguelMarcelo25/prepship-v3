// PS-257: type-checked. The W2c2 diagnostic-column renderer reads loose DTO
// rate records (order.bestRate is unknown-typed on OrderSummaryDto) via explicit
// record casts, following the documented sibling precedent (orders-display-state.ts,
// orders-row-display.tsx). The leaf renderers below are trivially correct; the
// renderOrderCell context type stays as in-file documentation.
//
// PS-166 (Wave 2c1): the two leaf cell renderers — the Order # cell and the
// generic diagnostic cell — extracted from OrdersView.tsx with BYTE-IDENTICAL
// markup. The Order # cell carries DOM the e2e suites pin
// (data-testid="off-tab-status-pill", .od-order-link, .ps-shipping-pill, the
// TEST badge); none of it changed. Render-only: OrdersView keeps all state and
// passes the row + an explicit context object (the closure deps the inline
// function used to capture), so behavior is identical and nothing here owns
// component state.
//
// PS-166 (Wave 2c2): the 7 test_* DIAGNOSTIC column cells — fully pure on
// (order, column) + pure display helpers + renderDiagnosticCell, ZERO
// component state — moved here as renderDiagnosticColumnCell. The
// component-coupled dispatcher renderTableCell + its 4 sibling cell renderers
// (carrier/account/best-rate/margin) stay in the OrdersView shell, which is
// their natural home (an 18-field context blob incl. render-callbacks would be
// higher-risk + architecturally worse — see the PS-166 plan W2c note).
import { Truck } from 'lucide-react'
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import type { TableColumn } from './orders-table-columns'
import { isTestOrder } from './orders-items'
import {
  copyText,
  getCancelledDisplayAccountNickname,
  getCancelledDisplayCarrierCode,
  getCancelledDisplayProviderId,
  getCancelledDisplayServiceCode,
  getShippedDisplayAccountNickname,
  getShippedDisplayCarrierCode,
  getShippedDisplayProviderId,
  getShippedDisplayServiceCode,
  shouldShowCarrierExtLabel,
} from './orders-display-state'
import {
  getAwaitingDisplayAccountNickname,
  getLegacyClientIdForDisplay,
  toProviderAccountId,
  toRecord,
  toStringValue,
} from './orders-row-display'

export type OrderNumberCellContext = {
  orderDetailsById: Map<number, OrderFullDto>
  transitionalShippedIds: Set<number>
  isGlobalSearchActive: boolean
  currentStatus: string
  openDetailDrawer: (orderId: number | null) => void
}

const RETURN_STATUS_LABELS: Record<string, string> = {
  requested: 'Return requested',
  label_created: 'Return label ready',
  label_failed: 'Return needs attention',
  in_transit: 'Return in transit',
  received: 'Return received',
  inspected: 'Return inspected',
  closed: 'Return closed',
  cancelled: 'Return cancelled',
}

export function renderOrderCell(order: OrderSummaryDto, ctx: OrderNumberCellContext) {
  const { orderDetailsById, transitionalShippedIds, isGlobalSearchActive, currentStatus, openDetailDrawer } = ctx
  const testOrder = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
  const isShipping = transitionalShippedIds.has(order.orderId)
  const fulfillmentConflict = toRecord(order.fulfillmentConflict)
  const fulfillmentConflictLabel = toStringValue(fulfillmentConflict?.label)
  const fulfillmentConflictReason = toStringValue(fulfillmentConflict?.reason)
  // Per user override `unlock shipped data` on 2026-07-16: only the distinct
  // read-only return display row receives return styling. The original shipped
  // row remains visually and operationally unchanged; mutation locks stay on.
  const isReturnRow = order.displayRowKind === 'return'
  const returnSummary = order.orderStatus === 'shipped' && isReturnRow ? order.returnSummary : null
  const returnRate = typeof returnSummary?.returnCustomerShippingRate === 'number'
    && Number.isFinite(returnSummary.returnCustomerShippingRate)
    ? returnSummary.returnCustomerShippingRate
    : null
  const returnStatusLabel = returnSummary
    ? RETURN_STATUS_LABELS[returnSummary.status] ?? 'Return'
    : null
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
      {fulfillmentConflictLabel && (
        <span
          title={fulfillmentConflictReason ?? fulfillmentConflictLabel}
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: 0,
            color: 'var(--yellow)',
            background: 'var(--yellow-bg)',
            border: '1px solid var(--yellow)',
            borderRadius: 3,
            flexShrink: 0,
            textTransform: 'uppercase',
          }}
        >
          Conflict
        </span>
      )}
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
          <span
            className="od-order-link"
            title="Open order detail"
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: 'pointer',
              color: isReturnRow ? 'var(--red)' : 'var(--ss-blue)',
              fontWeight: isReturnRow ? 800 : undefined,
            }}
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
        </span>
        {returnSummary && (
          <span
            title={`${returnStatusLabel}${returnSummary.returnReference ? ` · ${returnSummary.returnReference}` : ''}${returnRate != null ? ` · $${returnRate.toFixed(2)}` : ''}`}
            style={{
              color: 'var(--red)',
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1.15,
              whiteSpace: 'nowrap',
            }}
          >
            Return{returnRate != null ? ` · $${returnRate.toFixed(2)}` : ''}
          </span>
        )}
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

// PS-166 (Wave 2c2): the 7 test_* DIAGNOSTIC column cells, moved VERBATIM out
// of renderTableCell's switch. Pure on (order, column) — the three diagnostic
// flags are computed internally from order.orderStatus + the canonical
// shouldShowCarrierExtLabel (identical to the inline derivations they
// replaced), and every value resolver is a pure display helper. No component
// state. renderTableCell delegates all 7 test_* cases here.
export function renderDiagnosticColumnCell(order: OrderSummaryDto, column: TableColumn) {
  const diagnosticIsShipped = order.orderStatus !== 'awaiting_shipment'
  const diagnosticIsCancelled = order.orderStatus === 'cancelled'
  const diagnosticIsExternalLabel = shouldShowCarrierExtLabel(order)

  switch (column.key) {
    case 'test_carrierCode': {
      if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null, { monospace: true })
      const value = diagnosticIsShipped
        ? diagnosticIsCancelled
          ? getCancelledDisplayCarrierCode(order)
          : getShippedDisplayCarrierCode(order)
        : order.bestRate
          ? toStringValue((order.bestRate as Record<string, unknown> | null | undefined)?.carrierCode)
          : null
      return renderDiagnosticCell(value, { monospace: true })
    }
    case 'test_shippingProviderID': {
      if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null, { monospace: true })
      const value = diagnosticIsShipped
        ? diagnosticIsCancelled
          ? getCancelledDisplayProviderId(order)
          : getShippedDisplayProviderId(order)
        : toProviderAccountId((order.bestRate as Record<string, unknown> | null | undefined)?.shippingProviderId)
      return renderDiagnosticCell(value, { monospace: true })
    }
    case 'test_clientID':
      return renderDiagnosticCell(getLegacyClientIdForDisplay(order), { monospace: true })
    case 'test_serviceCode': {
      if (diagnosticIsExternalLabel && !diagnosticIsCancelled) {
        return renderDiagnosticCell(null, {
          fontSize: 10,
          maxWidth: column.width,
          monospace: true,
        })
      }
      const value = diagnosticIsShipped
        ? diagnosticIsCancelled
          ? getCancelledDisplayServiceCode(order)
          : getShippedDisplayServiceCode(order)
        : toStringValue((order.bestRate as Record<string, unknown> | null | undefined)?.serviceCode)
      return renderDiagnosticCell(value, {
        fontSize: 10,
        maxWidth: column.width,
        monospace: true,
      })
    }
    case 'test_bestRate': {
      if (diagnosticIsExternalLabel) return renderDiagnosticCell(null, { fontSize: 10, muted: true, surface: false })
      const bestRate = order.bestRate
      if (!bestRate) return renderDiagnosticCell(null, { fontSize: 10, muted: true, surface: false })

      const rateRecord = toRecord(bestRate) ?? {}
      const shipmentCost = typeof rateRecord.shipmentCost === 'number' ? rateRecord.shipmentCost : 0
      const otherCost = typeof rateRecord.otherCost === 'number' ? rateRecord.otherCost : 0
      const amount = shipmentCost + otherCost
      const carrierCode = toStringValue(rateRecord.carrierCode) ?? '?'
      const serviceCode = toStringValue(rateRecord.serviceCode) ?? '?'
      const display = `${carrierCode}|${serviceCode}|$${amount.toFixed(2)}`

      return renderDiagnosticCell(display, {
        fontSize: 9,
        maxWidth: column.width,
        monospace: true,
        title: JSON.stringify(bestRate),
      })
    }
    case 'test_orderLocal': {
      if (diagnosticIsExternalLabel) {
        return renderDiagnosticCell(null, {
          fontSize: 9,
          maxWidth: column.width,
        })
      }
      const parts: string[] = []
      if (order.weight?.value && order.weight.value > 0) {
        parts.push(`w:${order.weight.value}${order.weight.units?.[0] || 'oz'}`)
      }
      if (order.label?.trackingNumber) parts.push('track:yes')
      if (order.bestRate) parts.push('best:yes')

      const display = parts.length ? parts.join(' ') : null
      return renderDiagnosticCell(display, {
        fontSize: 9,
        maxWidth: column.width,
        title: display ?? '—',
      })
    }
    case 'test_shippingAccount': {
      if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null)
      const value = diagnosticIsShipped
        ? diagnosticIsCancelled
          ? getCancelledDisplayAccountNickname(order)
          : getShippedDisplayAccountNickname(order)
        : getAwaitingDisplayAccountNickname(order)
      return renderDiagnosticCell(value)
    }
    default:
      return null
  }
}
