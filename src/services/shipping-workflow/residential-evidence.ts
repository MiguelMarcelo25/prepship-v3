// PS-276 (slice 1) — the SINGLE owner of "what residential evidence an order carries"
// into a rate request. Extracted so the live POST /rates/browse route and the
// rates-backfill producer build the IDENTICAL evidence (manual override + source flag +
// company/name) and feed the one classifier (classifyRateInputResidential) the same way.
//
// Why this exists (the #1585 residential asymmetry): /rates/browse loaded the operator's
// order_overrides.residential manual override and passed it as manualOverrideResidential,
// but rates-backfill sent only the lone raw.shipTo.residential as `residential`. The
// classifier reads manualOverrideResidential as a SEPARATE, higher-priority tier than the
// source flag (rates.ts classifyRateInputResidential) — so a manual COMMERCIAL override was
// honored by the Rate Browser ($10.79) yet silently ignored by the persisted BEST RATE
// column the backfill writes ($13.00). One builder => both paths feed the override.
//
// Lockdown: awaiting/rating path only. No shipped/cancelled data, no writes here (pure).

// PS-276 (slice 2b): resolver-supplied trusted evidence shapes (USPS validated business marker /
// UPS-FedEx provider verdict). Declared inline so this module stays PURE (no cache/db import).
export type ResidentialAddressValidation = {
  business?: boolean | string | null;
  dpvConfirmation?: string | null;
  zipPlus4?: string | null;
  carrierRoute?: string | null;
};
export type ResidentialProviderMarker = {
  classification?: 'residential' | 'commercial' | null;
  provider?: string | null;
};

export type ResidentialEvidence = {
  manualOverrideResidential: boolean | null;
  sourceResidential: boolean | null;
  toCompany: string | null;
  toName: string | null;
  // PS-276 (slice 2b): optional resolver evidence (classifier tiers 4/2). The caller merges it in
  // from resolveAddressClassification when ADDRESS_RESOLVER=on; absent otherwise (classifier unchanged).
  addressValidation?: ResidentialAddressValidation | null;
  providerMarker?: ResidentialProviderMarker | null;
};

/**
 * Normalize an order's raw shipTo + manual override into the classifier's evidence shape.
 * Only real booleans count as evidence; anything else is null (so the classifier's
 * money-safe fallback applies — never a guess flipped to commercial).
 */
export function buildResidentialEvidenceFromOrder(input: {
  rawShipTo: unknown;
  manualOverrideResidential: unknown;
  shipToName?: string | null;
  // PS-276 (slice 2b): merge in resolver evidence (resolveAddressClassification output) when present.
  resolved?: { addressValidation?: ResidentialAddressValidation | null; providerMarker?: ResidentialProviderMarker | null } | null;
}): ResidentialEvidence {
  const shipTo =
    input.rawShipTo && typeof input.rawShipTo === 'object'
      ? (input.rawShipTo as Record<string, unknown>)
      : {};
  return {
    manualOverrideResidential:
      typeof input.manualOverrideResidential === 'boolean' ? input.manualOverrideResidential : null,
    sourceResidential: typeof shipTo.residential === 'boolean' ? shipTo.residential : null,
    toCompany: typeof shipTo.company === 'string' ? shipTo.company : null,
    toName: input.shipToName ?? null,
    ...(input.resolved?.addressValidation ? { addressValidation: input.resolved.addressValidation } : {}),
    ...(input.resolved?.providerMarker ? { providerMarker: input.resolved.providerMarker } : {}),
  };
}

/**
 * The rate-input fields that carry the evidence into getRates /
 * getDirectCarrierRatesForRateInput. `residential` is set to undefined so the classifier's
 * manual_override / source tiers attribute correctly instead of collapsing to one boolean.
 * `toName` is only added when the caller does not already carry one (browse parity).
 */
export function residentialEvidenceRateInput(
  evidence: ResidentialEvidence,
  existingToName?: string | null,
): {
  residential: undefined;
  manualOverrideResidential: boolean | null;
  sourceResidential: boolean | null;
  toCompany?: string;
  toName?: string;
  addressValidation?: ResidentialAddressValidation | null;
  providerMarker?: ResidentialProviderMarker | null;
} {
  return {
    residential: undefined,
    manualOverrideResidential: evidence.manualOverrideResidential,
    sourceResidential: evidence.sourceResidential,
    ...(evidence.toCompany != null ? { toCompany: evidence.toCompany } : {}),
    ...(evidence.toName && !existingToName ? { toName: evidence.toName } : {}),
    // PS-276 (slice 2b): carry resolver evidence into the RateInput (classifier tiers 4/2).
    ...(evidence.addressValidation ? { addressValidation: evidence.addressValidation } : {}),
    ...(evidence.providerMarker ? { providerMarker: evidence.providerMarker } : {}),
  };
}
