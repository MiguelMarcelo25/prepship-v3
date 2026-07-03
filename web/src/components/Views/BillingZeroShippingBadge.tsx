// PS-376 — the $0-shipping review badge. THIN consumer: it renders the
// backend-owned classification verbatim (shippingZeroNeedsReview + the reason /
// label / severity that billing-shipping-policy.decideZeroShippingReview stamps).
// It does NO policy math of its own — which row is a $0-shipping review row, and
// WHY, is decided by the backend. Shown in the Billing detail Shipping cell so
// every $0 shipping line is obviously flagged before invoicing.
import type { BillingDetailDto } from './billing-parity'

// Compact tag per reason (the full sentence rides in the title/tooltip so the
// narrow Shipping column stays readable).
const SHORT_BY_REASON: Record<string, string> = {
  cancelled_or_not_shipped: 'CANCELLED',
  bundled_with_order: 'BUNDLED',
  missing_shipping_proof: 'NO PROOF',
  zero_shipping_unknown: '$0 REVIEW',
}

export function hasBillingZeroShippingReview(row: BillingDetailDto): boolean {
  return row.shippingZeroNeedsReview === true || row.shipping_zero_needs_review === true
}

export function BillingZeroShippingBadge({ row }: { row: BillingDetailDto }) {
  if (!hasBillingZeroShippingReview(row)) return null

  const reason = String(row.zeroShippingReviewReason ?? row.zero_shipping_review_reason ?? 'zero_shipping_unknown')
  const label = String(row.zeroShippingReviewLabel ?? row.zero_shipping_review_label ?? '$0 shipping — review')
  const severity = String(row.zeroShippingReviewSeverity ?? row.zero_shipping_review_severity ?? 'warn')
  const short = SHORT_BY_REASON[reason] ?? '$0 REVIEW'
  // 'info' (bundled — prep fee likely valid) reads calmer than the amber
  // prep-fee-risk cases (cancelled / missing proof / unknown).
  const info = severity === 'info'

  return (
    <span
      data-billing-badge="ZERO_SHIPPING_REVIEW"
      data-zero-shipping-reason={reason}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 8.5,
        fontWeight: 700,
        borderRadius: 4,
        padding: '0 3px',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        color: info ? '#0369a1' : '#b45309',
        background: info ? '#e0f2fe' : '#fef3c7',
        border: `1px solid ${info ? '#bae6fd' : '#fde68a'}`,
      }}
    >
      {short}
    </span>
  )
}
