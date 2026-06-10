// PS-132 (old PS-138): single backend registry for known ShipStation carrier accounts.
//
// Before this, the same provider-id → {carrier_code, nickname, account#} table was hardcoded
// in at least 4 places (src/services/rates.ts, src/routes/orders.ts, and two frontend copies)
// and had DRIFTED: provider 433543 was "Chase x7439" in rates.ts but "UPS by SS - Chase
// x7439" everywhere else. This module is the ONE backend source; rates.ts and orders.ts now
// derive their lookup structures from it, so the rate-carrier display and the orders/billing
// account display can never disagree again.
//
// RECONCILIATION (PS-132): provider 433543 is canonicalized to "UPS by SS - Chase x7439"
// (the value used by Orders, the Settings account list, and the frontend — 3 of 4 sources).
// If the operator-facing label should be the shorter "Chase x7439", change it HERE only.
//
// This is the verified STOPGAP table. A future slice can layer a DB-backed resolver over the
// credential/account tables on top of this (DB wins, this is the fallback) without changing
// any consumer — they call the resolvers below.

export type KnownCarrierAccount = {
  shippingProviderId: number;
  carrierCode: string;
  nickname: string;
  clientId: number | null;
  accountNumber: string | null;
};

export const KNOWN_CARRIER_ACCOUNTS: KnownCarrierAccount[] = [
  { shippingProviderId: 433542, carrierCode: 'stamps_com', nickname: 'USPS Chase x7439', clientId: null, accountNumber: 'djeon-952w77' },
  // PS-132 reconciled (was "Chase x7439" in rates.ts):
  { shippingProviderId: 433543, carrierCode: 'ups_walleted', nickname: 'UPS by SS - Chase x7439', clientId: null, accountNumber: 'ups_433543' },
  { shippingProviderId: 565326, carrierCode: 'ups', nickname: 'GG6381', clientId: null, accountNumber: 'GG6381' },
  { shippingProviderId: 565377, carrierCode: 'ups', nickname: 'G19Y32', clientId: null, accountNumber: 'G19Y32' },
  { shippingProviderId: 596001, carrierCode: 'ups', nickname: 'ORION', clientId: null, accountNumber: 'R05H19' },
  { shippingProviderId: 604209, carrierCode: 'ups', nickname: 'ROCEL', clientId: null, accountNumber: null },
  { shippingProviderId: 607855, carrierCode: 'ups', nickname: 'ROCEL C81F70', clientId: null, accountNumber: 'C81F70' },
  { shippingProviderId: 598840, carrierCode: 'fedex', nickname: 'FedEx', clientId: null, accountNumber: '208481048' },
  { shippingProviderId: 585004, carrierCode: 'fedex_walleted', nickname: 'FedEx One Balance', clientId: null, accountNumber: null },
  { shippingProviderId: 442006, carrierCode: 'stamps_com', nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { shippingProviderId: 461890, carrierCode: 'ups', nickname: 'ROCEL C81F70', clientId: 10, accountNumber: 'C81F70' },
  { shippingProviderId: 565317, carrierCode: 'ups', nickname: 'GG6381', clientId: 10, accountNumber: 'GG6381' },
  { shippingProviderId: 595995, carrierCode: 'ups', nickname: 'ORI Account', clientId: 10, accountNumber: 'R05H19' },
  { shippingProviderId: 442007, carrierCode: 'ups', nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { shippingProviderId: 442013, carrierCode: 'fedex', nickname: 'FedEx', clientId: 10, accountNumber: '208481048' },
  { shippingProviderId: 585334, carrierCode: 'fedex_walleted', nickname: 'FedEx One Balance', clientId: 10, accountNumber: null },
];

/** ShipStation carrier id form used across the rate engine: `se-<providerId>`. */
export function carrierIdForProvider(shippingProviderId: number): string {
  return `se-${shippingProviderId}`;
}

const byProviderId = new Map<number, KnownCarrierAccount>(
  KNOWN_CARRIER_ACCOUNTS.map((account) => [account.shippingProviderId, account]),
);

function normalizeProviderId(idOrCarrierId: string | number): number | null {
  const raw = String(idOrCarrierId).trim();
  const match = raw.match(/^se-(\d+)$/i);
  if (match?.[1]) return Number(match[1]);
  const num = Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/** Resolve a known account by provider id (433543) or carrier id ('se-433543'). */
export function resolveKnownCarrierAccount(idOrCarrierId: string | number): KnownCarrierAccount | null {
  const providerId = normalizeProviderId(idOrCarrierId);
  return providerId != null ? byProviderId.get(providerId) ?? null : null;
}

export function knownCarrierNickname(idOrCarrierId: string | number): string | null {
  return resolveKnownCarrierAccount(idOrCarrierId)?.nickname ?? null;
}

export function knownCarrierCode(idOrCarrierId: string | number): string | null {
  return resolveKnownCarrierAccount(idOrCarrierId)?.carrierCode ?? null;
}

// ─── PS-170: account-level insurance capability ──────────────────────────────
//
// Two distinct facts about an account decide how a HUGRAB (or any insured) shipment
// is insured:
//   1. WHICH provider it SHOULD use  -> `required`
//   2. Whether a $0 carrier-declared-value insurance can ACTUALLY be purchased NOW
//      on that account                -> `carrierPurchasable`
//
// ShipStation-brokered accounts (`*_walleted`, `stamps_com`, USPS) have no direct
// carrier contract, so the only insurance available is ParcelGuard. A DIRECT UPS
// account (the operator's own UPS contract: GG6381, ORION, ROCEL, …) can insure the
// first $100 of declared value for $0 via carrier declared value — but ONLY once we
// have PROVEN that path actually insures the parcel.
//
// THE VERIFY GATE (DJ decision 2026-06-10, "verify first, then enable"):
// `DIRECT_UPS_CARRIER_INSURANCE_VERIFIED` defaults to FALSE. While false, even a
// direct-UPS account reports `carrierPurchasable: false`, so every consumer falls back
// to ParcelGuard — a guaranteed-insured label, ZERO uninsured risk, and NO change to
// what is purchased today. Flip to true ONLY after a read-only ShipStation check (or DJ
// confirmation) proves a direct-UPS label with carrier declared value $100 is insured.
//
// TODO(PS-170 follow-up): replace this account-code heuristic with DB-backed discovery
// from the credential/account tables (carrier contract vs ShipStation wallet), DB wins.
export const DIRECT_UPS_CARRIER_INSURANCE_VERIFIED = false;

export type AccountInsuranceRequirement = 'parcelguard' | 'carrier' | 'blocked';

export type AccountInsuranceCapability = {
  /** The provider an insured shipment on this account/service SHOULD use. */
  required: AccountInsuranceRequirement;
  /** Whether $0 carrier-declared-value insurance can actually be purchased NOW. */
  carrierPurchasable: boolean;
  reason: string;
};

function normalizeIdentity(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Self-contained Ground Saver / SurePost detection (kept local so the registry stays
// dependency-free; shipping-service-eligibility owns the canonical workflow block and
// imports the capability resolver from here — never the reverse).
const GROUND_SAVER_SUREPOST_CODES = new Set([
  'ups_ground_saver',
  'ups_surepost',
  'ups_surepost_1_lb_or_greater',
  'ups_surepost_less_than_1_lb',
  'easypost_ups_upsdap_upsgroundsavergreaterthan1lb',
  '92',
  '93',
]);

function isGroundSaverOrSurePostService(serviceCode?: string | number | null): boolean {
  const raw = String(serviceCode ?? '').trim();
  if (!raw) return false;
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (GROUND_SAVER_SUREPOST_CODES.has(key)) return true;
  const identity = normalizeIdentity(raw);
  return identity.includes('groundsaver') || identity.includes('surepost');
}

/**
 * PS-170 — resolve the insurance capability of a carrier account/service.
 * Pure + deterministic. Keys off the carrier code (explicit, or resolved from the
 * provider id via {@link KNOWN_CARRIER_ACCOUNTS}):
 *   - Ground Saver / SurePost service       -> blocked (insurance unavailable, PS-057)
 *   - direct `ups` account                  -> required 'carrier' (carrierPurchasable
 *                                              ONLY when the verify flag is true)
 *   - `*_walleted` / `stamps_com` / USPS /
 *     anything else                         -> required 'parcelguard', not purchasable
 *
 * With the verify flag false (default), `carrierPurchasable` is ALWAYS false, so the
 * effective provider every caller derives is ParcelGuard — no uninsured path exists.
 */
export function resolveAccountInsuranceCapability(input: {
  shippingProviderId?: number | string | null;
  carrierCode?: string | null;
  serviceCode?: string | number | null;
}): AccountInsuranceCapability {
  if (isGroundSaverOrSurePostService(input.serviceCode)) {
    return { required: 'blocked', carrierPurchasable: false, reason: 'Ground Saver / SurePost — insurance unavailable (PS-057)' };
  }

  const explicit = normalizeIdentity(input.carrierCode);
  const fromProvider = input.shippingProviderId != null
    ? normalizeIdentity(resolveKnownCarrierAccount(input.shippingProviderId)?.carrierCode)
    : '';
  const carrierCode = explicit || fromProvider;

  // Direct UPS contract (operator's own account) — NOT the ShipStation `ups_walleted`
  // wallet. Only a bare `ups` carrier code is the direct contract.
  const isDirectUps = carrierCode === 'ups';
  if (isDirectUps) {
    return {
      required: 'carrier',
      carrierPurchasable: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED,
      reason: DIRECT_UPS_CARRIER_INSURANCE_VERIFIED
        ? 'Direct UPS account — carrier declared value purchasable'
        : 'Direct UPS account — carrier insurance NOT yet verified, defaulting to ParcelGuard',
    };
  }

  // ShipStation-brokered (ups_walleted/fedex_walleted/stamps_com/usps) and everything
  // else: ParcelGuard is the only available insurance.
  return {
    required: 'parcelguard',
    carrierPurchasable: false,
    reason: carrierCode
      ? `${carrierCode} — ShipStation-brokered or non-direct account, ParcelGuard only`
      : 'Unknown account — ParcelGuard only',
  };
}

/** PS-170 — effective insured provider for an account, honoring the verify gate. */
export function effectiveInsuranceProviderForAccount(input: {
  shippingProviderId?: number | string | null;
  carrierCode?: string | null;
  serviceCode?: string | number | null;
}): 'parcelguard' | 'carrier' {
  const capability = resolveAccountInsuranceCapability(input);
  return capability.required === 'carrier' && capability.carrierPurchasable ? 'carrier' : 'parcelguard';
}
