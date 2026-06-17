/**
 * PS-275 — the canonical owner of the $0-shipping billing review decision AND
 * the prep-fee waiver application. PURE (zero imports, no db) so the PS-275
 * guard can exercise the whole matrix offline; the generator / route / FE are
 * thin consumers that DISPLAY or PERSIST the outcome — none re-implement it.
 *
 * Two rules live here:
 *
 *  1. decideZeroShippingReview — flag a billed shipping line for operator
 *     review ONLY when the shipping amount is EXACTLY $0.00. A missing/unknown
 *     cost is NOT $0 — that is the pre-existing "shipping_missing" review
 *     (PS-207 era), kept untouched. So a real, recorded, zero-dollar label
 *     (e.g. a free/test/comp label that actually shipped) becomes visible for a
 *     human to decide, instead of silently billing $0 forever.
 *
 *  2. applyPrepFeeWaiver — zero ONLY the prep / fulfillment / pick-pack fee
 *     lines on an order, NEVER product revenue, marketplace fees, the
 *     package/box cost, storage, or the shipping label cost. The waiver is an
 *     operator decision (the order shipped for $0, so the prep fee is comped);
 *     it must never touch a dollar the warehouse genuinely owes/charges for
 *     beyond prep.
 */

/** Line types that ARE prep / fulfillment / pick-pack fees — the ONLY lines a
 * prep-fee waiver may zero. Everything else (product, marketplace, box,
 * storage, shipping label) is out of scope and stays byte-identical. */
export const PREP_FEE_LINE_TYPES: ReadonlySet<string> = new Set([
  'pick_pack',
  'pickpack',
  'additional_unit',
  'additional',
  'fulfillment',
  'fulfillment_fee',
  'prep',
  'prep_fee',
]);

export type ZeroShippingReviewInput = {
  /** The recorded shipping amount in dollars. null/undefined = UNKNOWN (NOT $0). */
  shippingAmount: number | null | undefined;
  externallyShipped?: boolean;
  /** True when a shipments row backs this order (a real label exists). */
  hasShipmentRow?: boolean;
};

export type ZeroShippingReviewDecision = {
  /** True ONLY when shippingAmount is EXACTLY 0. */
  needsReview: boolean;
};

/** Strict exact-$0 detector. A non-finite, null, or undefined amount is
 * UNKNOWN — never $0 — so it falls through to the existing missing-cost
 * review and never trips this one. Negative amounts are not $0 either. */
function isExactlyZero(amount: number | null | undefined): boolean {
  if (amount === null || amount === undefined) return false;
  if (typeof amount !== 'number') return false;
  if (!Number.isFinite(amount)) return false;
  return amount === 0;
}

/**
 * Decide whether a billed shipping line needs the $0-shipping review.
 * TRUE only when the shipping amount is EXACTLY 0. Missing/unknown is NOT $0 —
 * that remains the separate missing-cost review (unchanged). externallyShipped
 * / hasShipmentRow are accepted for context (and so callers pass the full
 * shape) but do not relax the exact-$0 rule.
 */
export function decideZeroShippingReview(
  input: ZeroShippingReviewInput,
): ZeroShippingReviewDecision {
  return { needsReview: isExactlyZero(input.shippingAmount) };
}

/** Minimal line shape the waiver reads/writes. Extra fields pass through
 * untouched (the generator's LineRow carries many more). */
export type WaivableLine = {
  lineType?: string | null;
  line_type?: string | null;
  unitCost?: string | number | null;
  totalCost?: string | number | null;
};

/** True when a line is a prep/fulfillment/pick-pack fee (either casing of the
 * type field). Pure — no allocation beyond the lookup. */
export function isPrepFeeLine(line: WaivableLine): boolean {
  const t = line.lineType ?? line.line_type ?? '';
  return PREP_FEE_LINE_TYPES.has(String(t));
}

/**
 * Apply (or not) a prep-fee waiver to a list of billing lines. When `waived`
 * is true, every prep/fulfillment/pick-pack fee line is zeroed (unitCost and
 * totalCost -> '0.00'); ALL other line types are returned byte-identical. When
 * `waived` is false the input list is returned UNCHANGED (same references), so
 * the no-waiver path is a true no-op (idempotent + reversible: clearing the
 * waiver re-runs generation and restores the original prep amounts).
 *
 * Returns a NEW array (and new objects only for the zeroed prep lines) so the
 * caller can swap it in without mutating its source; non-prep lines keep their
 * identity.
 */
export function applyPrepFeeWaiver<T extends WaivableLine>(
  lineItems: readonly T[],
  waived: boolean,
): T[] {
  if (!waived) return lineItems as T[];
  return lineItems.map((line) =>
    isPrepFeeLine(line)
      ? { ...line, unitCost: '0.00', totalCost: '0.00' }
      : line,
  );
}
