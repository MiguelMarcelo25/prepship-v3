import { AlertTriangle } from 'lucide-react'
import type { BillingDetailDto } from './billing-parity'

export type BillingLineItemWarningSummaryCounts = {
  noBoxCost: number
  needsReview: number
}

type BillingLineItemWarningSummaryData = BillingLineItemWarningSummaryCounts & {
  noBoxCostRows: BillingDetailDto[]
  needsReviewRows: BillingDetailDto[]
}

function isTruthyFlag(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function billingBadges(row: BillingDetailDto): string[] {
  const raw = row.billingBadges ?? row.billing_badges
  return Array.isArray(raw)
    ? raw.filter((badge: unknown): badge is string => typeof badge === 'string')
    : []
}

export function hasBillingLineItemNeedsReview(row: BillingDetailDto) {
  return isTruthyFlag(row.packageCostNeedsReview) || isTruthyFlag(row.package_cost_needs_review)
}

export function hasBillingLineItemNoBoxCost(row: BillingDetailDto) {
  return (
    isTruthyFlag(row.boxCostAlert) ||
    isTruthyFlag(row.box_cost_alert) ||
    billingBadges(row).includes('NO_BOX_COST')
  )
}

export function summarizeBillingLineItemWarnings(rows: BillingDetailDto[]): BillingLineItemWarningSummaryData {
  const noBoxCostRows: BillingDetailDto[] = []
  const needsReviewRows: BillingDetailDto[] = []

  for (const row of rows) {
    if (hasBillingLineItemNeedsReview(row)) {
      needsReviewRows.push(row)
    } else if (hasBillingLineItemNoBoxCost(row)) {
      noBoxCostRows.push(row)
    }
  }

  return {
    noBoxCost: noBoxCostRows.length,
    needsReview: needsReviewRows.length,
    noBoxCostRows,
    needsReviewRows,
  }
}

function WarningPill({
  label,
  count,
  title,
  onClick,
}: {
  label: string
  count: number
  title: string
  onClick?: () => void
}) {
  const content = (
    <>
      <AlertTriangle size={13} aria-hidden="true" />
      <span>{label}</span>
      <strong>{count}</strong>
    </>
  )

  const className = [
    'inline-flex min-h-6 items-center gap-1 whitespace-nowrap rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5',
    'text-[11px] font-extrabold leading-none text-amber-700',
    onClick ? 'cursor-pointer hover:bg-amber-100' : '',
  ].join(' ')

  if (onClick) {
    return (
      <button type="button" className={className} title={title} onClick={onClick}>
        {content}
      </button>
    )
  }

  return (
    <span className={className} title={title}>
      {content}
    </span>
  )
}

export function BillingLineItemWarningSummary({
  rows,
  onOpenWarningRow,
}: {
  rows: BillingDetailDto[]
  onOpenWarningRow?: (row: BillingDetailDto) => void
}) {
  const summary = summarizeBillingLineItemWarnings(rows)

  if (summary.noBoxCost === 0 && summary.needsReview === 0) return null

  return (
    <div
      role="status"
      aria-label="Billing line item warnings"
      className="inline-flex items-center gap-1.5"
      data-billing-line-item-warning-summary
    >
      {summary.noBoxCost > 0 ? (
        <WarningPill
          label="No box cost"
          count={summary.noBoxCost}
          title="Rows where the backend marked the billed box cost as missing. Click to open the first matching line item."
          onClick={onOpenWarningRow ? () => onOpenWarningRow(summary.noBoxCostRows[0]!) : undefined}
        />
      ) : null}
      {summary.needsReview > 0 ? (
        <WarningPill
          label="Needs review"
          count={summary.needsReview}
          title="Rows where the backend marked the shipped box for review. Click to open the first matching line item."
          onClick={onOpenWarningRow ? () => onOpenWarningRow(summary.needsReviewRows[0]!) : undefined}
        />
      ) : null}
    </div>
  )
}
