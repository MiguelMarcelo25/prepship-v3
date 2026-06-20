// PS-105 — Backend-owned rate quote snapshot primitive.
//
// Per user override unlock shipped data on 2026-06-06: this is the SETUP/primitive
// phase of PS-105. It introduces an opaque, backend-owned `rateQuoteId` and the
// server-side resolution that turns (snapshot + selectedRateKey) into the SAME
// `SelectedRateProofInput` the purchase boundary already validates. It does NOT
// rewire any live label-purchase path yet — that is the enforcement slice. So this
// file changes ZERO runtime behavior on its own; it only adds primitives + types.
//
// Why a snapshot ID instead of a carried proof object:
//   The frontend currently has to carry `{ requestFingerprint, selectedRate,
//   eligibleRates }` through every route (Create Label, Print to Queue, batch
//   send, direct carrier, retry/recovery). PS-104 existed because /print-queue/
//   batch-send stripped that object. The opaque `rateQuoteId` lets the frontend
//   carry only an ID; the backend owns the proof internals.
//
// Safety: the FINAL authority remains `assertSelectedRateProofForLabelPurchase`
// (validateExactSelectedRate). This module reconstructs a proof from the snapshot
// and stamps the rate's fingerprint = the snapshot's cacheKey so the existing
// validator runs identically. No bypass/force flags. Missing/expired/mismatched
// snapshots produce NO proof → the caller must block with the re-rate message.

import { createHash } from 'node:crypto';
import {
  assertSelectedRateProofForLabelPurchase,
  SelectedRateProofError,
  selectedRateAuthorityKey,
  validateExactSelectedRate,
  type SelectedRateProofInput,
  type SelectedRateValidationResult,
} from './rate-fingerprint.js';

/** Short-lived snapshot freshness window (matches the saved best-rate cache TTL). */
export const RATE_QUOTE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/** Operator-facing message for any missing/expired/mismatched quote at purchase. */
export const RATE_QUOTE_STALE_MESSAGE =
  'Rate changed or expired. Re-rate this order before creating the label.';

export type RateQuoteSnapshot = {
  /** The backend rate-request fingerprint (rateCache PK). Server-only; not exposed. */
  cacheKey: string;
  /** All eligible rates quoted for this request (the snapshot content). */
  rates: unknown[];
  /** When the quote was fetched (ISO string or epoch ms). */
  fetchedAt: string | number | null;
  /** Opaque selectedRateKey for the finalized rank-1 best rate, when known. */
  bestRateKey?: string | null;
  /** True only when the required carrier universe completed for this quote. */
  bestRateComplete?: boolean | null;
};

export type ResolveRateQuoteResult =
  | { ok: true; proof: SelectedRateProofInput; selectedRateKey: string }
  | { ok: false; reason: RateQuoteResolveFailure };

export type RateQuoteResolveFailure =
  | 'snapshot_missing'
  | 'snapshot_expired'
  | 'selected_rate_not_in_snapshot'
  | 'snapshot_not_final'
  | 'selected_rate_not_best'
  | 'proof_invalid';

/**
 * Derive an OPAQUE, deterministic `rateQuoteId` from the snapshot cacheKey.
 * The cacheKey embeds destination zip/dims/account ids; the SHA-256 digest hides
 * all of it, so the ID carries no PII, secrets, provider payloads, or label URLs.
 * Deterministic so the same quote always yields the same id (idempotent lookups).
 */
export function deriveRateQuoteId(cacheKey: string | null | undefined): string | null {
  const key = typeof cacheKey === 'string' ? cacheKey.trim() : '';
  if (!key) return null;
  return `rq_${createHash('sha256').update(`rate-quote:${key}`).digest('hex').slice(0, 32)}`;
}

function fetchedAtMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function isRateQuoteSnapshotFresh(
  snapshot: Pick<RateQuoteSnapshot, 'fetchedAt'>,
  now: number = Date.now(),
  ttlMs: number = RATE_QUOTE_SNAPSHOT_TTL_MS,
): boolean {
  const ms = fetchedAtMs(snapshot.fetchedAt);
  if (ms == null) return false;
  return ms + ttlMs > now;
}

/**
 * The OPAQUE per-rate selection key sent to the frontend. The raw authority key
 * embeds a money digest (cost), so we hash it for transport — that hides the cost
 * from non-financial viewers (no redactRateMoneyFields bypass) while still
 * uniquely identifying the chosen rate within its snapshot. Deterministic.
 */
export function selectedRateOpaqueKey(rate: unknown): string {
  return `srk_${createHash('sha256').update(`rate-key:${selectedRateAuthorityKey(rate)}`).digest('hex').slice(0, 24)}`;
}

/** Find the snapshot rate whose OPAQUE selection key matches the operator's choice. */
export function findSnapshotRateByKey(
  snapshot: Pick<RateQuoteSnapshot, 'rates'>,
  selectedRateKey: string,
): Record<string, unknown> | null {
  const target = String(selectedRateKey ?? '').trim();
  if (!target || !Array.isArray(snapshot.rates)) return null;
  for (const rate of snapshot.rates) {
    if (selectedRateOpaqueKey(rate) === target) {
      return (rate && typeof rate === 'object' ? rate : {}) as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Reconstruct the SelectedRateProofInput the purchase boundary expects from a
 * snapshot + the operator's selected rate key. The chosen rate is stamped with
 * `requestFingerprint = cacheKey` so it is self-consistent with the existing
 * validator (backend owns the fingerprint — frontend never supplies it).
 */
export function buildSelectedRateProofFromSnapshot(
  snapshot: RateQuoteSnapshot,
  selectedRateKey: string,
): SelectedRateProofInput | null {
  const rate = findSnapshotRateByKey(snapshot, selectedRateKey);
  if (!rate) return null;
  const stampedRate = { ...rate, requestFingerprint: snapshot.cacheKey, cacheKey: snapshot.cacheKey };
  return {
    requestFingerprint: snapshot.cacheKey,
    selectedRate: stampedRate,
    eligibleRates: Array.isArray(snapshot.rates) ? snapshot.rates : [],
  };
}

/**
 * Resolve a (snapshot, selectedRateKey) into a validated proof for purchase.
 * Returns the reconstructed proof ONLY when the snapshot is fresh, the selected
 * rate exists, and the reconstructed proof passes the EXISTING strict validator.
 * Never returns a proof for a missing/expired/mismatched snapshot — the caller
 * must then block the purchase with RATE_QUOTE_STALE_MESSAGE.
 */
export function resolveRateQuoteForPurchase(input: {
  snapshot: RateQuoteSnapshot | null | undefined;
  selectedRateKey: string;
  now?: number;
  ttlMs?: number;
}): ResolveRateQuoteResult {
  const { snapshot, selectedRateKey } = input;
  if (!snapshot || !snapshot.cacheKey) return { ok: false, reason: 'snapshot_missing' };
  if (!isRateQuoteSnapshotFresh(snapshot, input.now ?? Date.now(), input.ttlMs)) {
    return { ok: false, reason: 'snapshot_expired' };
  }
  const proof = buildSelectedRateProofFromSnapshot(snapshot, selectedRateKey);
  if (!proof) return { ok: false, reason: 'selected_rate_not_in_snapshot' };
  if (snapshot.bestRateComplete === false) {
    return { ok: false, reason: 'snapshot_not_final' };
  }
  const bestRateKey = typeof snapshot.bestRateKey === 'string' ? snapshot.bestRateKey.trim() : '';
  if (snapshot.bestRateComplete === true && bestRateKey && String(selectedRateKey ?? '').trim() !== bestRateKey) {
    return { ok: false, reason: 'selected_rate_not_best' };
  }

  // Final authority: the reconstructed proof must pass the same strict check the
  // legacy carried-proof path uses. This guarantees the snapshot path can never
  // be a weaker boundary than today.
  const validation: SelectedRateValidationResult = validateExactSelectedRate({
    currentRequestFingerprint: proof.requestFingerprint,
    selectedRate: proof.selectedRate,
    eligibleRates: proof.eligibleRates,
  });
  if (!validation.ok) return { ok: false, reason: 'proof_invalid' };

  return { ok: true, proof, selectedRateKey: String(selectedRateKey).trim() };
}

/**
 * Convenience for the enforcement slice: resolve + assert in one call. Throws the
 * SAME SelectedRateProofError the carried-proof path throws when invalid, so the
 * purchase boundary behaves identically whether the proof arrived as a carried
 * object or via a backend-owned snapshot id.
 */
export function assertRateQuoteForLabelPurchase(input: {
  snapshot: RateQuoteSnapshot | null | undefined;
  selectedRateKey: string;
  now?: number;
  ttlMs?: number;
}): SelectedRateProofInput {
  const resolved = resolveRateQuoteForPurchase(input);
  if (!resolved.ok) {
    if (resolved.reason === 'snapshot_not_final' || resolved.reason === 'selected_rate_not_best') {
      throw new SelectedRateProofError(
        resolved.reason === 'snapshot_not_final'
          ? 'Rate shopping is still finalizing. Re-rate this order before creating the label.'
          : 'Selected rate is not the finalized Best Rate. Re-rate this order before creating the label.',
        {
          ok: false,
          reason: resolved.reason,
          selectedAuthorityKey: null,
        },
      );
    }
    // Reuse the canonical assertion so the thrown error type/shape matches the
    // legacy path. A missing/expired/mismatched snapshot yields no proof → the
    // assertion throws SelectedRateProofError (missing_*) before any provider call.
    assertSelectedRateProofForLabelPurchase(
      resolved.reason === 'snapshot_missing' ? null : { requestFingerprint: null },
    );
  }
  // assert above re-validates the (now self-consistent) proof as the final word.
  assertSelectedRateProofForLabelPurchase((resolved as { ok: true; proof: SelectedRateProofInput }).proof);
  return (resolved as { ok: true; proof: SelectedRateProofInput }).proof;
}
