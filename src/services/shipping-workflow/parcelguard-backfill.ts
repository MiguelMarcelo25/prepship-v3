// PS-108 Phase 3 — PURE reconciliation planner for shipped HUGRAB ParcelGuard costs.
//
// No DB, no network: given a local shipment row + the authoritative ShipStation BILLED
// cost breakdown, decide whether the local accounting is postage-only and what the
// minimal, idempotent update plan would be. The runnable script
// (scripts/ps-108-parcelguard-cost-backfill.ts) owns DB reads, the ShipStation billed
// source, and the dry-run/apply CLI; this module owns the decision so it is unit-tested
// offline (Phase-4 guard) without touching production or buying postage.

import { HUGRAB_REQUIRED_INSURED_VALUE } from './insurance-coverage-status';
import type { BilledInsuranceCost } from './insurance-cost';

export type LocalShipmentAccounting = {
  shipmentId: number;
  orderId: number | null;
  orderNumber: string | null;
  /** ShipStation numeric shipment id (shipments.labelShipmentId). */
  ssShipmentId: number | null;
  /** Local postage cost (shipments.cost). */
  cost: number | null;
  /** Local "other" cost (shipments.otherCost) — where the premium belongs. */
  otherCost: number | null;
  /** Local selected-rate total (shipments.selectedRateCost). */
  selectedRateCost?: number | string | null;
  /** Local selected-rate JSON; used only to detect missing proof metadata. */
  selectedRateJson?: unknown;
  carrierCode: string | null;
  serviceCode: string | null;
};

export type ParcelGuardBackfillPlan = {
  shipmentId: number;
  orderNumber: string | null;
  ssShipmentId: number | null;
  /** Whether this row needs an accounting correction. */
  affected: boolean;
  reason: string;
  localPostage: number;
  localOtherCost: number;
  localTotal: number;
  billedPostage: number;
  billedPremium: number;
  billedTotal: number;
  provenance: string | null;
  /** The minimal field updates apply-mode WOULD write (null when not affected). */
  updates:
    | {
        otherCost: string;
        selectedRateCost: string;
        selectedRateJsonPatch: {
          otherCost: number;
          insuranceProvider: 'parcelguard';
          insuredValue: number;
          insuranceCost: number;
          insuranceProvenance: string;
          totalCost: number;
        };
      }
    | null;
};

const EPSILON = 0.005; // half a cent — money compared to 2dp.

function num(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function approxEqual(left: unknown, right: number): boolean {
  const n = finiteNumber(left);
  return n !== null && Math.abs(n - right) <= EPSILON;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function selectedRateJsonHasProof(
  row: LocalShipmentAccounting,
  base: Pick<ParcelGuardBackfillPlan, 'billedPremium' | 'billedTotal' | 'provenance'>,
): boolean {
  const selectedRate = recordOrNull(row.selectedRateJson);
  if (!selectedRate) return false;

  const provider = norm(selectedRate.insuranceProvider);
  const provenance = norm(selectedRate.insuranceProvenance);
  return provider === 'parcelguard' &&
    approxEqual(selectedRate.insuredValue, HUGRAB_REQUIRED_INSURED_VALUE) &&
    approxEqual(selectedRate.insuranceCost, base.billedPremium) &&
    provenance === norm(base.provenance) &&
    approxEqual(selectedRate.totalCost, base.billedTotal);
}

/**
 * Decide the backfill plan for one shipment. Idempotent: a row whose local otherCost
 * already matches the billed premium is reported `affected: false` (reason
 * `already_reconciled`) so re-running apply is a no-op.
 *
 * A row is affected only when:
 *   - ShipStation billed a positive insurance premium, AND
 *   - the local otherCost is ~0 (postage-only) OR less than the billed premium, AND
 *   - the billed total exceeds the local total (we never lower a recorded cost here).
 */
export function planParcelGuardBackfillRow(
  row: LocalShipmentAccounting,
  billed: BilledInsuranceCost | null,
): ParcelGuardBackfillPlan {
  const localPostage = round2(num(row.cost));
  const localOtherCost = round2(num(row.otherCost));
  const localTotal = round2(localPostage + localOtherCost);

  const base: Omit<ParcelGuardBackfillPlan, 'affected' | 'reason' | 'updates'> = {
    shipmentId: row.shipmentId,
    orderNumber: row.orderNumber,
    ssShipmentId: row.ssShipmentId,
    localPostage,
    localOtherCost,
    localTotal,
    billedPostage: round2(num(billed?.postageAmount)),
    billedPremium: round2(num(billed?.insuranceAmount)),
    billedTotal: round2(num(billed?.totalAmount)),
    provenance: billed?.provenance ?? null,
  };

  if (!billed) {
    return { ...base, affected: false, reason: 'no_billed_cost', updates: null };
  }
  if (base.billedPremium <= 0) {
    return { ...base, affected: false, reason: 'no_insurance_premium', updates: null };
  }
  const otherCostMatches = Math.abs(localOtherCost - base.billedPremium) <= EPSILON;
  const selectedRateCostMatches = approxEqual(row.selectedRateCost, base.billedTotal);
  const selectedRateHasProof = selectedRateJsonHasProof(row, base);
  if (otherCostMatches && selectedRateCostMatches && selectedRateHasProof) {
    return { ...base, affected: false, reason: 'already_reconciled', updates: null };
  }
  const shouldWriteOtherCost = !otherCostMatches && base.billedTotal > localTotal + EPSILON;
  if (!shouldWriteOtherCost && selectedRateCostMatches && selectedRateHasProof) {
    // Billed total not higher than what we already recorded — do not lower costs here.
    return { ...base, affected: false, reason: 'local_total_not_lower', updates: null };
  }

  return {
    ...base,
    affected: true,
    reason: shouldWriteOtherCost
      ? 'postage_only_missing_premium'
      : selectedRateCostMatches
        ? 'missing_insurance_proof'
        : 'missing_selected_rate_cost',
    updates: {
      otherCost: (shouldWriteOtherCost ? base.billedPremium : localOtherCost).toFixed(2),
      selectedRateCost: base.billedTotal.toFixed(2),
      selectedRateJsonPatch: {
        otherCost: base.billedPremium,
        insuranceProvider: 'parcelguard',
        insuredValue: HUGRAB_REQUIRED_INSURED_VALUE,
        insuranceCost: base.billedPremium,
        insuranceProvenance: billed.provenance,
        totalCost: base.billedTotal,
      },
    },
  };
}

export function summarizeBackfillPlans(plans: ParcelGuardBackfillPlan[]): {
  total: number;
  affected: number;
  alreadyReconciled: number;
  noBilledCost: number;
  totalPremiumCents: number;
} {
  let affected = 0;
  let alreadyReconciled = 0;
  let noBilledCost = 0;
  let totalPremiumCents = 0;
  for (const plan of plans) {
    if (plan.affected) {
      affected += 1;
      totalPremiumCents += Math.round(plan.billedPremium * 100);
    } else if (plan.reason === 'already_reconciled') {
      alreadyReconciled += 1;
    } else if (plan.reason === 'no_billed_cost') {
      noBilledCost += 1;
    }
  }
  return { total: plans.length, affected, alreadyReconciled, noBilledCost, totalPremiumCents };
}
