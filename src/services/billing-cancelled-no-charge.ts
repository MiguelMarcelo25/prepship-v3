import { sql, type SQL } from 'drizzle-orm';
import { REPLACEMENT_LINE_TYPES as REPLACEMENT_BILLING_LINE_TYPES } from './replacement-billing-planner.js';
// Per user override unlock shipped data on 2026-09-03 (PS-521): the return vocabulary is read
// from its one owner, a dependency-free leaf, instead of a private copy here. This file could
// not import billing-row-status.ts (that file imports isCancelledBillingStatus from here — a
// cycle), which is why it carried the copy in the first place.
import { billingReturnLineTypesSql, isBillingReturnLineType } from './billing-return-line-types';

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'upstream_cancelled']);
// PS-488 AC-4: both vocabularies. The portal writes return_postage /
// return_processing_fee into the same table; omitting them here would let a cancelled
// order strip a return charge it should have kept. Per user override unlock shipped data on
// 2026-09-03 (PS-521): the return spellings are the leaf's (isBillingReturnLineType), not a
// Set typed here — a spelling added to the owner is excluded here automatically.
/**
 * PS-502: a replacement is its own business event, exactly as a return is.
 *
 * A re-ship consumed real stock, a real package and real postage. Cancelling the original
 * order does not un-consume any of it, so the charge is not a no-charge row.
 *
 * What made the omission a defect rather than a policy choice: this predicate only zeroes the
 * READ MODEL. The persisted line stays `invoiced` and keeps its money, so a cancelled — or
 * merely `upstream_cancelled` — original made a delivered replacement show as $0 in every
 * summary while the client was still billed for it, with no credit note and no event. The two
 * halves disagreed silently.
 *
 * If the answer should be that the client does NOT pay, that is a money decision and it is
 * owed an audit trail: a credit through the AC-13 sibling reconciler, not an erasure in a
 * display query. Kept a SEPARATE set from the return vocabulary because a replacement is an
 * outbound re-ship and a return is inbound — folding them together would make every reader
 * asking "is this a return?" answer yes.
 */
const REPLACEMENT_LINE_TYPES = new Set(REPLACEMENT_BILLING_LINE_TYPES as readonly string[]);

/** The replacement vocabulary as a SQL `in (...)` list, from its owner (PS-521). */
function replacementLineTypesSql(): SQL {
  return sql`(${sql.join(REPLACEMENT_BILLING_LINE_TYPES.map((lineType) => sql`${lineType}`), sql`, `)})`;
}

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
  if (!normalized) return false;
  return isBillingReturnLineType(normalized) || REPLACEMENT_LINE_TYPES.has(normalized);
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
  // Per user override unlock shipped data on 2026-09-03 (PS-521): the excluded RETURN spellings
  // render from the vocabulary owner and the excluded REPLACEMENT spellings from theirs, instead
  // of the seven-string list that was typed here. `not in (returns) and not in (replacements)`
  // is the same predicate as one `not in` over both lists, for every value including NULL.
  return sql`(
    ${input.lineType} not in ${billingReturnLineTypesSql()}
    and ${input.lineType} not in ${replacementLineTypesSql()}
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
