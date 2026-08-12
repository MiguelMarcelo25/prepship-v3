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
export function isBillingReturnLineType(lineType: unknown): boolean {
  const value = normalizedText(lineType)?.toLowerCase();
  return value === 'return'
    || value === 'return_label'
    || value === 'return_processing'
    || value === 'return_postage'
    || value === 'return_processing_fee';
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
