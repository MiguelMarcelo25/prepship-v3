// PS-276 (slice 2b) — resolve an address's residential/commercial classification from a carrier
// address-validation resolver (USPS first), normalized into the classifier's TRUSTED evidence shape
// (addressValidation tier 4 / providerMarker tier 2). Cache-first per-address (276.2a); on miss,
// call the resolver best-effort and cache the result.
//
// ENV-GATED: addressResolverMode() defaults to 'off' (env ADDRESS_RESOLVER !== 'on'), so this is
// INERT until DJ flips it on — the live-call canary, exactly like PS-244's RATE_PROOF_ENFORCEMENT.
// Shipping it wired (slice 2b-2) changes nothing in prod until the flag is set.
//
// MONEY-SAFE: an ambiguous / no-confident answer sets NO commercial marker — the classifier then
// falls to the source flag / fallback (residential). We only flip to commercial on an explicit,
// confident business marker. Resolver outage NEVER throws into a quote (returns {} -> residential).
//
// Lockdown: awaiting/rating + label-classification paths only. No shipped/cancelled data.
import {
  addressClassificationKey,
  getCachedAddressClassification,
  setCachedAddressClassification,
} from './address-classification-cache';
import type { AddressClassificationRow } from '../../db/schema/address-classifications';

export type ResolvedAddressEvidence = {
  // tier 4 (validated): an explicit USPS business marker. business true = commercial, false = residential.
  addressValidation?: {
    business: boolean;
    dpvConfirmation: string | null;
    zipPlus4: string | null;
    carrierRoute: string | null;
  };
  // tier 2 (source): an explicit UPS/FedEx verdict (slice 2b/2.5).
  providerMarker?: { classification: 'residential' | 'commercial'; provider: string };
};

export type AddressResolverMode = 'off' | 'on';

/** Default OFF — the resolver is inert until DJ sets ADDRESS_RESOLVER=on (live-call canary). */
export function addressResolverMode(): AddressResolverMode {
  return process.env.ADDRESS_RESOLVER === 'on' ? 'on' : 'off';
}

/** Normalize a USPS business marker to a boolean verdict, or null when ambiguous (money-safe). */
export function normalizeBusinessMarker(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'y' || v === 'yes' || v === 'true' || v === 'business' || v === 'commercial') return true;
    if (v === 'n' || v === 'no' || v === 'false' || v === 'residential') return false;
  }
  return null; // ambiguous / unknown -> NO marker
}

export type UspsValidationResult = {
  additionalInfo?: { business?: unknown; DPVConfirmation?: string | null } | null;
  standardized?: { ZIPPlus4?: string | null; carrierRoute?: string | null } | null;
} | null | undefined;

/**
 * PURE: USPS validateUspsAddress result -> trusted evidence. An explicit business='Y' -> commercial,
 * 'N' -> residential; anything else -> {} (no addressValidation marker, so the classifier stays
 * residential-safe). Unit-testable with no DB/network.
 */
export function normalizeUspsAddressClassification(usps: UspsValidationResult): ResolvedAddressEvidence {
  const business = normalizeBusinessMarker(usps?.additionalInfo?.business);
  if (business === null) return {};
  return {
    addressValidation: {
      business,
      dpvConfirmation: usps?.additionalInfo?.DPVConfirmation ?? null,
      zipPlus4: usps?.standardized?.ZIPPlus4 ?? null,
      carrierRoute: usps?.standardized?.carrierRoute ?? null,
    },
  };
}

/** Reconstruct classifier evidence from a cached row. */
export function evidenceFromCacheRow(row: AddressClassificationRow | null): ResolvedAddressEvidence {
  if (!row) return {};
  const out: ResolvedAddressEvidence = {};
  if (row.business !== null && row.business !== undefined) {
    out.addressValidation = {
      business: row.business,
      dpvConfirmation: row.dpvConfirmation ?? null,
      zipPlus4: row.zipPlus4 ?? null,
      carrierRoute: row.carrierRoute ?? null,
    };
  }
  if (row.providerClassification === 'residential' || row.providerClassification === 'commercial') {
    out.providerMarker = { classification: row.providerClassification, provider: row.provider ?? 'unknown' };
  }
  return out;
}

export type ResolveAddressInput = {
  street1?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  city?: string | null;
};

export type ResolveAddressDeps = {
  mode?: AddressResolverMode;
  // Injected USPS validator (slice 2b-2 wires the real validateUspsAddress + cred loader here).
  validateUsps?: (input: ResolveAddressInput) => Promise<UspsValidationResult>;
};

/**
 * Resolve trusted residential evidence for an address. Cache-first; on miss, call the injected
 * resolver (best-effort). Returns {} when OFF / unkeyable / outage — never throws into a quote.
 */
export async function resolveAddressClassification(
  input: ResolveAddressInput,
  deps: ResolveAddressDeps = {},
): Promise<ResolvedAddressEvidence> {
  const mode = deps.mode ?? addressResolverMode();
  if (mode === 'off') return {}; // inert until flipped on

  const key = addressClassificationKey(input);
  if (!key) return {}; // ambiguous address -> resolve nothing rather than key on a partial

  const cached = await getCachedAddressClassification(key);
  if (cached) return evidenceFromCacheRow(cached);

  if (!deps.validateUsps) return {}; // no resolver wired -> nothing (still cache-safe)
  try {
    const usps = await deps.validateUsps(input);
    const evidence = normalizeUspsAddressClassification(usps);
    await setCachedAddressClassification(key, {
      business: evidence.addressValidation ? evidence.addressValidation.business : null,
      providerClassification: null,
      provider: 'usps',
      dpvConfirmation: evidence.addressValidation?.dpvConfirmation ?? null,
      zipPlus4: evidence.addressValidation?.zipPlus4 ?? null,
      carrierRoute: evidence.addressValidation?.carrierRoute ?? null,
      raw: usps ?? null,
    });
    return evidence;
  } catch {
    return {}; // resolver outage -> no evidence (residential-safe), never blocks the quote
  }
}
