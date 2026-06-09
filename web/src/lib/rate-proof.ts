// PS-135: canonical FE rate-proof helpers, extracted from OrdersView (no behavior change).
//
// These are PURE reads of a backend-issued rate record — they NEVER recompute a fingerprint
// or re-rank a rate; they only surface what the backend stamped. The backend remains the
// authority for the selected-rate proof; this is the frontend pass-through used when building
// label/queue payloads. Logic is byte-identical to the prior inline OrdersView versions
// (the ps-079 guard pins it); the OrdersView functions now delegate here.

const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response';
export { BACKEND_RATE_PROOF_SOURCE };

type Rec = Record<string, unknown>;

function toRec(value: unknown): Rec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Rec;
}

function toStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function proofMetadataRecord(rate: Rec | null): Rec | null {
  return toRec(rate?.metadata);
}

export function proofRawRecord(rate: Rec | null): Rec | null {
  return toRec(rate?.raw);
}

export function hasBackendIssuedRateProof(rate: Rec | null): boolean {
  const metadata = proofMetadataRecord(rate);
  const raw = proofRawRecord(rate);
  return (
    toStr(rate?.proofSource) === BACKEND_RATE_PROOF_SOURCE ||
    toStr(metadata?.proofSource) === BACKEND_RATE_PROOF_SOURCE ||
    toStr(raw?.proofSource) === BACKEND_RATE_PROOF_SOURCE
  );
}

export function rateProofFingerprint(rate: Rec | null): string | null {
  const raw = toRec(rate?.raw);
  const metadata = toRec(rate?.metadata);
  return (
    toStr(rate?.requestFingerprint) ??
    toStr(rate?.rateRequestFingerprint) ??
    toStr(rate?.cacheKey) ??
    toStr(metadata?.requestFingerprint) ??
    toStr(metadata?.cacheKey) ??
    toStr(raw?.requestFingerprint) ??
    toStr(raw?.cacheKey) ??
    null
  );
}

/**
 * Pick the first candidate that carries a backend-issued proof + fingerprint and return the
 * selected-rate proof payload. Callers pass the ordered candidate list (e.g. [explicit
 * candidate, order.bestRate, order.selectedRate, savedBestRate]).
 */
export function selectProofFromCandidates(
  candidates: Array<Rec | null | undefined>,
): { requestFingerprint: string; selectedRate: Rec } | undefined {
  const list = candidates.filter(Boolean) as Rec[];
  const selectedRate = list.find((rate) => hasBackendIssuedRateProof(rate) && rateProofFingerprint(rate)) ?? null;
  const requestFingerprint = rateProofFingerprint(selectedRate);
  if (!selectedRate || !requestFingerprint) return undefined;
  return { requestFingerprint, selectedRate };
}

/**
 * PS-135: identity key for matching a backend-selected bestRate to its corresponding modal
 * row. The natural key for a rate is (carrier account, service code). Returns null when
 * either part is missing so a partial/empty record can never spuriously match.
 */
export function canonicalRateKey(rate: unknown): string | null {
  const rec = toRec(rate);
  if (!rec) return null;
  const pidRaw = rec.shippingProviderId;
  const pid =
    typeof pidRaw === 'number' && Number.isFinite(pidRaw)
      ? pidRaw
      : typeof pidRaw === 'string' && pidRaw.trim() !== '' && Number.isFinite(Number(pidRaw))
        ? Number(pidRaw)
        : null;
  const service = toStr(rec.serviceCode);
  if (pid === null || !service) return null;
  return `${pid}|${service}`;
}

/**
 * PS-135: find the eligible modal row that corresponds to the backend's canonical bestRate, so
 * the Rate Browser CONSUMES the backend's authoritative selection instead of re-ranking rows
 * client-side. Callers pass the ALREADY-eligibility-filtered candidate set (service-class +
 * blocked rules applied). Returns null when the backend winner isn't present in that set (the
 * operator's service-class filter excluded it, or no backend best was returned) — the caller
 * then falls back to its local pick, so the operator's filter and blocked rules are preserved.
 */
export function findCanonicalBestRate<T>(backendBest: unknown, candidates: T[]): T | null {
  const wantKey = canonicalRateKey(backendBest);
  if (!wantKey) return null;
  return candidates.find((candidate) => canonicalRateKey(candidate) === wantKey) ?? null;
}

/**
 * Backend-owned rate-quote reference ({ rateQuoteId, selectedRateKey }) for label/queue
 * payloads — mirrors selectProofFromCandidates's selection so id/key match the proof's rate.
 * Additive: omits fields the rate doesn't carry (the proof path is then used).
 */
export function rateQuoteRefFromCandidates(
  candidates: Array<Rec | null | undefined>,
): { rateQuoteId?: string; selectedRateKey?: string } {
  const list = candidates.filter(Boolean) as Rec[];
  const rate = list.find((r) => hasBackendIssuedRateProof(r) && rateProofFingerprint(r)) ?? null;
  if (!rate) return {};
  const rateQuoteId = toStr(rate.rateQuoteId);
  const selectedRateKey = toStr(rate.selectedRateKey);
  const ref: { rateQuoteId?: string; selectedRateKey?: string } = {};
  if (rateQuoteId) ref.rateQuoteId = rateQuoteId;
  if (selectedRateKey) ref.selectedRateKey = selectedRateKey;
  return ref;
}
