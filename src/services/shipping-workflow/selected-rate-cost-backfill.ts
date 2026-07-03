import { resolveBillingSelectedRateCost } from '../billing-selected-rate-cost';

/**
 * PS-370 Phase 2 — pure planner for the shipments.selected_rate_cost HISTORY backfill.
 *
 * Phase 1 added the additive column and made every reader PREFER it, falling back
 * to its exact prior derivation for NULL rows. This planner materializes that same
 * derived value into the column for existing (incl. shipped) rows — so after backfill
 * the read-time fallback becomes NULL-safety only.
 *
 * BYTE-IDENTITY GATE (the safety keystone): a row is only `affected` when the value
 * to write equals what BOTH the billing-generate reader `(cost||labelCost)+otherCost`
 * AND resolveBillingSelectedRateCost derive for it. In practice that is exactly the
 * rows where `cost` or `labelCost` is present (postage known) — there all three
 * readers agree, so writing the column changes NO billed number. Rows with neither
 * cost nor labelCost (JSON-only / no recorded cost) are the "agree only by luck"
 * divergent case where the generate reader ($0) and the resolver (JSON/normalizer)
 * can disagree; those are SKIPPED and left NULL so both readers keep their exact
 * current behavior. The backfill therefore never mutates a money value — it only
 * persists a value already returned on read.
 *
 * Pure: numbers/JSON in, a plan out. No db, no io — the script builds the rows and
 * the guard exercises the full matrix offline.
 */

export type SelectedRateCostBackfillRow = {
  shipmentId: number;
  orderNumber: string | null;
  /** shipments.cost (synced/label postage). */
  cost: number | string | null;
  /** shipments.labelCost (fallback postage). */
  labelCost: number | string | null;
  /** shipments.otherCost (insurance/other; NOT NULL default 0). */
  otherCost: number | string | null;
  /** shipments.selectedRateJson (audit blob). */
  selectedRateJson: unknown;
  /** shipments.selected_rate_cost — the column being backfilled (NULL = not yet). */
  selectedRateCost: number | string | null;
};

export type SelectedRateCostBackfillPlan = {
  shipmentId: number;
  orderNumber: string | null;
  affected: boolean;
  /** the value that would be written (2dp) — only meaningful when affected. */
  value: number | null;
  /** why a row is not affected (already set / no recorded cost / reader-divergent). */
  skipReason: 'already_set' | 'no_recorded_cost' | 'reader_divergent' | null;
};

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNum(value: unknown): number {
  return toFiniteNumber(value) ?? 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function planSelectedRateCostBackfillRow(row: SelectedRateCostBackfillRow): SelectedRateCostBackfillPlan {
  const base = { shipmentId: row.shipmentId, orderNumber: row.orderNumber };

  // Idempotent: a row that already carries the column is never rewritten.
  if (toFiniteNumber(row.selectedRateCost) != null) {
    return { ...base, affected: false, value: null, skipReason: 'already_set' };
  }

  // Postage must be known (cost or labelCost) for the readers to agree. Without it
  // the generate reader yields $0 while the resolver may read the JSON total — the
  // divergent case. Leave NULL so neither reader's number changes.
  const postage = toFiniteNumber(row.cost) ?? toFiniteNumber(row.labelCost);
  if (postage == null) {
    return { ...base, affected: false, value: null, skipReason: 'no_recorded_cost' };
  }

  // The billing-generate reader's EXACT formula.
  const generateValue = round2((toNum(row.cost) || toNum(row.labelCost)) + toNum(row.otherCost));
  // The billing-details resolver (column omitted → its component derivation).
  const resolverValue = resolveBillingSelectedRateCost({
    cost: row.cost,
    labelCost: row.labelCost,
    otherCost: row.otherCost,
    selectedRateJson: row.selectedRateJson,
  });

  // Byte-identity gate: only write when the two readers already agree to the cent.
  if (resolverValue == null || round2(resolverValue) !== generateValue) {
    return { ...base, affected: false, value: null, skipReason: 'reader_divergent' };
  }

  return { ...base, affected: true, value: generateValue, skipReason: null };
}

export type SelectedRateCostBackfillSummary = {
  total: number;
  affected: number;
  alreadySet: number;
  noRecordedCost: number;
  readerDivergent: number;
};

export function summarizeSelectedRateCostBackfill(
  plans: SelectedRateCostBackfillPlan[],
): SelectedRateCostBackfillSummary {
  return plans.reduce<SelectedRateCostBackfillSummary>(
    (acc, plan) => {
      acc.total += 1;
      if (plan.affected) acc.affected += 1;
      else if (plan.skipReason === 'already_set') acc.alreadySet += 1;
      else if (plan.skipReason === 'no_recorded_cost') acc.noRecordedCost += 1;
      else if (plan.skipReason === 'reader_divergent') acc.readerDivergent += 1;
      return acc;
    },
    { total: 0, affected: 0, alreadySet: 0, noRecordedCost: 0, readerDivergent: 0 },
  );
}
