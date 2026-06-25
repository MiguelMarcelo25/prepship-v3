// PS-317: pure Best-Rate proof/fingerprint helpers, moved verbatim out of OrdersView.
// PS-135: the proof logic lives in lib/rate-proof; these read the backend-issued proof and
// assemble the proof/quote-ref payloads for label/queue. The FE never mints a fingerprint.
import { toRecord, toStringValue, toNumberValue, getShippingModel } from '../../orders-row-display';
import {
  BACKEND_RATE_PROOF_SOURCE,
  hasBackendIssuedRateProof,
  rateProofFingerprint,
  selectProofFromCandidates,
  rateQuoteRefFromCandidates,
} from '../../../../lib/rate-proof';
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION } from '../../../../../../src/lib/shipping-service-eligibility';
import type { StrictBestRateRequest } from './rate-request';
import type { OrderSummaryDto } from '../../../../types/api';

export function getBackendRateResponseFingerprint(
  response: Record<string, unknown> | null | undefined,
  rate?: Record<string, unknown> | null,
) {
  const workflow = toRecord(response?.bestRateWorkflow);
  const rateFingerprint = hasBackendIssuedRateProof(rate ?? null) ? rateProofFingerprint(rate ?? null) : null;
  return (
    toStringValue(response?.requestFingerprint) ??
    toStringValue(response?.cacheKey) ??
    toStringValue(response?.requestKey) ??
    toStringValue(workflow?.requestFingerprint) ??
    toStringValue(workflow?.backendRequestKey) ??
    rateFingerprint
  );
}

export function withRateRequestMetadata(
  rate: Record<string, unknown>,
  request: StrictBestRateRequest,
  metadata: Record<string, unknown> = {},
) {
  const backendRequestFingerprint = getBackendRateResponseFingerprint(metadata, rate);
  const {
    requestFingerprint: _requestFingerprint,
    rateRequestFingerprint: _rateRequestFingerprint,
    cacheKey: _cacheKey,
    proofSource: _proofSource,
    ...rateWithoutProof
  } = rate;
  const createdAt = toStringValue(metadata.cacheCreatedAt) ?? new Date().toISOString();
  // PS-183: the freshness window is BACKEND-owned. Prefer the explicit metadata value, then the
  // rate's backend-stamped expiry. If neither is present, show no expiry (the FE never mints one).
  const backendExpiresAt =
    toStringValue(metadata.cacheExpiresAt) ?? toStringValue(rate.cacheExpiresAt);
  if (!backendExpiresAt) {
    console.warn('[orders] backend rate carried no cacheExpiresAt — showing no display expiry (PS-183: the FE no longer mints a local fallback window)');
  }
  const expiresAt = backendExpiresAt ?? null;
  const metadataComplete =
    typeof metadata.isComplete === 'boolean'
      ? metadata.isComplete
      : typeof rate.isComplete === 'boolean'
        ? rate.isComplete
        : false;
  return {
    ...rateWithoutProof,
    ...(backendRequestFingerprint
      ? {
        requestFingerprint: backendRequestFingerprint,
        cacheKey: backendRequestFingerprint,
        proofSource: BACKEND_RATE_PROOF_SOURCE,
      }
      : {}),
    clientRequestKey: request.key,
    cacheCreatedAt: createdAt,
    cacheExpiresAt: expiresAt,
    confirmation: request.confirmation,
    // PS-123: backend effective insurance is authoritative. The request fallback is only for
    // old/test responses that do not stamp backend workflow metadata.
    insuranceProvider:
      toStringValue(metadata.effectiveInsuranceProvider) ??
      toStringValue(metadata.insuranceProvider) ??
      toStringValue(rateWithoutProof.effectiveInsuranceProvider) ??
      toStringValue(rateWithoutProof.insuranceProvider) ??
      request.insuranceProvider ??
      'none',
    insuredValue:
      toNumberValue(metadata.effectiveInsuredValue) ??
      toNumberValue(metadata.insuredValue) ??
      toNumberValue(rateWithoutProof.effectiveInsuredValue) ??
      toNumberValue(rateWithoutProof.insuredValue) ??
      request.insuredValue ??
      null,
    eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
    isComplete: metadataComplete,
    rateCount: toNumberValue(metadata.rateCount) ?? 1,
    matchType: toStringValue(metadata.matchType) ?? 'live',
  };
}

export function getSavedBestRateRecord(order: OrderSummaryDto) {
  return (
    toRecord(order.bestRate) ??
    toRecord(getShippingModel(order)?.bestRate) ??
    toRecord(toRecord(order.overrides)?.bestRateJson)
  );
}

// PS-204: optional forShippingProviderId filters the candidates to the account the payload
// charges — cross-account proofs are excluded at the source (rate-proof.ts owns the rule).
export function buildSelectedRateProofPayload(order: OrderSummaryDto, candidate?: unknown, forShippingProviderId?: unknown) {
  return selectProofFromCandidates([
    toRecord(candidate),
    toRecord(order.bestRate),
    toRecord(order.selectedRate),
    getSavedBestRateRecord(order),
  ], { forShippingProviderId });
}

// PS-105/PS-135: backend-owned rate-quote ref for label/queue payloads — mirrors the proof
// candidate selection so id/key match the proof's rate.
export function buildRateQuoteRefForOrder(order: OrderSummaryDto, candidate?: unknown, forShippingProviderId?: unknown): { rateQuoteId?: string; selectedRateKey?: string } {
  return rateQuoteRefFromCandidates([
    toRecord(candidate),
    toRecord(order.bestRate),
    toRecord(order.selectedRate),
    getSavedBestRateRecord(order),
  ], { forShippingProviderId });
}

export function getRateBaseAmount(rate: Record<string, unknown>) {
  const shipmentCost = toNumberValue(rate.shipmentCost) ?? toNumberValue(rate.amount) ?? 0;
  const otherCost = toNumberValue(rate.otherCost) ?? 0;
  const total = shipmentCost + otherCost;
  return total > 0 ? total : shipmentCost;
}
