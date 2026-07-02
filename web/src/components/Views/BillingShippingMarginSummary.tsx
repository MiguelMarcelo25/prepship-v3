import { formatBillingMoney } from './billing-parity'

export type BillingShippingMarginSummaryDto = {
  rowCount: number
  marginRowCount: number
  frozenCount: number
  projectedCount: number
  missingBillableCount: number
  missingActualCostCount: number
  missingAnyProofCount: number
  actualShippingTotal: number
  billableShippingTotal: number
  marginTotal: number
  marginPct: number | null
}

interface BillingShippingMarginSummaryProps {
  summary: BillingShippingMarginSummaryDto
  loading: boolean
  error: string | null
}

export function billingMarginColor(value: number) {
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

export function BillingShippingMarginSummary({
  summary,
  loading,
  error,
}: BillingShippingMarginSummaryProps) {
  const cards = [
    ['Actual shipping', formatBillingMoney(summary.actualShippingTotal, { dashIfZero: true })],
    ['Billable shipping', formatBillingMoney(summary.billableShippingTotal, { dashIfZero: true })],
    ['Margin', formatBillingMoney(summary.marginTotal, { dashIfZero: true })],
    ['Margin %', summary.marginPct == null ? '-' : `${summary.marginPct.toFixed(2)}%`],
    ['Rows', `${summary.marginRowCount}/${summary.rowCount}`],
    ['State', `${summary.frozenCount} frozen / ${summary.projectedCount} projected`],
  ] as const

  return (
    <>
      <div
        aria-label="Shipping margin analytics"
        className="grid gap-2.5 my-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
      >
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-surface-2 px-3 py-2.5 min-w-0">
            <div className="text-[10.5px] text-ink-3 truncate">{label}</div>
            <div
              className="text-[15px] font-bold tabular-nums truncate"
              style={label === 'Margin' ? { color: billingMarginColor(summary.marginTotal) } : undefined}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
      {(loading || error || summary.missingAnyProofCount > 0) ? (
        <div className="text-[11px] mb-3" style={{ color: error ? 'var(--red)' : 'var(--text3)' }}>
          {loading
            ? 'Loading shipping margin...'
            : error
              ? error
              : `${summary.missingAnyProofCount} shipment(s) missing proof (${summary.missingBillableCount} billable, ${summary.missingActualCostCount} actual)`}
        </div>
      ) : null}
    </>
  )
}
