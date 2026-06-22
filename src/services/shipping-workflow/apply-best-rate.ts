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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDimsLabel(value: string | null): { l: number; w: number; h: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().toLowerCase().split('x').map((p) => Number(p.trim()));
  if (parts.length !== 3) return null;
  const [l, w, h] = parts;
  if (![l, w, h].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  return { l: l!, w: w!, h: h! };
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
