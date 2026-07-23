import { resolveBillingSelectedRateCost } from '../billing-selected-rate-cost';
// Per user override unlock shipped data on 2026-07-23: PS-457 delegates only
// cent rounding; the shipped-history proof and idempotency gates are unchanged.
import { roundMoney } from '../../lib/money';

/**
 * PS-370 Phase 2 — pure planner for the shipments.selected_rate_cost HISTORY backfill.
 *
 * Phase 1 added the additive column and made every reader PREFER it, falling back
 * to its exact prior derivation for NULL rows. This planner materializes that same
 * derived value into the column for existing (incl. shipped) rows — so after backfill
 * the read-time fallback becomes NULL-safety only.
 *
 * SAFETY GATE: a row is only `affected` when the backend resolver can prove a
 * durable selected-rate cost from either the selected-rate JSON total or from
 * `(cost || labelCost) + otherCost` where postage proof exists. Rows with neither
 * proof are SKIPPED and left NULL for review.
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

export function planSelectedRateCostBackfillRow(row: SelectedRateCostBackfillRow): SelectedRateCostBackfillPlan {
  const base = { shipmentId: row.shipmentId, orderNumber: row.orderNumber };

  // Idempotent: a row that already carries the column is never rewritten.
  if (toFiniteNumber(row.selectedRateCost) != null) {
    return { ...base, affected: false, value: null, skipReason: 'already_set' };
  }

  // Per user override unlock shipped data on 2026-07-06: PS-381 backfills only
  // shipments.selected_rate_cost, and only when durable shipment cost proof
  // exists. Selected-rate JSON totals are durable proof; rows without JSON total
  // or postage proof stay NULL for review.
  const resolverValue = resolveBillingSelectedRateCost({
    cost: row.cost,
    labelCost: row.labelCost,
    otherCost: row.otherCost,
    selectedRateJson: row.selectedRateJson,
  });
  if (resolverValue == null) {
    return { ...base, affected: false, value: null, skipReason: 'no_recorded_cost' };
  }

  const postage = toFiniteNumber(row.cost) ?? toFiniteNumber(row.labelCost);
  if (postage == null) {
    return { ...base, affected: true, value: roundMoney(resolverValue), skipReason: null };
  }

  // The billing-generate reader's component formula. When postage proof exists,
  // keep the byte-identity gate so a conflicting JSON blob cannot overwrite the
  // component truth.
  const generateValue = roundMoney((toNum(row.cost) || toNum(row.labelCost)) + toNum(row.otherCost));

  if (roundMoney(resolverValue) !== generateValue) {
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
