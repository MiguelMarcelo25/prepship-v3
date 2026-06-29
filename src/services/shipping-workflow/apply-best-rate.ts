// PS-302 — the canonical, backend-owned "Apply Best Rate" COMMAND. The frontend must
// stop orchestrating apply as three independent browser writes (save-dims +
// selected-pid + save-best-rate); instead it sends one intent and the backend persists
// dims/weight + selected package + best_rate_json in ONE atomic operation.
//
// This module is the PURE rule owner: given an apply intent it validates the command
// as a UNIT (a rate requires complete dims + a chosen package, and — when a current
// request fingerprint is supplied — the rate's proof must match it) and returns the
// exact order_overrides patch to persist, or a structured, machine-readable error.
// No I/O, no normalization side effects, no purchase — the route normalizes the rate
// payload and runs the single applyOverridesPatch behind assertOrderEditable.

import { validateExactSelectedRate } from './rate-fingerprint.js';
import { rateCostTotal, rateTotal } from '../rates-combined.js';

type ApplyRateQuoteSnapshot = {
  cacheKey: string;
  rates: unknown[];
  fetchedAt: string | number | null;
  bestRateKey?: string | null;
  bestRateComplete?: boolean | null;
};

const DEFAULT_APPLY_RATE_QUOTE_TTL_MS = 24 * 60 * 60 * 1000;

export type ApplyBestRateInput = {
  bestRateJson: unknown;
  // "LxWxH" dims label captured with the rate (the FE's bestRateDims).
  dimsLabel: string | null;
  selectedPid: number | null;
  weightOz?: number | null;
  // OPTIONAL selected-rate proof: when present, the rate being applied must have been
  // quoted against this same request — otherwise the apply is rejected (no stale buy).
  currentRequestFingerprint?: string | null;
};

export type ApplyBestRateErrorCode =
  | 'missing_rate'
  | 'missing_dims'
  | 'missing_package'
  | 'fingerprint_mismatch';

export type ApplyBestRatePatch = {
  bestRateJson: unknown;
  bestRateDims: string;
  selectedPid: number;
  rateDimsL: number;
  rateDimsW: number;
  rateDimsH: number;
  rateWeightOz?: number;
};

export type ApplyBestRateResult =
  | { ok: true; patch: ApplyBestRatePatch }
  | { ok: false; code: ApplyBestRateErrorCode; error: string };

export type ApplyBestRateSnapshotErrorCode =
  | 'rate_quote_not_found'
  | 'rate_quote_expired'
  | 'selected_rate_not_found'
  | 'selected_rate_proof_invalid';

export type FinalizeAppliedBestRateFromSnapshotResult =
  | { ok: true; bestRateJson: Record<string, unknown>; source: 'snapshot' | 'fallback' }
  | { ok: false; code: ApplyBestRateSnapshotErrorCode; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function moneyObjectAmount(record: Record<string, unknown>, key: string): number {
  const value = recordOrNull(record[key]);
  return numberOrNull(value?.amount) ?? 0;
}

function amountLooksLikeTotal(amount: number, rawTotal: number): boolean {
  return amount >= rawTotal - 0.005;
}

function fetchedAtMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function fetchedAtIso(value: string | number | null | undefined): string | null {
  const ms = fetchedAtMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function isApplyRateQuoteSnapshotFresh(snapshot: Pick<ApplyRateQuoteSnapshot, 'fetchedAt'>, now: number, ttlMs: number): boolean {
  const ms = fetchedAtMs(snapshot.fetchedAt);
  if (ms == null) return false;
  return ms + ttlMs > now;
}

function selectedRateKeyForRate(rate: Record<string, unknown>): string | null {
  return stringOrNull(rate.selectedRateKey) ?? stringOrNull(rate.selected_rate_key);
}

function findSnapshotRateForApply(snapshot: ApplyRateQuoteSnapshot, selectedRateKey: string): Record<string, unknown> | null {
  const target = selectedRateKey.trim();
  if (!target || !Array.isArray(snapshot.rates)) return null;
  for (const rate of snapshot.rates) {
    const row = recordOrNull(rate);
    if (!row) continue;
    if (selectedRateKeyForRate(row) === target) return row;
  }
  return null;
}

function stampApplyDisplayAliases(rate: Record<string, unknown>): Record<string, unknown> {
  const rawShippingAmount = moneyObjectAmount(rate, 'shipping_amount');
  const otherCost = roundMoney(
    moneyObjectAmount(rate, 'other_amount') +
      moneyObjectAmount(rate, 'confirmation_amount') +
      moneyObjectAmount(rate, 'insurance_amount'),
  );
  const rawCustomerTotal = roundMoney(rawShippingAmount + otherCost);
  const explicitCustomerAmount = numberOrNull(rate.customerRateAmount) ?? numberOrNull(rate.customer_rate_amount);
  const total = explicitCustomerAmount == null
    ? roundMoney(rateTotal(rate))
    : amountLooksLikeTotal(explicitCustomerAmount, rawCustomerTotal)
      ? roundMoney(explicitCustomerAmount)
      : roundMoney(explicitCustomerAmount + otherCost);
  const rawRateCostTotal = roundMoney(rawShippingAmount + otherCost);
  const explicitRateCostAmount = numberOrNull(rate.rateCostAmount) ?? numberOrNull(rate.rate_cost_amount);
  const rateCostAmount = explicitRateCostAmount == null
    ? roundMoney(rateCostTotal(rate))
    : amountLooksLikeTotal(explicitRateCostAmount, rawRateCostTotal)
      ? roundMoney(explicitRateCostAmount)
      : roundMoney(explicitRateCostAmount + otherCost);
  const shipmentCost = roundMoney(total - otherCost);
  return {
    ...rate,
    amount: total,
    shipmentCost: numberOrNull(rate.shipmentCost) ?? shipmentCost,
    otherCost: numberOrNull(rate.otherCost) ?? otherCost,
    totalCost: total,
    total_cost: total,
    customerRateAmount: total,
    customer_rate_amount: total,
    rateCostAmount: rateCostAmount,
    rate_cost_amount: rateCostAmount,
  };
}

export function applyRateQuoteRef(rate: unknown): { rateQuoteId: string | null; selectedRateKey: string | null } {
  const row = recordOrNull(rate);
  const raw = recordOrNull(row?.raw);
  return {
    rateQuoteId: stringOrNull(row?.rateQuoteId) ?? stringOrNull(raw?.rateQuoteId),
    selectedRateKey: stringOrNull(row?.selectedRateKey) ?? stringOrNull(raw?.selectedRateKey),
  };
}

export function finalizeAppliedBestRateFromSnapshot(input: {
  fallbackRate: unknown;
  rateQuoteId: string | null;
  selectedRateKey: string | null;
  snapshot: ApplyRateQuoteSnapshot | null;
  now?: number;
  ttlMs?: number;
}): FinalizeAppliedBestRateFromSnapshotResult {
  const rateQuoteId = stringOrNull(input.rateQuoteId);
  const selectedRateKey = stringOrNull(input.selectedRateKey);
  if (!rateQuoteId || !selectedRateKey) {
    const fallback = recordOrNull(input.fallbackRate);
    if (!fallback) {
      return { ok: false, code: 'selected_rate_not_found', error: 'A selected rate is required to apply.' };
    }
    return { ok: true, bestRateJson: fallback, source: 'fallback' };
  }
  if (!input.snapshot?.cacheKey) {
    return { ok: false, code: 'rate_quote_not_found', error: 'Rate quote expired. Re-rate before applying this rate.' };
  }
  const ttlMs = input.ttlMs ?? DEFAULT_APPLY_RATE_QUOTE_TTL_MS;
  if (!isApplyRateQuoteSnapshotFresh(input.snapshot, input.now ?? Date.now(), ttlMs)) {
    return { ok: false, code: 'rate_quote_expired', error: 'Rate quote expired. Re-rate before applying this rate.' };
  }
  const selected = findSnapshotRateForApply(input.snapshot, selectedRateKey);
  if (!selected) {
    return { ok: false, code: 'selected_rate_not_found', error: 'Selected rate was not found in the backend quote. Re-rate before applying.' };
  }
  const cacheCreatedAt = fetchedAtIso(input.snapshot.fetchedAt) ?? new Date(input.now ?? Date.now()).toISOString();
  const cacheExpiresAt = new Date(Date.parse(cacheCreatedAt) + ttlMs).toISOString();
  const proofRate = {
    ...selected,
    requestFingerprint: input.snapshot.cacheKey,
    cacheKey: input.snapshot.cacheKey,
    cacheCreatedAt,
    cacheExpiresAt,
    rateQuoteId,
    selectedRateKey,
    proofSource: 'backend_rate_response',
    isComplete: input.snapshot.bestRateComplete === true,
  };
  const validation = validateExactSelectedRate({
    currentRequestFingerprint: input.snapshot.cacheKey,
    selectedRate: proofRate,
    eligibleRates: input.snapshot.rates,
  });
  if (!validation.ok) {
    return {
      ok: false,
      code: 'selected_rate_proof_invalid',
      error: `Selected rate proof is invalid for this quote (${validation.reason}). Re-rate before applying.`,
    };
  }
  const stamped = stampApplyDisplayAliases(proofRate);
  return { ok: true, bestRateJson: stamped, source: 'snapshot' };
}

export function parseBestRateDimsLabel(value: unknown): { length: number; width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().toLowerCase().split('x').map((p) => Number(p.trim()));
  if (parts.length !== 3) return null;
  const [length, width, height] = parts;
  if (![length, width, height].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  return { length: length!, width: width!, height: height! };
}

function parseDimsLabel(value: string | null): { l: number; w: number; h: number } | null {
  const dims = parseBestRateDimsLabel(value);
  return dims ? { l: dims.length, w: dims.width, h: dims.height } : null;
}

export function validateBestRateDimsForPersistedRate(
  bestRateJson: unknown,
  bestRateDims: unknown,
): string | null {
  if (bestRateJson === undefined || bestRateJson === null) return null;
  if (parseBestRateDimsLabel(bestRateDims) == null) return null;
  return typeof bestRateDims === 'string' ? bestRateDims.trim() : null;
}

// Same proof fields the BestRateWorkflow DTO reads, so the apply command enforces the
// SAME fingerprint identity the display/purchase path already uses.
function rateFingerprint(rate: unknown): string | null {
  if (!isRecord(rate)) return null;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  const raw = isRecord(rate.raw) ? rate.raw : null;
  return (
    stringOrNull(rate.requestFingerprint) ??
    stringOrNull(rate.rateRequestFingerprint) ??
    stringOrNull(rate.cacheKey) ??
    stringOrNull(metadata?.requestFingerprint) ??
    stringOrNull(metadata?.cacheKey) ??
    stringOrNull(raw?.requestFingerprint) ??
    stringOrNull(raw?.cacheKey)
  );
}

/**
 * Validate an Apply Best Rate command and return the single atomic override patch.
 * The rate payload is returned verbatim under `bestRateJson` — the route canonicalizes
 * it (normalizeOrderBestRateDto) before persisting.
 */
export function buildApplyBestRatePatch(input: ApplyBestRateInput): ApplyBestRateResult {
  if (input.bestRateJson === undefined || input.bestRateJson === null) {
    return { ok: false, code: 'missing_rate', error: 'A best rate is required to apply.' };
  }
  const dims = parseDimsLabel(input.dimsLabel);
  if (!dims) {
    return { ok: false, code: 'missing_dims', error: 'Complete dimensions are required before applying a best rate.' };
  }
  if (input.selectedPid == null) {
    return { ok: false, code: 'missing_package', error: 'A selected package is required to apply a best rate.' };
  }
  const wanted = stringOrNull(input.currentRequestFingerprint ?? null);
  if (wanted) {
    const have = rateFingerprint(input.bestRateJson);
    if (have && have !== wanted) {
      return {
        ok: false,
        code: 'fingerprint_mismatch',
        error: 'The best rate was quoted against a different request; re-rate before applying.',
      };
    }
  }
  const patch: ApplyBestRatePatch = {
    bestRateJson: input.bestRateJson,
    bestRateDims: `${dims.l}x${dims.w}x${dims.h}`,
    selectedPid: input.selectedPid,
    rateDimsL: dims.l,
    rateDimsW: dims.w,
    rateDimsH: dims.h,
    ...(input.weightOz != null && input.weightOz > 0 ? { rateWeightOz: input.weightOz } : {}),
  };
  return { ok: true, patch };
}
