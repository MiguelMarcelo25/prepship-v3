// Backend-owned rate quote snapshot persistence and strict purchase resolution.

import { getAnalyticsCache, setAnalyticsCache } from '../analytics-cache.js';
import {
  assertPurchaseAccountMatchesProof,
  assertSelectedRateProofForLabelPurchase,
  SelectedRateProofError,
  type SelectedRateProofInput,
} from './rate-fingerprint.js';
import {
  deriveRateQuoteId,
  RATE_QUOTE_SNAPSHOT_TTL_MS,
  RATE_QUOTE_STALE_MESSAGE,
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  type RateQuoteResolveFailure,
  type RateQuoteSnapshot,
} from './rate-quote-snapshot.js';
import { recordRateProofEnforcement } from './rate-proof-enforcement.js';

export { selectedRateOpaqueKey } from './rate-quote-snapshot.js';

const RATE_QUOTE_SNAPSHOT_TTL_SECONDS = Math.floor(RATE_QUOTE_SNAPSHOT_TTL_MS / 1000);
const snapshotCacheKey = (rateQuoteId: string) => `rate_quote:${rateQuoteId}`;

/** Persist a backend-owned quote. Failed writes return null, never a phantom id. */
export async function storeRateQuoteSnapshot(input: {
  cacheKey: string;
  rates: unknown[];
  bestRate?: unknown | null;
  bestRateComplete?: boolean | null;
  fetchedAt?: string | number;
}): Promise<string | null> {
  const rateQuoteId = deriveRateQuoteId(input.cacheKey);
  if (!rateQuoteId) return null;
  const snapshot: RateQuoteSnapshot = {
    cacheKey: input.cacheKey,
    rates: Array.isArray(input.rates) ? input.rates : [],
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    bestRateKey: input.bestRate ? selectedRateOpaqueKey(input.bestRate) : null,
    bestRateComplete: input.bestRateComplete === true,
  };
  try {
    await setAnalyticsCache(snapshotCacheKey(rateQuoteId), snapshot, RATE_QUOTE_SNAPSHOT_TTL_SECONDS);
    return rateQuoteId;
  } catch {
    return null;
  }
}

/** Stamp each displayed rate with its opaque backend selection key. */
export function withSelectedRateKeys<T extends Record<string, unknown>>(
  rates: T[],
): Array<T & { selectedRateKey: string }> {
  return (Array.isArray(rates) ? rates : []).map((rate) => ({
    ...rate,
    selectedRateKey: selectedRateOpaqueKey(rate),
  }));
}

export const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response';

/**
 * The single producer finalizer for live Rate Browser and saved Best Rate.
 * If snapshot persistence fails, rates remain displayable but carry no
 * purchase-authorizing rateQuoteId.
 */
export async function finalizeBestRateWithQuote<T extends Record<string, unknown>>(input: {
  bestRate: T;
  rates: Array<Record<string, unknown>>;
  cacheKey: string;
  bestRateComplete?: boolean | null;
  fetchedAt?: string | number;
}): Promise<{
  bestRate: T & {
    selectedRateKey: string;
    rateQuoteId?: string;
    proofSource: string;
    isComplete: boolean;
  };
  rates: Array<Record<string, unknown> & {
    selectedRateKey: string;
    rateQuoteId?: string;
    proofSource: string;
    isComplete: boolean;
  }>;
  rateQuoteId?: string;
}> {
  const ratesWithKeys = withSelectedRateKeys(input.rates);
  const isComplete = input.bestRateComplete === true;
  const rateQuoteId = await storeRateQuoteSnapshot({
    cacheKey: input.cacheKey,
    rates: ratesWithKeys,
    bestRate: input.bestRate,
    bestRateComplete: input.bestRateComplete,
    fetchedAt: input.fetchedAt,
  });
  const rates = rateQuoteId
    ? ratesWithKeys.map((rate) => ({
        ...rate,
        rateQuoteId,
        proofSource: BACKEND_RATE_PROOF_SOURCE,
        isComplete,
      }))
    : ratesWithKeys.map((rate) => ({
        ...rate,
        proofSource: BACKEND_RATE_PROOF_SOURCE,
        isComplete,
      }));
  return {
    bestRate: {
      ...input.bestRate,
      selectedRateKey: selectedRateOpaqueKey(input.bestRate),
      ...(rateQuoteId ? { rateQuoteId } : {}),
      proofSource: BACKEND_RATE_PROOF_SOURCE,
      isComplete,
    },
    rates,
    ...(rateQuoteId ? { rateQuoteId } : {}),
  };
}

export async function loadRateQuoteSnapshot(
  rateQuoteId: string | null | undefined,
): Promise<RateQuoteSnapshot | null> {
  const id = typeof rateQuoteId === 'string' ? rateQuoteId.trim() : '';
  if (!id) return null;
  return getAnalyticsCache<RateQuoteSnapshot>(snapshotCacheKey(id));
}

export type LabelPurchaseRateSelection = {
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
  /** @deprecated Transport compatibility only. Never authorizes purchase. */
  selectedRateProof?: SelectedRateProofInput | null;
  purchaseShippingProviderId?: unknown;
};

function throwStrictRateQuoteError(
  reason: RateQuoteResolveFailure | 'backend_rate_quote_required',
): never {
  const message = reason === 'snapshot_not_final'
    ? 'Rate shopping is still finalizing. Re-rate this order before creating the label.'
    : reason === 'backend_rate_quote_required'
      ? 'Backend rate proof is required. Re-rate this order before creating the label.'
      : RATE_QUOTE_STALE_MESSAGE;
  throw new SelectedRateProofError(message, {
    ok: false,
    reason,
    selectedAuthorityKey: null,
  });
}

/** Pure strict resolver used by tests and the async purchase boundary. */
export function assertRateQuoteSnapshotForLabelPurchase(input: {
  snapshot: RateQuoteSnapshot | null;
  selectedRateKey: string | null | undefined;
  purchaseShippingProviderId?: unknown;
}): SelectedRateProofInput {
  const selectedRateKey = typeof input.selectedRateKey === 'string'
    ? input.selectedRateKey.trim()
    : '';
  if (!selectedRateKey) throwStrictRateQuoteError('backend_rate_quote_required');

  const resolved = resolveRateQuoteForPurchase({
    snapshot: input.snapshot,
    selectedRateKey,
  });
  if (!resolved.ok) throwStrictRateQuoteError(resolved.reason);

  assertSelectedRateProofForLabelPurchase(resolved.proof);
  assertPurchaseAccountMatchesProof({
    purchaseShippingProviderId: input.purchaseShippingProviderId,
    selectedRate: resolved.proof.selectedRate,
  });
  return resolved.proof;
}

/**
 * The single purchase boundary. A backend rateQuoteId and selectedRateKey are
 * mandatory; frontend-carried proof is ignored and never authorizes postage.
 */
export async function assertLabelPurchaseRateSelection(
  body: LabelPurchaseRateSelection,
): Promise<void> {
  if (!(body.rateQuoteId && body.selectedRateKey)) {
    recordRateProofEnforcement('snapshot_reference_missing', 'backend_rate_quote_required');
    throwStrictRateQuoteError('backend_rate_quote_required');
  }

  let snapshot: RateQuoteSnapshot | null = null;
  try {
    snapshot = await loadRateQuoteSnapshot(body.rateQuoteId);
  } catch {
    snapshot = null;
  }

  try {
    assertRateQuoteSnapshotForLabelPurchase({
      snapshot,
      selectedRateKey: body.selectedRateKey,
      purchaseShippingProviderId: body.purchaseShippingProviderId,
    });
    recordRateProofEnforcement('snapshot_enforced');
  } catch (error) {
    const reason = error instanceof SelectedRateProofError
      ? error.details.reason
      : 'snapshot_missing';
    recordRateProofEnforcement('snapshot_rejected', reason);
    throw error;
  }
}
