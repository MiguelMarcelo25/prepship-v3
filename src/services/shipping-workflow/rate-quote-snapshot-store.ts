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

import { getAnalyticsCache, setAnalyticsCache } from '../analytics-cache';
import {
  assertSelectedRateProofForLabelPurchase,
  type SelectedRateProofInput,
} from './rate-fingerprint';
import {
  deriveRateQuoteId,
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  RATE_QUOTE_SNAPSHOT_TTL_MS,
  type RateQuoteSnapshot,
} from './rate-quote-snapshot';

// Re-export so route code can import all rate-quote helpers from one module.
export { selectedRateOpaqueKey } from './rate-quote-snapshot';

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

export async function loadRateQuoteSnapshot(rateQuoteId: string | null | undefined): Promise<RateQuoteSnapshot | null> {
  const id = typeof rateQuoteId === 'string' ? rateQuoteId.trim() : '';
  if (!id) return null;
  return getAnalyticsCache<RateQuoteSnapshot>(snapshotCacheKey(id));
}

export type LabelPurchaseRateSelection = {
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
  selectedRateProof?: SelectedRateProofInput | null;
};

/**
 * The single purchase-boundary check. PREFER the backend-owned snapshot id; on any
 * failure to resolve it, FALL BACK to the legacy carried proof (also strict). Throws
 * SelectedRateProofError before any provider call when neither yields a valid proof.
 * Never weaker than the legacy path; identical to legacy when no rateQuoteId is sent.
 */
export async function assertLabelPurchaseRateSelection(body: LabelPurchaseRateSelection): Promise<void> {
  if (body.rateQuoteId && body.selectedRateKey) {
    const snapshot = await loadRateQuoteSnapshot(body.rateQuoteId);
    const resolved = resolveRateQuoteForPurchase({ snapshot, selectedRateKey: body.selectedRateKey });
    if (resolved.ok) {
      assertSelectedRateProofForLabelPurchase(resolved.proof); // final authority
      return;
    }
    // snapshot missing/expired/mismatched -> fall through to the legacy proof, which
    // throws if it too is missing/invalid. Never silently proceeds.
  }
  assertSelectedRateProofForLabelPurchase(body.selectedRateProof ?? null);
}
