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

// PS-308: the raw provider Rate Cost from the backend money tuple, SEPARATED from the
// customer-facing Best/Selected Rate. Financial-only — a null money tuple renders a dash.
export function renderRateCostCell(order: OrderSummaryDto) {
  const rateCost = getBackendRowMoney(order)?.rateCostAmount
  return rateCost != null
    ? <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatMoney(rateCost)}</span>
    : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
}

// PS-334: House Rate is the backend-owned internal/house amount for house-feature rows.
// Non-house rows and non-financial viewers get null from the backend money tuple, so this is
// display-only and never reconstructs cost from Best/Selected Rate.
export function renderHouseRateCell(order: OrderSummaryDto) {
  const houseRate = getBackendRowMoney(order)?.houseRateAmount
  return houseRate != null
    ? <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap', fontWeight: 600 }}>{formatMoney(houseRate)}</span>
    : <span style={{ color: 'var(--text3)', fontSize: 12 }}>-</span>
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
