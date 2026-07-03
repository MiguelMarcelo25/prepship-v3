import { ShieldCheck } from 'lucide-react'
import type { BillingDetailDto } from './billing-parity'
import { BillingLineItemWarningSummary } from './BillingLineItemWarningSummary'

type BillingLineItemsHeaderProps = {
  clientName: string
  rows: BillingDetailDto[]
  loading: boolean
  isHugrabClient: boolean
  columnsAnchorRef: (instance: HTMLSpanElement | null) => void
  onClose: () => void
  onOpenWarningRow: (row: BillingDetailDto) => void
  onOpenHugrabBulk: () => void
}

export function BillingLineItemsHeader({
  clientName,
  rows,
  loading,
  isHugrabClient,
  columnsAnchorRef,
  onClose,
  onOpenWarningRow,
  onOpenHugrabBulk,
}: BillingLineItemsHeaderProps) {
  const zeroShippingReviewCount = rows.filter((row) => row.shippingZeroNeedsReview === true && row.feeWaiverDecision == null).length

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
      <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Line Items - {clientName}</h3>
      <button className="btn btn-ghost btn-xs" type="button" onClick={onClose}>x Close</button>
      <BillingLineItemWarningSummary rows={rows} onOpenWarningRow={onOpenWarningRow} />
      {zeroShippingReviewCount > 0 ? (
        <span
          role="status"
          title="Rows with a recorded $0.00 shipping cost awaiting a prep-fee decision (waive or keep). Use the amber Review button on the row."
          style={{
            fontSize: 10.5,
            fontWeight: 800,
            color: '#b45309',
            background: '#fef3c7',
            border: '1px solid #fde68a',
            borderRadius: 6,
            padding: '2px 8px',
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          {zeroShippingReviewCount} $0-shipping need review
        </span>
      ) : null}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
        {isHugrabClient ? (
          <button
            data-hugrab-shipping-floor-trigger
            className="btn btn-secondary btn-xs"
            type="button"
            disabled={loading}
            title="Preview/apply/revert HUGRAB bulk shipping changes"
            onClick={onOpenHugrabBulk}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            HUGRAB bulk
          </button>
        ) : null}
        <span ref={columnsAnchorRef} style={{ display: 'inline-flex' }} />
      </span>
    </div>
  )
}
