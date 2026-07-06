export type BillingLifecycleStatus =
  | 'fulfilled'
  | 'cancelled_no_charge'
  | 'cancelled_billable'
  | 'return'
  | 'return_label'
  | 'return_processing'
  | 'needs_review'
  | 'manual_adjustment'
  | 'waived';

export type BillingStatusTone = 'neutral' | 'red' | 'purple' | 'amber' | 'blue';
export type BillingZeroReason = 'cancelled' | 'waived' | 'bundled' | 'missing_cost' | 'manual_override' | null;

export type BillingRowStatusInput = {
  lineType?: string | null;
  lineTypes?: readonly unknown[] | null;
  orderStatus?: string | null;
  totalCost?: unknown;
  feeWaived?: boolean | null;
  packageCostNeedsReview?: boolean | null;
  shippingZeroNeedsReview?: boolean | null;
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

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isBillingReturnLineType(lineType: unknown): boolean {
  const value = normalizedText(lineType)?.toLowerCase();
  return value === 'return' || value === 'return_label' || value === 'return_processing';
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

  if (hasLine('return_processing')) {
    return result('return_processing', 'Return processing', 'purple', null, null, input);
  }
  if (hasLine('return_label')) {
    return result('return_label', 'Return label', 'purple', null, null, input);
  }
  if (hasLine('return')) {
    return result('return', 'Return', 'purple', null, null, input);
  }

  const orderStatus = normalizedText(input.orderStatus)?.toLowerCase();
  const totalCost = numericValue(input.totalCost);
  const cancelledLine = hasLine('cancelled');
  if (cancelledLine || (orderStatus === 'cancelled' && (totalCost == null || totalCost <= 0))) {
    return result('cancelled_no_charge', 'Cancelled \u00b7 No charge', 'red', 'cancelled', 'CANCELLED', input);
  }
  if (orderStatus === 'cancelled') {
    return result('cancelled_billable', 'Cancelled', 'red', null, 'CANCELLED', input);
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
