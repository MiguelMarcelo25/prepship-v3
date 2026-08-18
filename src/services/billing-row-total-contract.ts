/**
 * PS-501 — the canonical billing row total, and the contract that keeps it canonical.
 *
 * THE DEFECT THIS CLOSES
 *
 * Billing rows travel with three total-shaped fields, and only two of them mean the same
 * thing:
 *
 *   grandTotal           the row's money. Canonical.
 *   total                the same value under the old name, emitted for back-compat
 *                        (billing.ts: `total: grandTotal`).
 *   fulfillmentFeeTotal  NOT a total. Pick & Pack + Additional Units + Box Cost only —
 *                        shipping, storage, adjustments and return money are excluded
 *                        by construction.
 *
 * Consumers were resolving these by field order — `grandTotal ?? total ??
 * fulfillmentFeeTotal` — which reads like a null-safety idiom and is actually a silent
 * substitution of a smaller, different number. The moment `grandTotal` is nullish the row
 * displays fulfillment fees as the customer's total, understating it by the entire
 * shipping + storage + adjustment + return amount.
 *
 * This is not hypothetical, and it is not new. PS-505 fixed the same conflation on the
 * other side of the wire: `fulfillmentFeeTotal` used as a row total rendered 12.44 instead
 * of 4.49 on order #3074 (billing-detail-row-sot.ts). PS-501 is that defect's twin,
 * still live in the consumers.
 *
 * WHY A CONTRACT RATHER THAN A DEFAULT
 *
 * The tempting fix is a safer fallback chain. That keeps field order as the decision
 * procedure and only changes which wrong answer is reached. So this module refuses to
 * choose instead: `grandTotal` is required, a disagreeing `total` is a contract error, and
 * `fulfillmentFeeTotal` is never a candidate. A caller that cannot get a canonical total
 * gets an exception naming the row, not a plausible number.
 */

/** The alias that is a genuine synonym, kept on the wire for legacy callers. */
const LEGACY_TOTAL_ALIAS = 'total';

/**
 * Money equality tolerance.
 *
 * `grandTotal` and `total` are assigned from one variable at the emit site, so on the
 * happy path they are bit-identical. The tolerance exists for payloads that made a
 * round trip through JSON and rounding, not to excuse a real disagreement: a cent is
 * far below any difference that could come from a wrong bucket.
 */
const MONEY_EPSILON = 0.005;

export class BillingRowTotalContractError extends Error {
  readonly rowRef: string;

  constructor(message: string, rowRef: string) {
    super(message);
    this.name = 'BillingRowTotalContractError';
    this.rowRef = rowRef;
  }
}

type TotalBearingRow = {
  grandTotal?: unknown;
  total?: unknown;
  fulfillmentFeeTotal?: unknown;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The canonical total for a billing row, or an explicit contract error.
 *
 * `rowRef` is only for the message — it should identify the row a human would look up
 * (a client id, an order number). A contract error that cannot be traced to a row is
 * nearly as useless as the silent substitution it replaced.
 */
export function canonicalRowGrandTotal(row: TotalBearingRow, rowRef: string): number {
  const grandTotal = finiteNumber(row.grandTotal);

  if (grandTotal === null) {
    throw new BillingRowTotalContractError(
      `billing row ${rowRef} has no usable grandTotal (received ${JSON.stringify(row.grandTotal)}). ` +
        'The row total is backend-owned and must be emitted; consumers may not substitute ' +
        `${LEGACY_TOTAL_ALIAS} or fulfillmentFeeTotal, which is a different quantity.`,
      rowRef,
    );
  }

  const legacy = finiteNumber(row.total);
  if (legacy !== null && Math.abs(legacy - grandTotal) > MONEY_EPSILON) {
    throw new BillingRowTotalContractError(
      `billing row ${rowRef} disagrees with itself: grandTotal=${grandTotal} but ` +
        `${LEGACY_TOTAL_ALIAS}=${legacy}. These are emitted from one value and must match; ` +
        'field order must never pick the winner.',
      rowRef,
    );
  }

  return grandTotal;
}

/**
 * AC-4 — the category buckets must account for the whole row.
 *
 * Returned rather than thrown, because the caller decides severity: a boundary test
 * asserts it is empty, while a route may prefer to log. `null` means reconciled.
 *
 * Return money is included deliberately. A summary that sums only the outbound buckets
 * reconciles by accident while `RETURN_BILLING_ENABLED` is off and silently stops
 * reconciling the day it is switched on, which is the worst possible moment to discover
 * a missing bucket.
 */
export function reconcileCategoryTotals(
  row: {
    pickPackTotal?: unknown;
    additionalTotal?: unknown;
    packageTotal?: unknown;
    shippingTotal?: unknown;
    storageTotal?: unknown;
    adjustmentTotal?: unknown;
    returnTotal?: unknown;
    /**
     * PS-502 AC-18. Optional like the rest: a caller that has not been taught the bucket
     * yet contributes 0 and is CAUGHT by the delta, which is the point. Making these
     * required would turn a silent reconciliation failure into a compile error at the few
     * call sites that already pass everything, and leave the ones that do not untouched.
     */
    replacePostageTotal?: unknown;
    replacePickPackTotal?: unknown;
  },
  grandTotal: number,
  rowRef: string,
): string | null {
  const categories = [
    'pickPackTotal', 'additionalTotal', 'packageTotal',
    'shippingTotal', 'storageTotal', 'adjustmentTotal', 'returnTotal',
    'replacePostageTotal', 'replacePickPackTotal',
  ] as const;

  let sum = 0;
  for (const key of categories) sum += finiteNumber((row as Record<string, unknown>)[key]) ?? 0;

  if (Math.abs(sum - grandTotal) <= MONEY_EPSILON) return null;

  return (
    `billing row ${rowRef}: category totals sum to ${sum.toFixed(2)} but grandTotal is ` +
    `${grandTotal.toFixed(2)} (delta ${(grandTotal - sum).toFixed(2)}). Some money on this ` +
    'row belongs to no displayed bucket.'
  );
}
