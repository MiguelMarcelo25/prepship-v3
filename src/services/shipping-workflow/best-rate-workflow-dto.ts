export type BestRateWorkflowState =
  | 'missing'
  | 'fresh'
  | 'stale'
  | 'mismatched_request'
  | 'partial_carrier_failure'
  | 'blocked'
  // PS-120: backend-owned in-progress states for the per-order rate job. 'pending' = queued for
  // backend backfill rating; 'rating' = the backfill job is actively rating it now. Both are bounded
  // by a watchdog in the FE classifier (bestRateStateAgeMs) so they can never become an infinite spinner.
  | 'pending'
  | 'rating'
  | 'unknown';

export type BestRateWorkflowSourceConfidence =
  | 'live'
  | 'cache_fresh'
  | 'cache_stale'
  | 'saved_override'
  | 'partial'
  | 'none';

export type BestRateWorkflowCarrierStatusValue =
  | 'live'
  | 'cached'
  | 'unavailable'
  | 'loading'
  | 'error'
  | 'blocked'
  | 'unknown';

export type BestRateWorkflowCarrierStatus = {
  carrierId: string;
  carrierName?: string | null;
  carrierCode?: string | null;
  nickname?: string | null;
  status: BestRateWorkflowCarrierStatusValue;
  rateCount: number;
  durationMs?: number;
  error?: string;
};

export type BestRateWorkflowAllowedActions = {
  canUseSavedRate: boolean;
  requiresRerate: boolean;
  canCreateLabel: boolean;
};

export type BestRateSelectedRateState = 'matches_best_rate' | 'mismatched_best_rate' | 'missing' | 'unknown';

// PS-196 — DISPLAY-ONLY classification of the saved best rate, deliberately separate from the
// purchase authority (allowedActions + the selected-rate proof asserts, which are unchanged):
//   'fresh'          proven + current → display AND purchase-authorized (canCreateLabel)
//   'stale'          proven but expired / fingerprint-mismatched → display as saved/stale; re-rate to buy
//   'saved_unproven' legacy saved rate: positive amount + carrier/service identity but missing the
//                    newer proof metadata (requestFingerprint/isComplete/cacheExpiresAt) → display
//                    as saved; NEVER purchase-authorized until re-rated with current proof
//   'none'           nothing displayable (no saved rate, or no usable display identity)
export type BestRateSavedRateDisplay = 'fresh' | 'stale' | 'saved_unproven' | 'none';

export type BestRateWorkflowDto = {
  bestRateState: BestRateWorkflowState;
  requestFingerprint: string | null;
  backendRequestKey: string | null;
  sourceConfidence: BestRateWorkflowSourceConfidence;
  carrierStatuses: BestRateWorkflowCarrierStatus[];
  selectedRateState?: BestRateSelectedRateState;
  allowedActions: BestRateWorkflowAllowedActions;
  // PS-120: age (ms) of a backend-owned in-progress state (pending/rating). Only present when
  // the orders payload OVERRODE bestRateState to pending/rating from the order_rate_jobs row.
  // The FE classifier uses it as a WATCHDOG so a stuck job can never be an infinite spinner.
  bestRateStateAgeMs?: number;
  // PS-196: display-only saved-rate verdict (see BestRateSavedRateDisplay). The FE renders the
  // saved rate immediately on reload when this is fresh/stale/saved_unproven; purchase authority
  // is UNCHANGED (allowedActions + backend proof asserts still require a current fresh rate).
  savedRateDisplay: BestRateSavedRateDisplay;
};

export type BuildBestRateWorkflowInput = {
  currentRequestFingerprint?: string | null;
  backendRequestKey?: string | null;
  savedBestRate?: unknown | null;
  selectedRateState?: BestRateSelectedRateState;
  source?: 'live' | 'cache' | 'saved_override' | 'none' | null;
  carrierStatuses?: BestRateWorkflowCarrierStatus[];
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function amountIsPositive(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  const amount = finiteNumberOrNull(rate.amount);
  if (amount != null) return amount > 0;
  const shipmentCost = finiteNumberOrNull(rate.shipmentCost) ?? finiteNumberOrNull(rate.cost) ?? 0;
  const otherCost = finiteNumberOrNull(rate.otherCost) ?? 0;
  return shipmentCost + otherCost > 0;
}

function savedRateFingerprint(rate: Record<string, unknown> | null): string | null {
  if (!rate) return null;
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

function savedRateIsComplete(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  if (rate.isComplete === true) return true;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  return metadata?.isComplete === true;
}

function savedRateExpiresAt(rate: Record<string, unknown> | null): string | null {
  if (!rate) return null;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  return stringOrNull(rate.cacheExpiresAt) ?? stringOrNull(metadata?.cacheExpiresAt);
}

function isFreshAt(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
}

/**
 * PS-111 — canonical owner of "is the best rate COMPLETE?" A best rate is complete
 * only when every eligible carrier reached a TERMINAL result (live / cached / empty
 * /unavailable / blocked) — never while a carrier is still `loading`, and never when
 * a carrier `error`ed. The backend stamps this onto the saved/returned best rate so
 * the frontend consumes it instead of asserting completeness itself. Empty input is
 * NOT complete (nothing was actually rated yet).
 */
export function isBestRateComplete(
  carrierStatuses: ReadonlyArray<Pick<BestRateWorkflowCarrierStatus, 'status'>> | null | undefined,
): boolean {
  if (!Array.isArray(carrierStatuses) || carrierStatuses.length === 0) return false;
  return carrierStatuses.every(
    (status) => status.status !== 'loading' && status.status !== 'error',
  );
}

function sanitizeCarrierStatus(status: BestRateWorkflowCarrierStatus): BestRateWorkflowCarrierStatus {
  const safeStatus: BestRateWorkflowCarrierStatusValue =
    status.status === 'live' ||
    status.status === 'cached' ||
    status.status === 'unavailable' ||
    status.status === 'loading' ||
    status.status === 'error' ||
    status.status === 'blocked' ||
    status.status === 'unknown'
      ? status.status
      : 'unknown';
  const rateCount = Number.isFinite(status.rateCount) ? Math.max(0, Math.trunc(status.rateCount)) : 0;
  const durationMs = Number.isFinite(status.durationMs) ? Math.max(0, Math.round(status.durationMs!)) : undefined;
  const error = stringOrNull(status.error);
  return {
    carrierId: String(status.carrierId ?? '').trim(),
    carrierName: status.carrierName ?? null,
    carrierCode: status.carrierCode ?? null,
    nickname: status.nickname ?? null,
    status: safeStatus,
    rateCount,
    ...(durationMs != null ? { durationMs } : {}),
    ...(error ? { error: error.slice(0, 160) } : {}),
  };
}

function sourceConfidenceFor(input: {
  state: BestRateWorkflowState;
  source: BuildBestRateWorkflowInput['source'];
}): BestRateWorkflowSourceConfidence {
  if (input.state === 'missing') return 'none';
  if (input.state === 'partial_carrier_failure') return 'partial';
  if (input.state === 'blocked') return input.source === 'none' ? 'none' : 'partial';
  if (input.state === 'stale') return 'cache_stale';
  if (input.state === 'fresh') {
    if (input.source === 'live') return 'live';
    if (input.source === 'cache') return 'cache_fresh';
    return 'saved_override';
  }
  if (input.state === 'mismatched_request') {
    return input.source === 'cache' ? 'cache_stale' : 'saved_override';
  }
  return input.source === 'cache' ? 'cache_stale' : input.source === 'live' ? 'live' : 'none';
}

function actionsFor(state: BestRateWorkflowState): BestRateWorkflowAllowedActions {
  const canUseSavedRate = state === 'fresh';
  return {
    canUseSavedRate,
    requiresRerate: state !== 'fresh',
    canCreateLabel: canUseSavedRate,
  };
}

// PS-196 — does the saved rate carry enough identity to RENDER (amount + carrier/service/account)?
// Tolerant of both the camelCase v2 shape and snake_case provider fields, matching what
// rates-backfill persists into order_overrides.best_rate_json across eras.
function savedRateHasDisplayIdentity(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  return Boolean(
    stringOrNull(rate.serviceCode) ??
      stringOrNull(rate.service_code) ??
      stringOrNull(rate.carrierCode) ??
      stringOrNull(rate.carrier_code) ??
      stringOrNull(rate.carrierNickname) ??
      stringOrNull(rate.carrier_nickname) ??
      stringOrNull(rate.providerAccountNickname) ??
      stringOrNull(rate.serviceName) ??
      stringOrNull(rate.service_type),
  );
}

/**
 * PS-196 — DISPLAY-ONLY verdict for the saved rate, decoupled from purchase authority.
 * 'fresh' mirrors the proven+current state; 'stale' = proven-but-expired/mismatched (display the
 * saved value, re-rate to buy); 'saved_unproven' = a legacy saved rate with a positive amount and
 * display identity but missing the newer proof metadata — display it instead of a spinner, but it
 * is NEVER purchase-authorized (allowedActions/proof asserts unchanged).
 */
function savedRateDisplayFor(
  state: BestRateWorkflowState,
  savedRate: Record<string, unknown> | null,
  hasSavedRate: boolean,
): BestRateSavedRateDisplay {
  if (!hasSavedRate || !savedRateHasDisplayIdentity(savedRate)) return 'none';
  if (state === 'fresh') return 'fresh';
  if (state === 'stale' || state === 'mismatched_request' || state === 'partial_carrier_failure') {
    return 'stale';
  }
  // 'unknown' is the legacy bucket: saved amount + identity, but no fingerprint/isComplete/expiry.
  if (state === 'unknown') return 'saved_unproven';
  // missing/blocked have no saved rate (hasSavedRate=false) — unreachable here; pending/rating are
  // reader-side overrides applied AFTER this builder runs.
  return 'none';
}

export function buildBestRateWorkflowDto(input: BuildBestRateWorkflowInput): BestRateWorkflowDto {
  const now = input.now ?? new Date();
  const savedRate = isRecord(input.savedBestRate) ? input.savedBestRate : null;
  const savedFingerprint = savedRateFingerprint(savedRate);
  const currentFingerprint = stringOrNull(input.currentRequestFingerprint) ?? savedFingerprint;
  const backendRequestKey = stringOrNull(input.backendRequestKey) ?? currentFingerprint;
  const carrierStatuses = (input.carrierStatuses ?? [])
    .map(sanitizeCarrierStatus)
    .filter((status) => status.carrierId);
  const hasCarrierFailure = carrierStatuses.some(
    (status) => status.status === 'error' || status.status === 'blocked',
  );
  const hasSavedRate = amountIsPositive(savedRate);
  const matchesRequest =
    Boolean(currentFingerprint && savedFingerprint && currentFingerprint === savedFingerprint) ||
    Boolean(savedFingerprint && !input.currentRequestFingerprint);
  const complete = savedRateIsComplete(savedRate);
  const fresh = isFreshAt(savedRateExpiresAt(savedRate), now);

  let bestRateState: BestRateWorkflowState;
  if (!hasSavedRate) {
    bestRateState = hasCarrierFailure ? 'blocked' : 'missing';
  } else if (currentFingerprint && savedFingerprint && currentFingerprint !== savedFingerprint) {
    bestRateState = 'mismatched_request';
  } else if (hasCarrierFailure) {
    bestRateState = 'partial_carrier_failure';
  } else if (matchesRequest && complete && fresh) {
    bestRateState = 'fresh';
  } else if (matchesRequest && complete && !fresh) {
    bestRateState = 'stale';
  } else {
    bestRateState = 'unknown';
  }

  return {
    bestRateState,
    requestFingerprint: currentFingerprint,
    backendRequestKey,
    sourceConfidence: sourceConfidenceFor({ state: bestRateState, source: input.source ?? null }),
    carrierStatuses,
    ...(input.selectedRateState ? { selectedRateState: input.selectedRateState } : {}),
    allowedActions: actionsFor(bestRateState),
    savedRateDisplay: savedRateDisplayFor(bestRateState, savedRate, hasSavedRate),
  };
}
