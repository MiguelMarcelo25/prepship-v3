import { sql, type SQL } from 'drizzle-orm';

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'upstream_cancelled']);
// PS-488 AC-4: both vocabularies. The portal writes return_postage /
// return_processing_fee into the same table; omitting them here would let a cancelled
// order strip a return charge it should have kept.
const RETURN_LINE_TYPES = new Set([
  'return',
  'return_label',
  'return_processing',
  'return_postage',
  'return_processing_fee',
]);

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function isCancelledBillingStatus(value: unknown): boolean {
  const normalized = normalizedText(value);
  return normalized ? CANCELLED_STATUSES.has(normalized) : false;
}

export function isCancelledNoChargeExcludedLineType(value: unknown): boolean {
  const normalized = normalizedText(value);
  return normalized ? RETURN_LINE_TYPES.has(normalized) : false;
}

export function isCancelledNoChargeBillingRow(input: {
  lineType?: unknown;
  orderStatus?: unknown;
  effectiveOrderStatus?: unknown;
  orderLifecycleStatus?: unknown;
  billingLifecycleStatus?: unknown;
  billingZeroReason?: unknown;
  billingStatusBadge?: unknown;
  fulfillmentConflictCode?: unknown;
}): boolean {
  if (isCancelledNoChargeExcludedLineType(input.lineType)) return false;
  if (normalizedText(input.fulfillmentConflictCode)) return false;
  if (normalizedText(input.billingLifecycleStatus) === 'cancelled_no_charge') return true;
  if (normalizedText(input.billingZeroReason) === 'cancelled') return true;
  if (normalizedText(input.billingStatusBadge) === 'cancelled') return true;
  return (
    isCancelledBillingStatus(input.orderStatus) ||
    isCancelledBillingStatus(input.effectiveOrderStatus) ||
    isCancelledBillingStatus(input.orderLifecycleStatus)
  );
}

export function cancelledNoChargeBillingLinePredicateSql(input: {
  lineType: SQL;
  orderStatus: SQL;
  canonicalStatus: SQL;
}): SQL {
  // Per user override unlock shipped data on 2026-07-06: cancelled/canceled
  // Billing lines are read-model no-charge rows. Return line types are excluded
  // so return fees/credits remain independently billable.
  return sql`(
    ${input.lineType} not in ('return', 'return_label', 'return_processing', 'return_postage', 'return_processing_fee')
    and (
      lower(coalesce(${input.orderStatus}, '')) in ('cancelled', 'canceled')
      or lower(coalesce(${input.canonicalStatus}, '')) in ('cancelled', 'canceled')
    )
  )`;
}

export function cancelledNoChargeBillingAmountSql(input: {
  lineType: SQL;
  orderStatus: SQL;
  canonicalStatus: SQL;
  totalCost: SQL;
}): SQL {
  return sql`case
    when ${cancelledNoChargeBillingLinePredicateSql(input)} then 0
    else coalesce(${input.totalCost}, 0)
  end`;
}
