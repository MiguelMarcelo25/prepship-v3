// PS-127 — Canonical owner of destination residential/commercial classification for
// rating + label parity.
//
// THE RULE: residential is the SAFE FALLBACK only when classification is unknown. When
// trusted evidence exists, classify from it, in this strict priority order:
//   1. PrepShip manual override (order_overrides.residential)        -> confidence 'manual'
//   2. Trusted source/provider flag (e.g. ShipStation raw residential) -> 'source'
//   3. Validated address metadata that EXPLICITLY says business/residential
//      (e.g. USPS additionalInfo.business)                            -> 'validated'
//   4. Company-name heuristic (weak — only if nothing better)         -> 'heuristic'
//   5. Fallback residential                                           -> 'fallback'
//
// IMPORTANT NUANCE: never classify commercial from ZIP+4 alone. ZIP+4 (from PS-126's
// postal helper) is supporting evidence for exact validation/rate parity, NOT a
// classifier. Only an explicit provider/source business marker flips to commercial.
//
// Backend owns this decision. The rate resolver, fingerprint/proof, and label purchase
// all delegate here; the frontend may DISPLAY the result and capture a manual override,
// but is never the authoritative classifier.

import { normalizeShippingPostalCode } from './postal-code';

export type AddressClassification = 'residential' | 'commercial';

export type AddressClassificationSource =
  | 'manual_override'
  | 'shipstation_source'
  | 'address_validation'
  | 'provider_marker'
  | 'company_heuristic'
  | 'fallback_residential';

export type AddressClassificationConfidence =
  | 'manual'
  | 'source'
  | 'validated'
  | 'heuristic'
  | 'fallback';

export type AddressClassificationEvidence = {
  sourceResidential?: boolean | null;
  zipPlus4?: string | null;
  dpvConfirmation?: string | null;
  business?: boolean | string | null;
  carrierRoute?: string | null;
  companyPresent?: boolean;
  provider?: string | null;
};

export type AddressClassificationResult = {
  residential: boolean;
  classification: AddressClassification;
  source: AddressClassificationSource;
  confidence: AddressClassificationConfidence;
  evidence: AddressClassificationEvidence;
};

export type AddressClassificationInput = {
  orderId?: number | string | null;
  clientId?: number | string | null;
  storeId?: number | string | null;
  shipTo?: {
    name?: string | null;
    company?: string | null;
    street1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
  /** PrepShip manual override (order_overrides.residential): true=residential, false=commercial. */
  manualOverrideResidential?: boolean | null;
  /** Trusted source/provider flag (e.g. ShipStation raw shipTo.residential). */
  sourceResidential?: boolean | null;
  /** Optional address-validation evidence (e.g. USPS validate-address output). */
  addressValidation?: {
    /** USPS additionalInfo.business: 'Y'/'N' or boolean. Explicit commercial marker. */
    business?: boolean | string | null;
    dpvConfirmation?: string | null;
    zipPlus4?: string | null;
    carrierRoute?: string | null;
  } | null;
  /** Optional explicit provider classification marker ('residential'/'commercial'). */
  providerMarker?: { classification?: AddressClassification | null; provider?: string | null } | null;
};

function asBool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === 'y' || v === '1') return true;
    if (v === 'false' || v === 'no' || v === 'n' || v === '0') return false;
  }
  return null;
}

/** USPS additionalInfo.business is an explicit commercial marker ('Y' => business). */
function businessIsCommercial(business: boolean | string | null | undefined): boolean | null {
  if (business === true) return true;
  if (business === false) return false;
  if (typeof business === 'string') {
    const v = business.trim().toLowerCase();
    if (v === 'y' || v === 'yes' || v === 'true' || v === 'commercial' || v === 'business') return true;
    if (v === 'n' || v === 'no' || v === 'false' || v === 'residential') return false;
  }
  return null;
}

function hasCompany(company: string | null | undefined, name?: string | null): boolean {
  const c = String(company ?? '').trim();
  if (!c) return false;
  // Ignore a company that merely duplicates the recipient name (common import artifact).
  return c.toLowerCase() !== String(name ?? '').trim().toLowerCase();
}

/**
 * Resolve destination residential/commercial from the best available evidence.
 * Pure & synchronous (no DB/network) so it's deterministic and unit-testable; callers
 * supply whatever evidence they already have (override, source flag, cached validation).
 */
export function classifyShippingAddress(input: AddressClassificationInput): AddressClassificationResult {
  const country = input.shipTo?.country ?? 'US';
  const zipPlus4 = normalizeShippingPostalCode(input.shipTo?.postalCode, country).exact ?? null;
  const companyPresent = hasCompany(input.shipTo?.company, input.shipTo?.name);
  const baseEvidence: AddressClassificationEvidence = {
    sourceResidential: input.sourceResidential ?? null,
    zipPlus4,
    dpvConfirmation: input.addressValidation?.dpvConfirmation ?? null,
    business: input.addressValidation?.business ?? null,
    carrierRoute: input.addressValidation?.carrierRoute ?? null,
    companyPresent,
    provider: input.providerMarker?.provider ?? null,
  };

  const decide = (
    residential: boolean,
    source: AddressClassificationSource,
    confidence: AddressClassificationConfidence,
  ): AddressClassificationResult => ({
    residential,
    classification: residential ? 'residential' : 'commercial',
    source,
    confidence,
    evidence: baseEvidence,
  });

  // 1. Manual override wins.
  const override = asBool(input.manualOverrideResidential);
  if (override !== null) return decide(override, 'manual_override', 'manual');

  // 2. Explicit provider classification marker.
  if (input.providerMarker?.classification === 'commercial') return decide(false, 'provider_marker', 'source');
  if (input.providerMarker?.classification === 'residential') return decide(true, 'provider_marker', 'source');

  // 3. Trusted source flag (e.g. ShipStation raw shipTo.residential boolean).
  const source = asBool(input.sourceResidential);
  if (source !== null) return decide(source, 'shipstation_source', 'source');

  // 4. Validated address metadata with an EXPLICIT business/residential marker.
  const business = businessIsCommercial(input.addressValidation?.business);
  if (business !== null) return decide(!business, 'address_validation', 'validated');
  // NOTE: ZIP+4 / DPV / carrier route alone do NOT classify commercial (nuance above).

  // 5. Weak company-name heuristic — only when no trusted evidence exists.
  if (companyPresent) return decide(false, 'company_heuristic', 'heuristic');

  // 6. Fallback: residential is the safe default when unknown.
  return decide(true, 'fallback_residential', 'fallback');
}
