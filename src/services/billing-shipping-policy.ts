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
  /** orders.order_status (persisted). 'cancelled' → the auto-assigned prep fee
   *  may be unwarranted (the work may not have happened). */
  orderStatus?: string | null;
  /** True when this order is a bundle CHILD — shipping is billed ONCE on the
   *  primary, so $0 here is legitimate and the prep fee may still be valid. */
  isBundledChild?: boolean;
};

// PS-376: WHY a $0-shipping row needs review — the situations carry different
// prep-fee implications, so the operator must be able to tell them apart.
export type ZeroShippingReviewReason =
  | 'cancelled_or_not_shipped'
  | 'bundled_with_order'
  | 'missing_shipping_proof'
  | 'zero_shipping_unknown';

export type ZeroShippingReviewSeverity = 'warn' | 'info';

export type ZeroShippingReviewDecision = {
  /** True ONLY when shippingAmount is EXACTLY 0. */
  needsReview: boolean;
  /** WHY it needs review (null when it does not). */
  reason: ZeroShippingReviewReason | null;
  /** Short operator-facing label for the badge ('' when no review). */
  label: string;
  /** 'warn' for prep-fee-risk cases (cancelled / missing proof / unknown);
   *  'info' for the benign bundled case. */
  severity: ZeroShippingReviewSeverity;
};

// The canonical label + severity per reason. Thin UI renders these verbatim.
const ZERO_SHIPPING_REVIEW_META: Record<
  ZeroShippingReviewReason,
  { label: string; severity: ZeroShippingReviewSeverity }
> = {
  cancelled_or_not_shipped: { label: 'Cancelled — review prep fee', severity: 'warn' },
  bundled_with_order: { label: 'Bundled — shipping on another order', severity: 'info' },
  missing_shipping_proof: { label: '$0 shipping — no shipment proof', severity: 'warn' },
  zero_shipping_unknown: { label: '$0 shipping — review', severity: 'warn' },
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
 * Decide whether a billed shipping line needs the $0-shipping review, AND WHY.
 * needsReview is TRUE only when the shipping amount is EXACTLY 0 (missing/unknown
 * is NOT $0 — that remains the separate missing-cost review, unchanged). PS-376:
 * classify the reason from canonical persisted facts so the operator can tell a
 * cancelled row (prep fee may be unwarranted) from a bundled row (prep fee likely
 * valid) from a row with no shipment proof. Priority: cancelled → bundled →
 * missing-proof → unknown. The reason never changes needsReview — every exact-$0
 * shipping line is flagged; the reason only explains it.
 */
export function decideZeroShippingReview(
  input: ZeroShippingReviewInput,
): ZeroShippingReviewDecision {
  if (!isExactlyZero(input.shippingAmount)) {
    return { needsReview: false, reason: null, label: '', severity: 'info' };
  }
  const status = String(input.orderStatus ?? '').trim().toLowerCase();
  const reason: ZeroShippingReviewReason =
    status === 'cancelled' || status === 'canceled'
      ? 'cancelled_or_not_shipped'
      : input.isBundledChild === true
        ? 'bundled_with_order'
        : input.hasShipmentRow !== true
          ? 'missing_shipping_proof'
          : 'zero_shipping_unknown';
  const { label, severity } = ZERO_SHIPPING_REVIEW_META[reason];
  return { needsReview: true, reason, label, severity };
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
