// PS-105 slice 2 — rate quote snapshot PERSISTENCE + purchase resolver.
//
// Per user override unlock shipped data on 2026-06-06.
//
// Backs the opaque rateQuoteId with the existing analytics_cache table (DB-enforced
// expiry, no migration). The rate path stores the snapshot keyed by the opaque id;
// the purchase boundary loads it and validates via the SAME strict proof validator.
//
// SAFETY: the unified resolver PREFERS the backend-owned snapshot but always falls
// back to the legacy carried selectedRateProof (which is itself strict). So when no
// rateQuoteId is supplied (today's frontend), purchase behavior is byte-identical to
// the legacy path — nothing can break — while the new path is never weaker.

import { getAnalyticsCache, setAnalyticsCache } from '../analytics-cache.js';
import {
  assertPurchaseAccountMatchesProof,
  assertSelectedRateProofForLabelPurchase,
  type SelectedRateProofInput,
} from './rate-fingerprint.js';
import {
  deriveRateQuoteId,
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  RATE_QUOTE_SNAPSHOT_TTL_MS,
  type RateQuoteSnapshot,
} from './rate-quote-snapshot.js';
import {
  rateProofEnforcementMode,
  recordRateProofCanary,
} from './rate-proof-enforcement.js';

// Re-export so route code can import all rate-quote helpers from one module.
export { selectedRateOpaqueKey } from './rate-quote-snapshot.js';

const RATE_QUOTE_SNAPSHOT_TTL_SECONDS = Math.floor(RATE_QUOTE_SNAPSHOT_TTL_MS / 1000);
const snapshotCacheKey = (rateQuoteId: string) => `rate_quote:${rateQuoteId}`;

/**
 * Persist a rate quote snapshot and return its opaque id. The id is derived from
 * the request fingerprint (rateCache key); the snapshot body holds every eligible
 * rate so the purchase boundary can resolve the operator's selection server-side.
 * Best-effort: a cache write failure returns the id but a later purchase simply
 * falls back to the legacy carried proof.
 */
export async function storeRateQuoteSnapshot(input: {
  cacheKey: string;
  rates: unknown[];
  fetchedAt?: string | number;
}): Promise<string | null> {
  const rateQuoteId = deriveRateQuoteId(input.cacheKey);
  if (!rateQuoteId) return null;
  const snapshot: RateQuoteSnapshot = {
    cacheKey: input.cacheKey,
    rates: Array.isArray(input.rates) ? input.rates : [],
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
  try {
    await setAnalyticsCache(snapshotCacheKey(rateQuoteId), snapshot, RATE_QUOTE_SNAPSHOT_TTL_SECONDS);
  } catch {
    /* best-effort: purchase falls back to legacy proof if the snapshot is absent */
  }
  return rateQuoteId;
}

/** Stamp each rate with its OPAQUE selection key so the frontend can pass back a selectedRateKey. */
export function withSelectedRateKeys<T extends Record<string, unknown>>(rates: T[]): Array<T & { selectedRateKey: string }> {
  return (Array.isArray(rates) ? rates : []).map((rate) => ({
    ...rate,
    selectedRateKey: selectedRateOpaqueKey(rate),
  }));
}

// PS-174: the single backend proof-source marker. The FE mirrors this value in
// web/src/lib/rate-proof.ts (BACKEND_RATE_PROOF_SOURCE) — it is an output tag the
// frontend passes back verbatim, never synthesizes.
export const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response';

/**
 * PS-174 (Phase 2) — finalize a rate result's BEST rate with the backend quote
 * snapshot ref + proof marker: the SAME stamping /rates/browse performs, packaged
 * for server-side persist paths (rates-backfill) so a saved best rate is
 * snapshot-purchasable WITHOUT a re-browse. Best-effort: if the snapshot id cannot
 * be derived/stored, the rate is returned with the selection key only (a half-ref
 * is ignored at the purchase boundary, which then uses the legacy proof path).
 * Purchase enforcement itself is untouched (Phase 4 territory).
 */
// PS-244: returns the SINGLE owner's full output — the stamped best rate, the key+quote-stamped
// rates array, and the top-level rateQuoteId — so EVERY producer (rates-backfill AND the live
// /rates/browse route) delegates here instead of re-stamping inline. selectedRateKey/rateQuoteId
// are byte-identical to the old inline stamping (shared pure fns); the best rate now also carries
// the backend-owned proofSource. The label-purchase ENFORCEMENT boundary is untouched.
export async function finalizeBestRateWithQuote<T extends Record<string, unknown>>(input: {
  bestRate: T;
  rates: Array<Record<string, unknown>>;
  cacheKey: string;
  fetchedAt?: string | number;
}): Promise<{
  bestRate: T & { selectedRateKey: string; rateQuoteId?: string; proofSource: string };
  rates: Array<Record<string, unknown> & { selectedRateKey: string; rateQuoteId?: string }>;
  rateQuoteId?: string;
}> {
  const ratesWithKeys = withSelectedRateKeys(input.rates);
  const rateQuoteId = await storeRateQuoteSnapshot({
    cacheKey: input.cacheKey,
    rates: ratesWithKeys,
    fetchedAt: input.fetchedAt,
  });
  // Stamp the opaque rateQuoteId onto each rate too (the FE passes back { rateQuoteId,
  // selectedRateKey } at label/queue time) — the same shape /rates/browse returned inline.
  const rates = rateQuoteId
    ? ratesWithKeys.map((rate) => ({ ...rate, rateQuoteId }))
    : ratesWithKeys;
  return {
    bestRate: {
      ...input.bestRate,
      selectedRateKey: selectedRateOpaqueKey(input.bestRate),
      ...(rateQuoteId ? { rateQuoteId } : {}),
      proofSource: BACKEND_RATE_PROOF_SOURCE,
    },
    rates,
    ...(rateQuoteId ? { rateQuoteId } : {}),
  };
}

export async function loadRateQuoteSnapshot(rateQuoteId: string | null | undefined): Promise<RateQuoteSnapshot | null> {
  const id = typeof rateQuoteId === 'string' ? rateQuoteId.trim() : '';
  if (!id) return null;
  return getAnalyticsCache<RateQuoteSnapshot>(snapshotCacheKey(id));
}

export type LabelPurchaseRateSelection = {
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
  selectedRateProof?: SelectedRateProofInput | null;
  // PS-204: the account the purchase payload will CHARGE. When present, the
  // validated proof rate must belong to the same account — the amount/proof
  // source and the purchase account source can never diverge again.
  purchaseShippingProviderId?: unknown;
};

/**
 * The single purchase-boundary check. PREFER the backend-owned snapshot id; on any
 * failure to resolve it, FALL BACK to the legacy carried proof (also strict). Throws
 * SelectedRateProofError before any provider call when neither yields a valid proof.
 * Never weaker than the legacy path; identical to legacy when no rateQuoteId is sent.
 *
 * PS-204: AFTER the proof validates, the proof rate's provider-account identity
 * must match the purchase payload's shippingProviderId (when both are present) —
 * on BOTH proof paths, snapshot-resolved and legacy carried. A stale selection
 * can never buy postage on a different account than the proven rate (the
 * order-1484 class: payload pid 10000025 with proof se-565377).
 *
 * PS-244 Phase 4 (Per user override unlock shipped data on 2026-06-15): the snapshot
 * ENFORCEMENT flip + canary. Every outcome is recorded (recordRateProofCanary) so we
 * can measure, in production, how often a supplied snapshot ref actually resolves at
 * purchase time vs. falls back to the FE-carried proof. The MODE gates the behavior:
 *   - 'canary' (DEFAULT): a snapshot ref that fails to resolve falls through to the
 *     legacy carried proof exactly as before — deployed behavior is unchanged.
 *   - 'strict' (env RATE_PROOF_ENFORCEMENT=strict, flipped only after the canary
 *     proves the snapshot resolves ~always): an unresolved ref BLOCKS the purchase via
 *     the SAME strict validator — no silent fallback to the FE proof.
 * FAIL-SAFE: strict reuses the existing strict validator (which throws on a missing
 * proof) and, in the impossible case it did not throw, still falls through to the
 * legacy validator below — so 'strict' is provably never weaker than 'canary'.
 */
export async function assertLabelPurchaseRateSelection(body: LabelPurchaseRateSelection): Promise<void> {
  if (body.rateQuoteId && body.selectedRateKey) {
    const snapshot = await loadRateQuoteSnapshot(body.rateQuoteId);
    const resolved = resolveRateQuoteForPurchase({ snapshot, selectedRateKey: body.selectedRateKey });
    if (resolved.ok) {
      recordRateProofCanary('snapshot_enforced');
      assertSelectedRateProofForLabelPurchase(resolved.proof); // final authority
      assertPurchaseAccountMatchesProof({
        purchaseShippingProviderId: body.purchaseShippingProviderId,
        selectedRate: resolved.proof.selectedRate,
      });
      return;
    }
    // PS-244 Phase 4: a snapshot ref was supplied but did NOT resolve. Record the
    // miss + reason — this is the event a strict flip would block. In 'strict' we
    // block it now via the SAME strict validator (a missing/invalid snapshot proof
    // throws before any provider call); in 'canary' (default) we fall through to the
    // legacy carried proof below, which itself throws if missing/invalid. Either way
    // no purchase proceeds without a valid proof.
    recordRateProofCanary('snapshot_fallback', resolved.reason);
    if (rateProofEnforcementMode() === 'strict') {
      assertSelectedRateProofForLabelPurchase(
        resolved.reason === 'snapshot_missing' ? null : { requestFingerprint: null },
      );
    }
  } else {
    recordRateProofCanary('legacy_only');
  }
  // FALL BACK to the legacy carried proof (also strict). Reached in 'canary' on an
  // unresolved ref, and on every request that carries no snapshot ref at all.
  assertSelectedRateProofForLabelPurchase(body.selectedRateProof ?? null);
  assertPurchaseAccountMatchesProof({
    purchaseShippingProviderId: body.purchaseShippingProviderId,
    selectedRate: body.selectedRateProof?.selectedRate,
  });
}
