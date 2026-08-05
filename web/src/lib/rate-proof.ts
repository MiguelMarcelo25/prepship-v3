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

// ── PS-204: provider-account identity of a rate (display + proof honesty) ────
// Mirrors the backend's providerAccountKey normalization (se-<n> ↔ numeric ↔
// text) — a pure READ of what the backend stamped, never a recomputation.

function providerAccountKeyText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^se-(\d+)$/i);
  if (match?.[1]) return match[1];
  const n = Number(text);
  if (Number.isFinite(n)) return String(Math.trunc(n));
  return text.toLowerCase().replace(/\s+/g, '_');
}

/** Normalized account identity carried BY a rate record, or null when it has none. */
export function rateProviderAccountKey(rate: unknown): string | null {
  const rec = toRec(rate);
  if (!rec) return null;
  const raw = toRec(rec.raw);
  const candidates = [
    rec.shippingProviderId,
    rec.providerAccountId,
    (rec as Rec)['shipping_provider_id'],
    rec.carrier_id,
    rec.carrierId,
    raw?.shippingProviderId,
    raw?.providerAccountId,
    raw?.carrier_id,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    return providerAccountKeyText(value);
  }
  return null;
}

/** Normalized identity of a panel/payload shippingProviderId (null = none selected). */
export function providerAccountKeyFromId(shippingProviderId: unknown): string | null {
  if (shippingProviderId === null || shippingProviderId === undefined) return null;
  return providerAccountKeyText(shippingProviderId);
}

/**
 * PS-204 display/proof honesty: does this rate belong to the given account?
 * Returns null when the rate carries NO identity (unknowable — callers treat
 * that as "allowed", matching the backend binding's skip rule).
 */
export function rateBelongsToProviderAccount(rate: unknown, shippingProviderId: unknown): boolean | null {
  const rateKey = rateProviderAccountKey(rate);
  if (rateKey == null) return null;
  const accountKey = providerAccountKeyFromId(shippingProviderId);
  if (accountKey == null) return null;
  return rateKey === accountKey;
}

export type ProofCandidateOptions = {
  /**
   * PS-204: the account the payload will CHARGE. Candidates that carry an
   * identity for a DIFFERENT account are excluded — the proof sent to the
   * backend can then never describe one account while the payload charges
   * another (the order-1484 class). Identity-less candidates still pass
   * (legacy rows; the backend binding skips those the same way).
   */
  forShippingProviderId?: unknown;
};

function filterCandidatesForAccount(list: Rec[], options?: ProofCandidateOptions): Rec[] {
  const accountKey = providerAccountKeyFromId(options?.forShippingProviderId);
  if (accountKey == null) return list;
  return list.filter((rate) => {
    const rateKey = rateProviderAccountKey(rate);
    return rateKey == null || rateKey === accountKey;
  });
}

// PS-422 retirement (2026-08-05): the legacy SEMANTIC proof selector that used to sit here
// was deleted. It returned a { requestFingerprint, selectedRate } payload reconstructed from
// displayed rate fields; PS-422 replaced that route with the opaque backend-minted
// selectionRef below. It had zero application callers once the frontend payload builder was
// removed, and the backend cannot be authorized by it either: createLabelV2 takes purchase
// authority ONLY from assertLabelPurchaseRateSelection({ selectionRef }) and then explicitly
// overwrites `selectedRateProof: undefined` on the body before any provider dispatch
// (src/services/labels.ts). A frontend builder for that field could not influence a purchase
// under any input, so it was not a safety net — it was a re-wiring hazard under PS-313/PS-316.
// The rules it carried did not vanish: the account filter it shared is directly below and
// still load-bearing, and the "backend marker gates the fingerprint" rule lives in the live
// consumer (components/Views/orders/best-rate/rate-proof.ts).
// NB: the retired symbol name is deliberately NOT written here — several guards read this
// file as raw text, so a name in a comment would satisfy an includes() pin vacuously.

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
 * PS-422: select the single opaque purchase authorization minted by the backend.
 * The frontend may filter by the operator-selected account, but it cannot rebuild
 * the snapshot id/key pair or any facts bound inside the authorization.
 */
export function rateQuoteRefFromCandidates(
  candidates: Array<Rec | null | undefined>,
  options?: ProofCandidateOptions,
): { selectionRef?: string } {
  const list = filterCandidatesForAccount(candidates.filter(Boolean) as Rec[], options);
  const selectionRef = toStr(list.find((rate) => toStr(rate.selectionRef))?.selectionRef);
  return selectionRef ? { selectionRef } : {};
}
