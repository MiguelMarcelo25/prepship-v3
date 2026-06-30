// PS-166 / PS-306 (decomposition): OrdersRateCells — the PURE money/rate cell renderers
// extracted VERBATIM from OrdersView's renderTableCell. Each renders ONLY backend DTO data
// (getBackendRowMoney / getBackendRowMarketplace) through the canonical formatters, with NO
// component-state closure and NO recompute (PS-305 boundary) — so this is a thin, display-only
// presentation module the shell delegates to. Behavior-identical to the prior inline cells.
import { formatMoney, getBackendRowMoney, getBackendRowMarketplace, getBestRateFinalBaseCost } from './orders-row-display'
import type { OrderSummaryDto } from '../../types/api'

export function renderOrderTotalCell(order: OrderSummaryDto) {
  return <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{formatMoney(order.orderTotal ?? 0)}</span>
}

export function renderBestRateFinalCell(order: OrderSummaryDto) {
  const finalAmount = getBestRateFinalBaseCost(order)
  return finalAmount != null
    ? (
      <span
        data-best-rate-final="cached"
        title="Backend cached second-best rate from the saved all-carrier best-rate result"
        style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap', fontWeight: 700 }}
      >
        {formatMoney(finalAmount)}
      </span>
    )
    : <span data-best-rate-final="missing" style={{ color: 'var(--text3)', fontSize: 12 }}>-</span>
}

// PS-356: C. Shipping Rate is the customer billing amount from the backend money
// tuple. Best Rate is the separate DJR/DRP purchase cost.
export function renderRateCostCell(order: OrderSummaryDto) {
  const customerShippingRate = getBackendRowMoney(order)?.customerRateAmount
  return customerShippingRate != null
    ? <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatMoney(customerShippingRate)}</span>
    : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
}

// PS-239: backend-computed marketplace fee (canViewFinancials-redacted). Shows even pre-rating.
export function renderMarketplaceFeeCell(order: OrderSummaryDto) {
  const mp = getBackendRowMarketplace(order)
  return mp?.marketplaceFee != null
    ? <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatMoney(mp.marketplaceFee)}</span>
    : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
}

// PS-239: profit = subtotal − fee − best-rate-incl-markup. Dash until a rate exists; negative
// profit rendered in red, never clamped.
export function renderProfitCell(order: OrderSummaryDto) {
  const mp = getBackendRowMarketplace(order)
  if (mp?.profit == null) return <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
  return (
    <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: mp.profit < 0 ? 'var(--danger, #dc2626)' : 'var(--text1)' }}>
      {formatMoney(mp.profit)}
    </span>
  )
}
