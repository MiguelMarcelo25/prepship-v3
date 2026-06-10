// @ts-nocheck
// PS-155: Billing detail client-selector strip extracted verbatim from BillingView.tsx
// (behavior-preserving). @ts-nocheck matches the rest of the billing module — the summary rows
// carry phantom fields (grandTotal/total) not on the real BillingSummaryDto. All money totals
// are parent-computed and read-only here; detailState + handleLoadDetails stay in BillingView.
import { formatBillingMoney } from './billing-parity'

export function BillingDetailClientStrip({
  sortedSummaryRows,
  detailState,
  selectedDetailSummary,
  onLoadDetails,
}) {
  return (
    <div className="billing-detail-client-strip" aria-label="Line item client selector">
      <span className="billing-detail-client-strip-label">
        {sortedSummaryRows.length} visible clients
        {selectedDetailSummary ? ` · showing ${Number(selectedDetailSummary.orderCount ?? 0)} orders` : ''}
      </span>
      {sortedSummaryRows.map((row) => {
        const active = Number(row.clientId) === Number(detailState.clientId)
        const orderCount = Number(row.orderCount ?? 0)
        const rowTotal = Number(row.fulfillmentFeeTotal ?? row.grandTotal ?? row.total ?? 0)
        return (
          <button
            key={row.clientId}
            className={`billing-detail-toggle${active ? ' active' : ''}${orderCount === 0 && rowTotal === 0 ? ' is-empty' : ''}`}
            type="button"
            aria-pressed={active}
            onClick={() => void onLoadDetails(row.clientId, row.clientName)}
          >
            <span>{row.clientName}</span>
            <span className="billing-detail-toggle-meta">{orderCount} orders</span>
            <span className="billing-detail-toggle-total">{formatBillingMoney(rowTotal)}</span>
          </button>
        )
      })}
    </div>
  )
}
