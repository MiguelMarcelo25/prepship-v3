// PS-155: Billing detail client-selector strip extracted verbatim from BillingView.tsx
// (behavior-preserving). The summary rows carry phantom fields (grandTotal/total) not on the
// real BillingSummaryDto, so the index-signature BillingSummaryDto from ./billing-parity covers
// them. All money totals are parent-computed and read-only here; detailState + handleLoadDetails
// stay in BillingView.
import { resolveBillingRowGrandTotal } from '../../lib/billing-row-total'
import { formatBillingMoney, type BillingSummaryDto } from './billing-parity'
import { getClientPalette } from './orders-formatting'

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
        const rowTotalResult = resolveBillingRowGrandTotal(row)
        const rowTotal = rowTotalResult.ok ? rowTotalResult.total : null
        // Designated per-store color dot (same hash-based palette as the Awaiting/Orders view).
        const palette = getClientPalette(row.clientName ?? 'Untagged')
        return (
          <button
            key={row.clientId}
            className={`billing-detail-toggle${active ? ' active' : ''}${orderCount === 0 && rowTotal === 0 ? ' is-empty' : ''}`}
            type="button"
            aria-pressed={active}
            onClick={() => void onLoadDetails(row.clientId, row.clientName)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: palette.color, flexShrink: 0 }} />
              {row.clientName}
            </span>
            <span className="billing-detail-toggle-meta">{orderCount} orders</span>
            <span className="billing-detail-toggle-total">{formatBillingMoney(rowTotal)}</span>
          </button>
        )
      })}
    </div>
  )
}
