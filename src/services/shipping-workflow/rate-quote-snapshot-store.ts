// Backend-owned rate quote snapshot persistence and strict purchase resolution.

import { getAnalyticsCacheOrThrow, setAnalyticsCacheOrThrow } from '../analytics-cache.js';
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
import {
  createShippingQuoteSelectionRef,
  parseShippingQuoteSelectionRef,
  shippingProviderIdFromAuthorizedRate,
  ShippingQuoteAuthorizationError,
  shippingQuoteSnapshotIdentityKey,
  type ShippingQuoteAccountAuthorization,
  type ShippingQuoteAuthorizationContext,
} from './shipping-quote-authorization.js';

export { selectedRateOpaqueKey } from './rate-quote-snapshot.js';

const RATE_QUOTE_SNAPSHOT_TTL_SECONDS = Math.floor(RATE_QUOTE_SNAPSHOT_TTL_MS / 1000);
const snapshotCacheKey = (rateQuoteId: string) => `rate_quote:${rateQuoteId}`;

export class RateProofValidationUnavailableError extends Error {
  readonly code = 'RATE_PROOF_VALIDATION_UNAVAILABLE' as const;
  constructor() {
    super('Selected-rate proof validation is temporarily unavailable. Retry later.');
    this.name = 'RateProofValidationUnavailableError';
  }
}

/** Persist a backend-owned quote. Failed writes return null, never a phantom id. */
export async function storeRateQuoteSnapshot(input: {
  cacheKey: string;
  rates: unknown[];
  bestRate?: unknown | null;
  bestRateComplete?: boolean | null;
  fetchedAt?: string | number;
  authorization?: {
    context: ShippingQuoteAuthorizationContext;
    accounts: ShippingQuoteAccountAuthorization[];
  } | null;
}): Promise<string | null> {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const rateQuoteId = deriveRateQuoteId(shippingQuoteSnapshotIdentityKey({
    rateCacheKey: input.cacheKey,
    authorization: input.authorization,
    rates: input.rates,
    fetchedAt,
  }));
  if (!rateQuoteId) return null;
  const snapshot: RateQuoteSnapshot = {
    cacheKey: input.cacheKey,
    rates: Array.isArray(input.rates) ? input.rates : [],
    fetchedAt,
    bestRateKey: input.bestRate ? selectedRateOpaqueKey(input.bestRate) : null,
    bestRateComplete: input.bestRateComplete === true,
    authorization: input.authorization ?? null,
  };
  try {
    await setAnalyticsCacheOrThrow(snapshotCacheKey(rateQuoteId), snapshot, RATE_QUOTE_SNAPSHOT_TTL_SECONDS);
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
 * purchase-authorizing selectionRef.
 */
export async function finalizeBestRateWithQuote<T extends Record<string, unknown>>(input: {
  bestRate: T;
  rates: Array<Record<string, unknown>>;
  cacheKey: string;
  bestRateComplete?: boolean | null;
  fetchedAt?: string | number;
  /** Cached rates are planning/display truth only and cannot authorize postage. */
  purchaseProofEligible?: boolean;
  authorization?: {
    context: ShippingQuoteAuthorizationContext;
    accounts: ShippingQuoteAccountAuthorization[];
  } | null;
}): Promise<{
  bestRate: T & {
    selectedRateKey: string;
    rateQuoteId?: string;
    selectionRef?: string;
    proofSource: string;
    isComplete: boolean;
  };
  rates: Array<Record<string, unknown> & {
    selectedRateKey: string;
    rateQuoteId?: string;
    selectionRef?: string;
    proofSource: string;
    isComplete: boolean;
  }>;
  rateQuoteId?: string;
}> {
  const ratesWithKeys = withSelectedRateKeys(input.rates);
  const isComplete = input.bestRateComplete === true;
  const rateQuoteId = input.purchaseProofEligible === false
    ? null
    : await storeRateQuoteSnapshot({
        cacheKey: input.cacheKey,
        rates: ratesWithKeys,
        bestRate: input.bestRate,
        bestRateComplete: input.bestRateComplete,
        fetchedAt: input.fetchedAt,
        authorization: input.authorization,
      });
  const selectionRefFor = (rate: Record<string, unknown> & { selectedRateKey: string }): string | null => {
    if (!rateQuoteId || !input.authorization) return null;
    const providerId = shippingProviderIdFromAuthorizedRate(rate);
    if (
      providerId == null
      || !input.authorization.accounts.some((account) => account.shippingProviderId === providerId)
    ) {
      return null;
    }
    return createShippingQuoteSelectionRef(rateQuoteId, rate.selectedRateKey);
  };
  const rates = rateQuoteId
    ? ratesWithKeys.map((rate) => {
        const selectionRef = selectionRefFor(rate);
        return {
        ...rate,
        rateQuoteId,
        ...(selectionRef ? { selectionRef } : {}),
        proofSource: BACKEND_RATE_PROOF_SOURCE,
        isComplete,
        };
      })
    : ratesWithKeys.map((rate) => ({
        ...rate,
        proofSource: BACKEND_RATE_PROOF_SOURCE,
        isComplete,
      }));
  const bestRateSelectedKey = selectedRateOpaqueKey(input.bestRate);
  const bestRateSelectionRef = selectionRefFor({
    ...input.bestRate,
    selectedRateKey: bestRateSelectedKey,
  });
  return {
    bestRate: {
      ...input.bestRate,
      selectedRateKey: bestRateSelectedKey,
      ...(rateQuoteId ? { rateQuoteId } : {}),
      ...(bestRateSelectionRef ? { selectionRef: bestRateSelectionRef } : {}),
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
  return getAnalyticsCacheOrThrow<RateQuoteSnapshot>(snapshotCacheKey(id));
}

export type LabelPurchaseRateSelection = {
  selectionRef?: string | null;
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
  /** @deprecated Transport compatibility only. Never authorizes purchase. */
  selectedRateProof?: SelectedRateProofInput | null;
  purchaseShippingProviderId?: unknown;
};

export type AuthorizedLabelPurchaseRateSelection = Omit<SelectedRateProofInput, 'selectedRate'> & {
  selectedRate: unknown;
  selectionRef: string;
  rateQuoteId: string;
  selectedRateKey: string;
  authorizationContext: ShippingQuoteAuthorizationContext;
  accountAuthorization: ShippingQuoteAccountAuthorization;
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
 * The single purchase boundary. A backend-minted selectionRef is mandatory;
 * frontend-carried quote ids, keys, and proof never authorize postage.
 */
export async function assertLabelPurchaseRateSelection(
  body: LabelPurchaseRateSelection,
): Promise<AuthorizedLabelPurchaseRateSelection> {
  const ref = parseShippingQuoteSelectionRef(body.selectionRef);
  if (!ref) {
    recordRateProofEnforcement('snapshot_reference_missing', 'backend_rate_quote_required');
    throwStrictRateQuoteError('backend_rate_quote_required');
  }

  let snapshot: RateQuoteSnapshot | null = null;
  try {
    snapshot = await loadRateQuoteSnapshot(ref.rateQuoteId);
  } catch {
    throw new RateProofValidationUnavailableError();
  }

  try {
    const proof = assertRateQuoteSnapshotForLabelPurchase({
      snapshot,
      selectedRateKey: ref.selectedRateKey,
    });
    const authorization = snapshot?.authorization;
    const providerId = shippingProviderIdFromAuthorizedRate(proof.selectedRate);
    const accountAuthorization = providerId == null
      ? null
      : authorization?.accounts.find((account) => account.shippingProviderId === providerId) ?? null;
    if (!authorization?.context || !accountAuthorization) {
      throw new ShippingQuoteAuthorizationError('order or carrier credential identity');
    }
    recordRateProofEnforcement('snapshot_enforced');
    return {
      ...proof,
      selectedRate: proof.selectedRate,
      selectionRef: body.selectionRef!.trim(),
      rateQuoteId: ref.rateQuoteId,
      selectedRateKey: ref.selectedRateKey,
      authorizationContext: authorization.context,
      accountAuthorization,
    };
  } catch (error) {
    const reason = error instanceof SelectedRateProofError
      ? error.details.reason
      : 'snapshot_missing';
    recordRateProofEnforcement('snapshot_rejected', reason);
    throw error;
  }
}
