import { readRateInsuranceCertaintyState } from './rate-insurance-certainty-key.js';

export type ShippingRateRequestFingerprintInput = {
  version: string;
  shipDateBucket: string;
  weightOz: number;
  toZip: string;
  toCountry?: string | null;
  toState?: string | null;
  toCity?: string | null;
  residential?: boolean | null;
  clientId?: number | null;
  storeId?: number | null;
  sourceClientId?: number | null;
  apiKeyFingerprint?: string | null;
  dimsL?: number | null;
  dimsW?: number | null;
  dimsH?: number | null;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  carrierIds?: string[] | null;
  automationRulesVersion?: string | null;
  // Audit C4 (2026-07-13): ship-from ORIGIN. PS-291 made origin operator-selectable
  // and origin genuinely changes carrier quotes, but the fingerprint never modeled it
  // — so a custom-origin browse wrote rate_cache rows that default-origin order rating
  // then read as truth (cross-origin poisoning, reachable all the way to purchasable
  // proof), and two concurrent requests differing only in origin shared one in-flight
  // HTTP dedupe slot. Populated ONLY when the request carries an explicit ship-from;
  // absent means "account default origin", which keeps every default-flow fingerprint
  // byte-identical to before (no saved-proof churn from this change).
  shipFromZip?: string | null;
  shipFromCountry?: string | null;
  // PS-274: OPTIONAL insurance-CERTAINTY state (e.g. 'requested_application_uncertain'
  // vs 'explicitly_included'). When present it binds the certainty verdict into the
  // fingerprint so an uncertain Shipp rate survives save/purchase and can never
  // round-trip as proven-insured. Absent -> fingerprint is byte-identical to before.
  insuranceCertainty?: string | null;
};

export type ShippingRateCurrentFacts = {
  weightOz?: number | string | null;
  toZip?: string | null;
  toCountry?: string | null;
  toState?: string | null;
  toCity?: string | null;
  residential?: boolean | null;
  dimsL?: number | string | null;
  dimsW?: number | string | null;
  dimsH?: number | string | null;
};

export type SelectedRateValidationReason =
  | 'ok'
  | 'missing_selected_rate'
  | 'missing_current_fingerprint'
  | 'missing_fingerprint'
  | 'fingerprint_mismatch'
  | 'not_in_current_eligible_rates'
  | 'snapshot_not_final'
  | 'backend_rate_quote_required'
  | 'snapshot_missing'
  | 'snapshot_expired'
  | 'selected_rate_not_in_snapshot'
  | 'proof_invalid'
  // PS-204: the purchase payload names one carrier account while the validated
  // proof rate belongs to a different one (the order-1484 class: payload
  // shippingProviderId=10000025 with proof carrier_id=se-565377).
  | 'purchase_account_mismatch';

export type SelectedRateValidationResult =
  | {
      ok: true;
      reason: 'ok';
      selectedAuthorityKey: string;
    }
  | {
      ok: false;
      reason: Exclude<SelectedRateValidationReason, 'ok'>;
      selectedAuthorityKey: string | null;
    };

export class SelectedRateProofError extends Error {
  code = 'SELECTED_RATE_PROOF_INVALID';
  details: SelectedRateValidationResult;

  constructor(message: string, details: SelectedRateValidationResult) {
    super(message);
    this.name = 'SelectedRateProofError';
    this.details = details;
  }
}

export type SelectedRateProofInput = {
  requestFingerprint?: string | null;
  selectedRate?: unknown;
  eligibleRates?: unknown[] | null;
};

// PS-126: the canonical rate fingerprint must distinguish ZIP+4 from ZIP5 so a saved
// ZIP5 rate cannot masquerade as a current exact-ZIP+4 rate. US -> "11364-2081" (or
// "11364" when no +4); non-US -> trimmed/uppercased (never truncated to 5). A ZIP5-only
// order is unchanged (z=11364), so it does not force re-rate churn.
function normalizeZip(zip: string, country?: string | null): string {
  const raw = String(zip ?? '').trim();
  if (!raw) return '';
  const cc = String(country ?? 'US').trim().toUpperCase();
  if (cc && cc !== 'US' && cc !== 'USA') return raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  if (digits.length >= 5) return digits.slice(0, 5);
  return digits || raw.toUpperCase();
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function moneyKey(value: unknown): string {
  const n = finiteNumber(value ?? 0) ?? 0;
  return n.toFixed(4);
}

function fingerprintPartValue(fingerprint: string, key: string): string | null {
  const prefix = `${key}=`;
  const part = fingerprint.split('|').find((candidate) => candidate.startsWith(prefix));
  return part ? part.slice(prefix.length) : null;
}

function scaledPositiveKey(value: unknown): string | null {
  const n = finiteNumber(value);
  return n != null && n > 0 ? String(Math.round(n * 10)) : null;
}

function normalizedCityKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.toLowerCase().replace(/\s+/g, '-') : null;
}

function normalizedCountryKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function providerAccountKey(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = text.match(/^se-(\d+)$/i);
  if (match?.[1]) return match[1];
  const n = finiteNumber(text);
  return n != null ? String(Math.trunc(n)) : textKey(text);
}

function nestedAmount(rate: Record<string, unknown>, key: string): unknown {
  const amount = record(rate[key]);
  return amount?.amount;
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function comparableRateFactsFingerprint(fingerprint: string): string {
  // Legacy combined Browse Rates keys used ":direct:" after the base fingerprint.
  // Strip that suffix before comparing package/address facts.
  const legacyDirectSuffix = fingerprint.indexOf(':direct:');
  return legacyDirectSuffix >= 0 ? fingerprint.slice(0, legacyDirectSuffix) : fingerprint;
}

export function buildShippingRateRequestFingerprint(input: ShippingRateRequestFingerprintInput): string {
  const parts: string[] = [
    `v=${input.version}`,
    `d=${input.shipDateBucket}`,
    `w=${Math.round(input.weightOz * 10)}`,
    `z=${normalizeZip(input.toZip, input.toCountry)}`,
    `co=${(input.toCountry ?? 'US').toUpperCase()}`,
  ];
  if (input.toState) parts.push(`st=${input.toState.trim().toUpperCase()}`);
  if (input.toCity) parts.push(`ci=${input.toCity.trim().toLowerCase().replace(/\s+/g, '-')}`);
  // Audit C4: explicit ship-from origin binds into the identity; absent = default origin.
  if (input.shipFromZip) {
    parts.push(`sf=${normalizeZip(input.shipFromZip, input.shipFromCountry)}`);
    const sfCountry = (input.shipFromCountry ?? 'US').trim().toUpperCase();
    if (sfCountry && sfCountry !== 'US') parts.push(`sfc=${sfCountry}`);
  }
  if (input.residential === true) parts.push('r=1');
  else if (input.residential === false) parts.push('r=0');
  if (input.clientId != null) parts.push(`cl=${input.clientId}`);
  else if (input.storeId != null) parts.push(`st=${input.storeId}`);
  if (input.sourceClientId != null) parts.push(`src=${input.sourceClientId}`);
  else if (input.apiKeyFingerprint) parts.push(`ak=${input.apiKeyFingerprint}`);
  if (input.dimsL) parts.push(`l=${Math.round(input.dimsL * 10)}`);
  if (input.dimsW) parts.push(`dw=${Math.round(input.dimsW * 10)}`);
  if (input.dimsH) parts.push(`h=${Math.round(input.dimsH * 10)}`);
  if (input.confirmation) parts.push(`cf=${input.confirmation}`);
  if (input.insuranceProvider && input.insuranceProvider !== 'none') {
    parts.push(`ip=${input.insuranceProvider}`);
    parts.push(`iv=${Math.round((input.insuredValue ?? 0) * 100)}`);
  }
  if (Array.isArray(input.carrierIds)) {
    parts.push(`c=${[...input.carrierIds].sort().join(',')}`);
  }
  if (input.automationRulesVersion) parts.push(`ar=${input.automationRulesVersion}`);
  // PS-274: bind the insurance-certainty verdict ONLY when one is supplied — keeps
  // the fingerprint byte-identical for every legacy/non-Shipp caller (additive).
  const certaintyState = textKey(input.insuranceCertainty);
  if (certaintyState) parts.push(`ic=${certaintyState}`);
  return parts.join('|');
}

/**
 * PS-333: saved rate snapshots may display as final only when their request
 * fingerprint still matches the current backend package/address facts. This
 * helper compares only facts the caller can supply from its current source of
 * truth; absent fact fields are ignored, but a supplied fact must be present in
 * the fingerprint and equal.
 */
export function shippingRateFingerprintMatchesCurrentFacts(
  fingerprint: string | null | undefined,
  facts: ShippingRateCurrentFacts | null | undefined,
): boolean {
  const fp = comparableRateFactsFingerprint(typeof fingerprint === 'string' ? fingerprint.trim() : '');
  if (!fp || !facts) return true;

  const comparisons: Array<[string, string | null]> = [
    ['w', scaledPositiveKey(facts.weightOz)],
    ['l', scaledPositiveKey(facts.dimsL)],
    ['dw', scaledPositiveKey(facts.dimsW)],
    ['h', scaledPositiveKey(facts.dimsH)],
  ];
  for (const [key, expected] of comparisons) {
    if (expected != null && fingerprintPartValue(fp, key) !== expected) return false;
  }

  const country = normalizedCountryKey(facts.toCountry) ?? 'US';
  if (facts.toZip != null && String(facts.toZip).trim()) {
    const expectedZip = normalizeZip(String(facts.toZip), country);
    if (fingerprintPartValue(fp, 'z') !== expectedZip) return false;
  }
  if (facts.toCountry != null && String(facts.toCountry).trim()) {
    if (fingerprintPartValue(fp, 'co') !== country) return false;
  }
  if (facts.toState != null && String(facts.toState).trim()) {
    const statePart = fingerprintPartValue(fp, 'st');
    const expectedState = String(facts.toState).trim().toUpperCase();
    if (statePart != null && /^[A-Z]{2,3}$/.test(statePart) && statePart !== expectedState) return false;
  }
  const city = normalizedCityKey(facts.toCity);
  const cityPart = fingerprintPartValue(fp, 'ci');
  if (city != null && cityPart != null && cityPart !== city) return false;
  if (facts.residential === true && fingerprintPartValue(fp, 'r') !== '1') return false;
  if (facts.residential === false && fingerprintPartValue(fp, 'r') !== '0') return false;

  return true;
}

// PS-127: extract the residential bit a rate was quoted under from its request
// fingerprint (`r=1`/`r=0`). Returns null when the fingerprint omits it (older rate or
// unknown residential). Used at the label-purchase boundary to detect a rate↔label
// residential mismatch before spending postage.
export function residentialFromRequestFingerprint(fingerprint: string | null | undefined): boolean | null {
  const fp = comparableRateFactsFingerprint(typeof fingerprint === 'string' ? fingerprint : '');
  if (!fp) return null;
  for (const part of fp.split('|')) {
    if (part === 'r=1') return true;
    if (part === 'r=0') return false;
  }
  return null;
}

export function selectedRateRequestFingerprint(rate: unknown): string | null {
  const row = record(rate);
  if (!row) return null;
  const raw = record(row.raw);
  const metadata = record(row.metadata);
  const value = firstPresent(
    row.requestFingerprint,
    row.rateRequestFingerprint,
    row.cacheKey,
    metadata?.requestFingerprint,
    metadata?.cacheKey,
    raw?.requestFingerprint,
    raw?.cacheKey,
  );
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function selectedRateAuthorityKey(rate: unknown): string {
  const row = record(rate) ?? {};
  const raw = record(row.raw) ?? {};
  const provider = providerAccountKey(firstPresent(
    row.shippingProviderId,
    row.providerAccountId,
    row.shipping_provider_id,
    row.carrier_id,
    row.carrierId,
    raw.shippingProviderId,
    raw.providerAccountId,
    raw.carrier_id,
  ));
  const carrier = textKey(firstPresent(row.carrierCode, row.carrier_code, raw.carrierCode, raw.carrier_code));
  const service = textKey(firstPresent(row.serviceCode, row.service_code, raw.serviceCode, raw.service_code, row.serviceName, raw.service_type));
  const packageKey = textKey(firstPresent(row.packageCode, row.package_type, raw.packageCode, raw.package_type));
  const shipmentCost = firstPresent(
    row.shipmentCost,
    row.cost,
    nestedAmount(row, 'shipping_amount'),
    nestedAmount(raw, 'shipping_amount'),
  );
  const otherCost = firstPresent(
    row.otherCost,
    nestedAmount(row, 'other_amount'),
    nestedAmount(raw, 'other_amount'),
    0,
  );
  const confirmationCost = firstPresent(
    nestedAmount(row, 'confirmation_amount'),
    nestedAmount(raw, 'confirmation_amount'),
    0,
  );
  const insuranceCost = firstPresent(
    nestedAmount(row, 'insurance_amount'),
    nestedAmount(raw, 'insurance_amount'),
    0,
  );
  const parts = [
    provider,
    carrier,
    service,
    packageKey,
    moneyKey(shipmentCost),
    moneyKey(otherCost),
    moneyKey(confirmationCost),
    moneyKey(insuranceCost),
  ];
  // PS-274: bind the stamped insurance-certainty STATE into the authority key ONLY
  // when the rate carries one. This is what makes an uncertain Shipp rate fail to
  // round-trip as proven-insured: its key holds 'requested_application_uncertain',
  // which an eligible rate claiming 'explicitly_included' cannot match. Absent ->
  // byte-identical to the pre-PS-274 key (legacy/non-Shipp rows unchanged).
  const certaintyState =
    readRateInsuranceCertaintyState(row) || readRateInsuranceCertaintyState(raw);
  if (certaintyState) parts.push(`ic=${certaintyState}`);
  return parts.join('|');
}

export function validateExactSelectedRate(input: {
  currentRequestFingerprint: string | null | undefined;
  selectedRate: unknown;
  eligibleRates?: unknown[] | null;
}): SelectedRateValidationResult {
  if (!input.currentRequestFingerprint) {
    return { ok: false, reason: 'missing_current_fingerprint', selectedAuthorityKey: null };
  }
  if (!input.selectedRate) {
    return { ok: false, reason: 'missing_selected_rate', selectedAuthorityKey: null };
  }

  const selectedAuthorityKey = selectedRateAuthorityKey(input.selectedRate);
  const selectedFingerprint = selectedRateRequestFingerprint(input.selectedRate);
  if (!selectedFingerprint) {
    return { ok: false, reason: 'missing_fingerprint', selectedAuthorityKey };
  }
  if (selectedFingerprint !== input.currentRequestFingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch', selectedAuthorityKey };
  }

  if (Array.isArray(input.eligibleRates) && input.eligibleRates.length > 0) {
    const eligibleKeys = new Set(input.eligibleRates.map((rate) => selectedRateAuthorityKey(rate)));
    if (!eligibleKeys.has(selectedAuthorityKey)) {
      return { ok: false, reason: 'not_in_current_eligible_rates', selectedAuthorityKey };
    }
  }

  return { ok: true, reason: 'ok', selectedAuthorityKey };
}

export function assertSelectedRateProofForLabelPurchase(proof: SelectedRateProofInput | null | undefined): SelectedRateValidationResult {
  const result = validateExactSelectedRate({
    currentRequestFingerprint: proof?.requestFingerprint,
    selectedRate: proof?.selectedRate,
    eligibleRates: proof?.eligibleRates,
  });
  if (!result.ok) {
    throw new SelectedRateProofError(
      `Selected rate proof is required before label purchase (${result.reason})`,
      result,
    );
  }
  return result;
}

// ── PS-204: bind the selected-rate proof to the PURCHASE account ──────────────
// The order-1484 class: the payload charged shippingProviderId=10000025 (a
// direct-carrier synthetic id) while the carried proof's rate belonged to
// ShipStation se-565377 — the amount/proof source and the purchase account
// source disagreed and nothing compared them. These pure helpers extract the
// provider-account identity from a proof rate and validate it against the
// payload's shippingProviderId BEFORE any provider call.

/** Same synthetic ranges the rate/label sides use (se-1xxxxxxx carrier_accounts, se-2xxxxxxx store_accounts). */
export const DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR = 10_000_000;

export function isDirectSyntheticProviderKey(key: string | null | undefined): boolean {
  const n = Number(key);
  return Number.isFinite(n) && n >= DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR;
}

/**
 * Normalized provider-account identity of a proof/snapshot rate, or null when
 * the rate carries no identity at all (legacy rows — binding is then skipped,
 * never weaker than the pre-PS-204 boundary).
 */
export function selectedRateProviderAccountKey(rate: unknown): string | null {
  const row = record(rate) ?? {};
  const raw = record(row.raw) ?? {};
  const value = firstPresent(
    row.shippingProviderId,
    row.providerAccountId,
    row.shipping_provider_id,
    row.carrier_id,
    row.carrierId,
    raw.shippingProviderId,
    raw.providerAccountId,
    raw.carrier_id,
  );
  if (value == null) return null;
  const key = providerAccountKey(value);
  return key ? key : null;
}

/** Normalized identity of the purchase payload's shippingProviderId (null = not sent). */
export function purchaseProviderAccountKey(shippingProviderId: unknown): string | null {
  if (shippingProviderId === null || shippingProviderId === undefined) return null;
  const text = String(shippingProviderId).trim();
  if (!text) return null;
  return providerAccountKey(text) || null;
}

export type PurchaseAccountBindingResult =
  | { ok: true; reason: 'ok' | 'no_purchase_account' | 'proof_has_no_account_identity'; purchaseKey: string | null; proofKey: string | null }
  | { ok: false; reason: 'purchase_account_mismatch'; purchaseKey: string; proofKey: string };

/**
 * PS-204 pure decision: when BOTH the purchase payload and the validated proof
 * rate name a carrier account, they must be the SAME account. Absent either
 * side, the binding passes (identical to the pre-PS-204 boundary) — it only
 * ever ADDS a block, never relaxes one.
 */
export function validatePurchaseAccountBinding(input: {
  purchaseShippingProviderId: unknown;
  selectedRate: unknown;
}): PurchaseAccountBindingResult {
  const purchaseKey = purchaseProviderAccountKey(input.purchaseShippingProviderId);
  const proofKey = selectedRateProviderAccountKey(input.selectedRate);
  if (purchaseKey == null) return { ok: true, reason: 'no_purchase_account', purchaseKey: null, proofKey };
  if (proofKey == null) return { ok: true, reason: 'proof_has_no_account_identity', purchaseKey, proofKey: null };
  if (purchaseKey === proofKey) return { ok: true, reason: 'ok', purchaseKey, proofKey };
  return { ok: false, reason: 'purchase_account_mismatch', purchaseKey, proofKey };
}

// ─── PS-191: structured retry eligibility for purchase failures ─────────────
// The FE previously regex-parsed postage error MESSAGES to decide whether a
// failed purchase was worth retrying — and Print-to-Queue then silently
// re-purchased at a possibly higher rate. Retry eligibility is now a backend
// fact derived STRUCTURALLY from the proof-error shape (code + details.reason
// — never message text), returned on every purchase-failure response, and the
// FE only ever PROMPTS the operator; it never auto-buys.
//
// Eligible = reasons a rate REFRESH actually fixes (stale/missing/changed
// proof). NOT eligible: purchase_account_mismatch — the saved rate belongs to
// a different account, so refreshing the same selection just loops; the
// operator must pick the matching account/rate.
const PROOF_ERROR_CODES: ReadonlySet<string> = new Set([
  'SELECTED_RATE_PROOF_INVALID',
  'DIRECT_CARRIER_ON_SHIPSTATION_PATH',
  'SELECTED_RATE_ACCOUNT_MISMATCH',
]);

const RETRY_ELIGIBLE_PROOF_REASONS: ReadonlySet<string> = new Set([
  'missing_selected_rate',
  'missing_current_fingerprint',
  'missing_fingerprint',
  'fingerprint_mismatch',
  'not_in_current_eligible_rates',
  'snapshot_not_final',
  'backend_rate_quote_required',
  'snapshot_missing',
  'snapshot_expired',
  'selected_rate_not_in_snapshot',
  'proof_invalid',
]);

export function classifyLabelPurchaseRetry(err: unknown): {
  retryEligible: boolean;
  retryReason: string | null;
} {
  const e = err as
    | { code?: unknown; name?: unknown; status?: unknown; details?: { reason?: unknown } }
    | null
    | undefined;
  // Audit PQ-5 (2026-07-13): PRE-PURCHASE-PROVABLE transport failures are retry
  // eligible — the provider never processed the request, so a retry cannot
  // double-buy. Circuit-open: the request never left the process. 429: ShipStation
  // rejected it before processing. Previously these mapped to failed_terminal, so
  // a 30-second ShipStation blip cascaded an entire batch into terminal failures
  // with no retry path. A 5xx/timeout on the purchase POST itself remains
  // NON-eligible — that is an unknown outcome (the label may exist at the
  // provider); reconciliation, not blind retry, is the only safe path (audit
  // C1/1.20). Structural checks only (PS-191).
  if (!!e && String(e.code) === 'SHIPSTATION_CIRCUIT_OPEN') {
    return { retryEligible: true, retryReason: 'provider_unavailable' };
  }
  if (!!e && e.name === 'ShipStationError' && Number(e.status) === 429) {
    return { retryEligible: true, retryReason: 'provider_rate_limited' };
  }
  const isProofError =
    !!e &&
    (PROOF_ERROR_CODES.has(String(e.code)) || e.name === 'SelectedRateProofError');
  if (!isProofError) return { retryEligible: false, retryReason: null };
  const reason =
    typeof e!.details?.reason === 'string' ? e!.details.reason : null;
  return {
    retryEligible: reason !== null && RETRY_ELIGIBLE_PROOF_REASONS.has(reason),
    retryReason: reason,
  };
}

/**
 * Throwing wrapper for the purchase boundary. Mismatch throws the SAME
 * SelectedRateProofError class the proof path throws (structured, before any
 * provider call). The error code distinguishes the synthetic-id-on-a-
 * ShipStation-proof shape (DIRECT_CARRIER_ON_SHIPSTATION_PATH) from the
 * general account mismatch so the UI can show the right re-rate action.
 */
export function assertPurchaseAccountMatchesProof(input: {
  purchaseShippingProviderId: unknown;
  selectedRate: unknown;
}): PurchaseAccountBindingResult {
  const result = validatePurchaseAccountBinding(input);
  if (result.ok) return result;
  const purchaseIsSynthetic = isDirectSyntheticProviderKey(result.purchaseKey);
  const proofIsSynthetic = isDirectSyntheticProviderKey(result.proofKey);
  const err = new SelectedRateProofError(
    purchaseIsSynthetic && !proofIsSynthetic
      ? `Selected account (provider id ${result.purchaseKey}) is a direct carrier account, but the selected rate proof belongs to ShipStation account ${result.proofKey}. Re-rate/select the matching account before purchasing. No postage was purchased.`
      : `Purchase payload account (provider id ${result.purchaseKey}) does not match the selected rate proof account (${result.proofKey}). Re-rate or reselect the rate for the chosen account. No postage was purchased.`,
    { ok: false, reason: 'purchase_account_mismatch', selectedAuthorityKey: result.proofKey },
  );
  err.code = purchaseIsSynthetic && !proofIsSynthetic
    ? 'DIRECT_CARRIER_ON_SHIPSTATION_PATH'
    : 'SELECTED_RATE_ACCOUNT_MISMATCH';
  throw err;
}
