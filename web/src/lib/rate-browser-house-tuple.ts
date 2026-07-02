// PS-292 — pure SHIPP house-account tuple helpers for the Rate Browser FE boundary.
//
// ROOT CAUSE this fixes (PS-220 "Blocker A"): the backend (src/routes/rates.ts:604-620) is the SOLE
// owner of the SHIPP house tuple — when SHIPP wins for an opted-in client it stamps
// bestRate.nextBestNonHouseRate (the cheapest ELIGIBLE non-SHIPP rate = the customer_rate basis) and
// bestRate.houseMargin onto the /rates/browse response. The FE then ran every rate through
// translateRateToV2Shape, a fixed allowlist that DROPPED those two fields (they survived only under
// `.raw`), so every FE save persisted order_overrides.best_rate_json WITHOUT the tuple and the
// Awaiting / Rate Browser UI — which reads nextBestNonHouseRate.totalCost off the top level — had
// nothing to render.
//
// This module is the ONE place the FE lifts the backend-owned fields, so translateRateToV2Shape and
// the Rate Browser apply/render paths consume the SAME extraction and cannot silently drift. Pure +
// zero-import so the PS-292 guard verifies it offline. The FE NEVER computes the customer_rate /
// margin — it only forwards what the backend issued (and the backend nulls these for non-financial
// viewers via redactRateBrowserMoney, so a redacted response yields no tuple here by construction).

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// translateRateToV2Shape pass-through: always returns BOTH house keys (null when the backend issued
// no projection), mirroring the v2 allowlist's `?? null` convention so the FE bestRate carries the
// tuple at the TOP level instead of burying it under `.raw`. Pass-through ONLY — never synthesized.
export function houseTuplePassThrough(rate: unknown): {
  nextBestNonHouseRate: unknown;
  houseMargin: number | null;
} {
  const obj = asRecord(rate);
  const nextBestNonHouseRate = obj?.nextBestNonHouseRate ?? null;
  const houseMargin = obj && typeof obj.houseMargin === 'number' ? obj.houseMargin : null;
  return { nextBestNonHouseRate, houseMargin };
}

// Rate Browser apply path: lift the house tuple onto the applied rate ONLY when the applied row IS
// the backend's canonical best. The rows array never carries the stamp (the backend stamps only
// bestRate), so the tuple is sourced from the canonical backend best and attached by identity
// (serviceCode + provider account) so it can never bind to a different row. Returns {} (no house
// fields) when there is no match or no backend projection.
export function houseTupleForRow(
  row: unknown,
  canonicalBest: unknown,
): { nextBestNonHouseRate?: unknown; houseMargin?: number | null } {
  const best = asRecord(canonicalBest);
  const r = asRecord(row);
  if (!best || !r) return {};
  if (!asRecord(best.nextBestNonHouseRate)) return {};
  const sameService = String(r.serviceCode ?? '') === String(best.serviceCode ?? '');
  const samePid = String(r.shippingProviderId ?? '') === String(best.shippingProviderId ?? '');
  if (!sameService || !samePid) return {};
  return {
    nextBestNonHouseRate: best.nextBestNonHouseRate,
    houseMargin: typeof best.houseMargin === 'number' ? best.houseMargin : null,
  };
}

// Render input for the Rate Browser recommended row: top/bold = customer_rate (backend
// nextBestNonHouseRate.totalCost), bottom = drp_cost (the SHIPP cost the row already shows, passed in
// by the parent which owns rateDisplayTotal). null unless the row is the canonical SHIPP best AND a
// positive customer_rate survived backend redaction (non-financial viewers get null -> hidden).
export function houseDisplayForRow(
  row: unknown,
  canonicalBest: unknown,
  drpCost: number,
): { drpCost: number; customerRate: number } | null {
  const matched = houseTupleForRow(row, canonicalBest);
  const nb = asRecord(matched.nextBestNonHouseRate);
  const customerRate = nb && typeof nb.totalCost === 'number' ? nb.totalCost : NaN;
  if (!Number.isFinite(customerRate) || customerRate <= 0) return null;
  if (!Number.isFinite(drpCost) || drpCost <= 0) return null;
  return { drpCost, customerRate };
}
