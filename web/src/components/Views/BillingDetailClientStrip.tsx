// PS-155: Billing detail client-selector strip extracted verbatim from BillingView.tsx
// (behavior-preserving). The summary rows carry phantom fields (grandTotal/total) not on the
// real BillingSummaryDto, so the index-signature BillingSummaryDto from ./billing-parity covers
// them. All money totals are parent-computed and read-only here; detailState + handleLoadDetails
// stay in BillingView.
import { formatBillingMoney, type BillingSummaryDto } from './billing-parity'

export function BillingDetailClientStrip({
  sortedSummaryRows,
  detailState,
  selectedDetailSummary,
  onLoadDetails,
}: {
  sortedSummaryRows: BillingSummaryDto[]
  detailState: { clientId: number | null }
  selectedDetailSummary: BillingSummaryDto | null
  onLoadDetails: (clientId: number, clientName: string | null | undefined) => void
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
