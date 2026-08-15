/**
 * PS-501 — the one place the frontend is allowed to obtain a billing row's total.
 *
 * WHAT WAS WRONG
 *
 * Consumers resolved the total as `row.grandTotal ?? row.total ?? row.fulfillmentFeeTotal`.
 * That reads like null-safety and is actually a silent substitution, because the three
 * fields are not synonyms:
 *
 *   grandTotal           the row's money. Backend-owned, canonical.
 *   total                the same value under the old name (the backend emits
 *                        `total: grandTotal` for legacy callers).
 *   fulfillmentFeeTotal  NOT a total — Pick & Pack + Additional Units + Box Cost only.
 *                        Shipping, storage, adjustments and return money are excluded
 *                        by construction.
 *
 * On a real fixture row totalling $35.65, `fulfillmentFeeTotal` is $8.00. So the moment
 * `grandTotal` was nullish the operator saw $8.00 presented as the customer's total, with
 * nothing to indicate a fallback had happened. PS-505 fixed this exact conflation on the
 * backend after it rendered 12.44 instead of 4.49 on order #3074; this is its twin on the
 * consumer side.
 *
 * WHY THIS REFUSES RATHER THAN DEFAULTS
 *
 * A safer fallback ordering would keep field order as the decision procedure and merely
 * change which wrong number is reached. So this resolves ONE field and otherwise fails:
 * callers get an error to render, never a plausible substitute. Showing "—" is recoverable;
 * showing a confidently wrong invoice total is not.
 *
 * WHAT IT IS NOT
 *
 * Not a source of truth, and not a wrapper hiding one. It selects no value, applies no
 * business rule and computes no money — the backend already emits the canonical field
 * (billing.ts, billing-detail-row-sot.ts). It normalises ONE wire-shape concern: the
 * snake_case spelling of the SAME field, which PS-369 keeps as a deploy-skew fallback for
 * the window where an old backend is still answering. Alias PRECEDENCE is what it removes.
 */

export type BillingRowTotalResult =
  | { ok: true; total: number }
  | { ok: false; reason: string };

/** Tolerance for comparing two spellings of one persisted money value. */
const MONEY_EPSILON = 0.005;

type TotalBearingRow = {
  grandTotal?: unknown;
  grand_total?: unknown;
  total?: unknown;
  fulfillmentFeeTotal?: unknown;
  // The billing DTOs are `Record<string, any>` intersections. Without an index signature
  // here this type would be a WEAK type (all-optional), and TypeScript would reject every
  // one of those DTOs for sharing no declared property — which says nothing about whether
  // the row carries a total.
  [key: string]: unknown;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a billing row's canonical total, or say why it cannot be resolved.
 *
 * `grand_total` is accepted as the same field under the deploy-skew spelling (PS-369).
 * `total` is only ever used to DETECT a contradiction, never as a value — if the backend
 * ever emits the two disagreeing, that is a contract break to surface rather than a choice
 * to make. `fulfillmentFeeTotal` is never consulted.
 */
export function resolveBillingRowGrandTotal(row: TotalBearingRow): BillingRowTotalResult {
  const canonical = finiteNumber(row.grandTotal) ?? finiteNumber(row.grand_total);

  if (canonical === null) {
    return {
      ok: false,
      reason:
        'row has no usable grandTotal. The row total is backend-owned; fulfillmentFeeTotal ' +
        'is a different quantity and must not stand in for it.',
    };
  }

  const legacy = finiteNumber(row.total);
  if (legacy !== null && Math.abs(legacy - canonical) > MONEY_EPSILON) {
    return {
      ok: false,
      reason: `row disagrees with itself: grandTotal=${canonical} but total=${legacy}.`,
    };
  }

  return { ok: true, total: canonical };
}

/**
 * The total for arithmetic that must not silently drop a row (sorting, aggregation).
 *
 * Returns `null` rather than 0 when the contract fails, so callers decide. 0 would sort an
 * unresolvable row to the bottom and sum it as free, both of which look like real answers.
 */
export function billingRowGrandTotalOrNull(row: TotalBearingRow): number | null {
  const resolved = resolveBillingRowGrandTotal(row);
  return resolved.ok ? resolved.total : null;
}
