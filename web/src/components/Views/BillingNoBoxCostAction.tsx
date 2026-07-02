import { AlertTriangle } from 'lucide-react'
import type { BillingDetailDto } from './billing-parity'

function billingBadges(row: BillingDetailDto): string[] {
  const raw = row.billingBadges ?? row.billing_badges
  return Array.isArray(raw)
    ? raw.filter((badge: unknown): badge is string => typeof badge === 'string')
    : []
}

export function hasBillingNoBoxCostAlert(row: BillingDetailDto): boolean {
  return row.boxCostAlert === true || row.box_cost_alert === true || billingBadges(row).includes('NO_BOX_COST')
}

export function BillingNoBoxCostAction({
  row,
  onOpenBillingEdit,
}: {
  row: BillingDetailDto
  onOpenBillingEdit: (row: BillingDetailDto) => void
}) {
  if (!hasBillingNoBoxCostAlert(row)) return null

  return (
    <button
      type="button"
      data-billing-badge="NO_BOX_COST"
      title="No box cost on this row - click to edit the Box Cost"
      onClick={(event) => {
        event.stopPropagation()
        onOpenBillingEdit(row)
      }}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[9px] font-bold leading-tight text-amber-700 hover:bg-amber-100"
    >
      <AlertTriangle size={10} strokeWidth={2.4} aria-hidden="true" />
      No box cost
    </button>
  )
}
