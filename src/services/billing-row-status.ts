import { sql, type SQL } from 'drizzle-orm';
import { REPLACEMENT_LINE_TYPES } from './replacement-billing-planner.js';

import { isCancelledBillingStatus } from './billing-cancelled-no-charge';

export type BillingLifecycleStatus =
  | 'fulfilled'
  | 'fulfillment_conflict'
  | 'cancelled_no_charge'
  | 'cancelled_billable'
  | 'return'
  | 'return_label'
  | 'return_processing'
  | 'return_postage'
  | 'return_processing_fee'
  | 'needs_review'
  | 'manual_adjustment'
  | 'waived';

export type BillingStatusTone = 'neutral' | 'red' | 'purple' | 'amber' | 'blue';
export type BillingZeroReason =
  | 'cancelled'
  | 'waived'
  | 'bundled'
  | 'missing_cost'
  | 'manual_override'
  | 'fulfillment_conflict'
  | null;

export type BillingRowStatusInput = {
  lineType?: string | null;
  lineTypes?: readonly unknown[] | null;
  orderStatus?: string | null;
  orderLifecycleStatus?: string | null;
  effectiveOrderStatus?: string | null;
  totalCost?: unknown;
  feeWaived?: boolean | null;
  packageCostNeedsReview?: boolean | null;
  shippingZeroNeedsReview?: boolean | null;
  fulfillmentConflictCode?: string | null;
  manualBillingOverrideLabels?: readonly unknown[] | null;
  relatedOrderId?: number | string | null;
  returnId?: number | string | null;
};

export type BillingRowStatusResult = {
  billingLifecycleStatus: BillingLifecycleStatus;
  billingStatusLabel: string;
  billingStatusTone: BillingStatusTone;
  billingZeroReason: BillingZeroReason;
  billingStatusBadge: string | null;
  relatedOrderId?: number | string | null;
  returnId?: number | string | null;
};

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizedLineTypes(input: BillingRowStatusInput): string[] {
  const values = [
    input.lineType,
    ...(Array.isArray(input.lineTypes) ? input.lineTypes : []),
  ];
  return values
    .map((value) => normalizedText(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value));
}

/**
 * PS-488 AC-4: recognise the CANONICAL Client Portal line types alongside PrepShip's
 * historical ones. Both applications write to one billing_line_items table; the portal
 * emits return_postage / return_processing_fee, PrepShip historically emitted
 * return_label / return_processing. A classifier that knows only one vocabulary silently
 * drops the other side's return rows out of every return-aware branch — which is how
 * return charges disappear from a projection rather than erroring.
 *
 * Both are accepted rather than one being migrated: historical rows carry the old names
 * and rewriting frozen billing rows is forbidden.
 */
/**
 * PS-501: the vocabulary itself, exported so SQL and TypeScript cannot drift.
 *
 * The summary's return bucket has to sum exactly the line types this predicate accepts.
 * Re-listing them in a SQL `case` would create a second owner of the same fact, and the
 * failure mode is silent — a spelling present here and missing there drops return money
 * out of the bucket while leaving it in grandTotal, so the row simply stops reconciling.
 */
export const BILLING_RETURN_LINE_TYPES = [
  'return',
  'return_label',
  'return_processing',
  'return_postage',
  'return_processing_fee',
] as const;

export function isBillingReturnLineType(lineType: unknown): boolean {
  const value = normalizedText(lineType)?.toLowerCase();
  return value != null && (BILLING_RETURN_LINE_TYPES as readonly string[]).includes(value);
}

/**
 * The same vocabulary as a SQL `in (...)` list, for the return buckets.
 *
 * Lives beside the predicate on purpose. Two callers need this list in SQL — the live
 * billing summary and the cached billing_summary_metrics upsert — and a hand-written
 * `case` in either would be a second owner of the vocabulary. When those disagree the
 * failure is silent: the missing spelling's money stays inside grand_total but lands in no
 * bucket, so the row simply stops reconciling and nothing errors.
 */
export function billingReturnLineTypesSql(): SQL {
  return sql`(${sql.join(
    BILLING_RETURN_LINE_TYPES.map((lineType) => sql`${lineType}`),
    sql`, `,
  )})`;
}

/**
 * PS-502 AC-18 — the replacement line types, in SQL, from the ONE place that names them.
 *
 * Same reasoning as the return owner directly above, and the same failure if it is copied:
 * two callers need this list in SQL (the live billing summary and the cached
 * billing_summary_metrics upsert), and a hand-written `case` in either becomes a second
 * owner of the vocabulary. When they disagree nothing errors — the missing spelling's money
 * simply stays inside grand_total and lands in no bucket.
 *
 * Sourced from REPLACEMENT_LINE_TYPES rather than re-spelling it, because that const is
 * already what the planner, the writer and the outbound sweep agree on. A replacement
 * vocabulary is kept SEPARATE from the return vocabulary: a replacement is an outbound
 * re-ship and a return is inbound, so a shared list would make every reader asking "is this
 * a return?" answer yes.
 */
export function billingReplacementLineTypesSql(): SQL {
  return sql`(${sql.join(
    REPLACEMENT_LINE_TYPES.map((lineType) => sql`${lineType}`),
    sql`, `,
  )})`;
}

/**
 * PS-488 M3 — which BUCKET a return line belongs to, by canonical and legacy spelling.
 *
 * Exported from the shared owner because three places need the same answer and had been
 * spelling the list out separately: the DTO's metrics, the invoice aggregate's SQL CASE
 * arms, and the presence tracking added for absent-versus-zero. A fourth private copy of
 * this list is exactly how return_processing_fee came to be missing from one in the first
 * place.
 */
export function isBillingReturnPostageLineType(lineType: unknown): boolean {
  const value = normalizedText(lineType)?.toLowerCase();
  return value === 'return_postage' || value === 'return_label';
}

export function isBillingReturnProcessingLineType(lineType: unknown): boolean {
  const value = normalizedText(lineType)?.toLowerCase();
  return value === 'return_processing_fee' || value === 'return_processing';
}

function result(
  status: BillingLifecycleStatus,
  label: string,
  tone: BillingStatusTone,
  zeroReason: BillingZeroReason,
  badge: string | null,
  input: BillingRowStatusInput,
): BillingRowStatusResult {
  return {
    billingLifecycleStatus: status,
    billingStatusLabel: label,
    billingStatusTone: tone,
    billingZeroReason: zeroReason,
    billingStatusBadge: badge,
    ...(input.relatedOrderId != null ? { relatedOrderId: input.relatedOrderId } : {}),
    ...(input.returnId != null ? { returnId: input.returnId } : {}),
  };
}

/**
 * PS-488 M3 — the ONE status an aggregated Return row carries.
 *
 * resolveBillingRowStatus below answers for a LINE. A return event's postage line resolves
 * to 'return_postage' and its processing line to 'return_processing_fee', so an aggregate
 * built by collapsing them inherited whichever component happened to initialise the row.
 * Two returns with identical charges could then show different statuses depending on the
 * order their lines arrived in, and one return could change status between fetches.
 *
 * An aggregate is not a line, so it does not get a line's answer. A Return row IS a
 * return: one stable status, independent of which components exist and of their order.
 * The per-component detail is not lost — it lives in returnPostageTotal /
 * returnProcessingTotal and their presence flags, which is where a caller that needs to
 * know what a return was actually charged for should look.
 */
export function resolveBillingReturnRowStatus(input: BillingRowStatusInput): BillingRowStatusResult {
  return result('return', 'Return', 'purple', null, null, input);
}

export function resolveBillingRowStatus(input: BillingRowStatusInput): BillingRowStatusResult {
  const lineTypes = normalizedLineTypes(input);
  const hasLine = (lineType: string) => lineTypes.includes(lineType);

  // PS-488 M3 — the CANONICAL return types get the same precedence as the legacy three.
  //
  // These are the names the generator actually writes (RETURN_SHIPPING_LINE_TYPE and
  // RETURN_PROCESSING_LINE_TYPE in billing-return-event-contract.ts). Both were already
  // declared in the BillingLifecycleStatus union but had no branch here, so every
  // canonical return row fell past cancellation and conflict handling to the
  // 'fulfilled' terminal below — a return charge on a cancelled outbound order was
  // labelled by the ORDER's state instead of its own. A Return attached to a cancelled
  // order is still a Return, and its persisted return money is its own.
  //
  // Placed above billing_adjustment / conflict / cancelled deliberately: the precedence
  // IS the fix, not merely the presence of a branch.
  if (hasLine('return_postage')) {
    return result('return_postage', 'Return postage', 'purple', null, null, input);
  }
  if (hasLine('return_processing_fee')) {
    return result('return_processing_fee', 'Return processing fee', 'purple', null, null, input);
  }
  if (hasLine('return_processing')) {
    return result('return_processing', 'Return processing', 'purple', null, null, input);
  }
  if (hasLine('return_label')) {
    return result('return_label', 'Return label', 'purple', null, null, input);
  }
  if (hasLine('return')) {
    return result('return', 'Return', 'purple', null, null, input);
  }
  if (hasLine('billing_adjustment')) {
    const isCredit = Number(input.totalCost) < 0;
    return result(
      'manual_adjustment',
      isCredit ? 'Credit adjustment' : 'Debit adjustment',
      'blue',
      'manual_override',
      isCredit ? 'CREDIT' : 'DEBIT',
      input,
    );
  }

  const orderStatus =
    normalizedText(input.orderStatus)?.toLowerCase() ??
    normalizedText(input.effectiveOrderStatus)?.toLowerCase();
  const orderLifecycleStatus = normalizedText(input.orderLifecycleStatus)?.toLowerCase();
  if (normalizedText(input.fulfillmentConflictCode)) {
    return result('fulfillment_conflict', 'Fulfillment conflict', 'amber', 'fulfillment_conflict', 'REVIEW', input);
  }
  const cancelledLine = hasLine('cancelled');
  const cancelledLifecycle = isCancelledBillingStatus(orderLifecycleStatus);
  // Per user override unlock shipped data on 2026-07-06: PS-396 makes every
  // cancelled/canceled Billing fulfillment row a visible audit row with no
  // charges, even when stale generated line items still carry positive dollars.
  if (cancelledLine || isCancelledBillingStatus(orderStatus) || cancelledLifecycle) {
    return result('cancelled_no_charge', 'Cancelled \u00b7 No charge', 'red', 'cancelled', 'CANCELLED', input);
  }

  if (input.packageCostNeedsReview === true || input.shippingZeroNeedsReview === true) {
    return result('needs_review', 'Needs review', 'amber', 'missing_cost', null, input);
  }
  if (input.feeWaived === true) {
    return result('waived', 'Prep fee waived', 'blue', 'waived', null, input);
  }
  if ((input.manualBillingOverrideLabels ?? []).some((label) => normalizedText(label))) {
    return result('manual_adjustment', 'Manual override', 'blue', 'manual_override', null, input);
  }

  return result('fulfilled', 'Fulfilled', 'neutral', null, null, input);
}

/**
 * PS-502 — does `billing_line_items.replacement_id` exist on THIS database?
 *
 * Migrations are not applied by deploy in this repo, so code can reach production ahead of
 * its schema. 0097 adds this column and the PS-502 migration set is still gated behind the
 * designated-operator flow, which means a summary that referenced it unguarded would 500
 * for every client — over replacement money that cannot exist on a database lacking the
 * column in the first place.
 *
 * Memoised: the answer cannot change without a deploy-time migration, and the billing
 * summary is a hot path that must not pay for an information_schema round trip per call.
 */

