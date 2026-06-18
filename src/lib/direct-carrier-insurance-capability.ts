// PS-262 — direct-carrier insurance capability override (canary, default-OFF).
//
// THE INVARIANT (architecture-first, money/liability path):
//   A DIRECT (non-ShipStation) carrier must NEVER resolve to 'parcelguard'.
//   ParcelGuard is a ShipStation-only product; a direct carrier can't actually
//   purchase it, so resolving a direct carrier to 'parcelguard' silently ships
//   the insured (HUGRAB) order UNINSURED. A direct carrier must resolve to
//   'carrier' (the connector itself declares/insures the value — audited) or
//   'blocked' (it cannot insure — the eligibility layer refuses the order rather
//   than shipping it bare).
//
// This is the GENERALIZATION of the PS-262b Walmart-Shipping point fix to every
// direct carrier we can identify UNAMBIGUOUSLY BY CARRIER CODE ALONE. It is gated
// behind the default-OFF `DIRECT_CARRIER_PARCELGUARD_FIX` canary so that, with the
// flag OFF, `resolveAccountInsuranceCapability` is BYTE-IDENTICAL to today (PS-262b
// Walmart block + PS-170 UPS gate + ParcelGuard fallback). DJ flips the flag on
// Render after a canary.
//
// WHY code-only and not every carrier: the registry sees only a carrier code, not
// account context. Bare `ups`/`fedex`/`usps` codes are AMBIGUOUS — a Shipp- or
// ShipStation-brokered rate emits the same bare `fedex` code as a direct-FedEx
// account (see connectors/carrier/shipp.ts `shippCarrierCode` -> 'fedex'). Blocking
// bare `fedex` here would WRONGLY block an insured Shipp/SS-FedEx rate (which DOES
// insure). So those stay on the existing paths:
//   - direct UPS            -> PS-170 verify-gate ('carrier' when verified)
//   - brokered ups/fedex/usps -> 'parcelguard' (ShipStation brokers ParcelGuard fine)
//   - direct FedEx          -> self-blocks at its connector (insurance:false assert);
//                              code-context disambiguation is deferred to PS-261.
//
// The provider codes below ARE unambiguous (never ShipStation-brokered), so the
// override is safe and audited per provider.

export type DirectCarrierInsuranceVerifyFlags = {
  /** EASYPOST_INSURANCE_VERIFIED — proven that EasyPost bills + applies insurance. */
  easyPostInsuranceVerified: boolean;
  /** SHIPP_INSURANCE_VERIFIED — proven that Shipp's declared customsValue actually insures. */
  shippInsuranceVerified: boolean;
};

export type DirectCarrierInsuranceOverride = {
  required: 'carrier' | 'blocked';
  carrierPurchasable: boolean;
  reason: string;
};

/** Normalize a carrier/provider code to the registry's identity form (lowercase, alnum-only). */
function normalizeCarrierCode(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Direct-only marketplace/3PL shipping providers that hardcode `insurance:false`
// (Walmart Shipping audited: getRates/createLabel assert insurance unsupported;
// eBay/Amazon shipping are the same store-scoped family). An insured order on any
// of these CANNOT be insured by the carrier -> 'blocked' (refuse, never ship bare).
const BLOCKED_DIRECT_CARRIER_CODES = new Set([
  'walmartshipping',
  'ebayshipping',
  'amazonshipping',
]);

/**
 * PS-262 — when the canary flag is ON, return the carrier|blocked override for a
 * direct carrier identifiable by code alone, or `null` to fall through to the
 * existing capability logic (PS-170 UPS gate / PS-262b Walmart / ParcelGuard).
 *
 * Pure + deterministic. The per-connector verify flags gate the audited-insuring
 * connectors (EasyPost, Shipp): verified -> 'carrier', unverified -> 'blocked'
 * (NEVER parcelguard) — the "unverified-direct fallback = blocked" rule.
 */
export function resolveDirectCarrierInsuranceOverride(
  carrierCode: string | null | undefined,
  flags: DirectCarrierInsuranceVerifyFlags,
): DirectCarrierInsuranceOverride | null {
  const code = normalizeCarrierCode(carrierCode);
  if (!code) return null;

  if (BLOCKED_DIRECT_CARRIER_CODES.has(code)) {
    return {
      required: 'blocked',
      carrierPurchasable: false,
      reason: `${carrierCode} is a direct marketplace shipping provider that cannot purchase insurance (insurance:false) — insured shipping blocked`,
    };
  }

  // EasyPost — direct connector, audited to APPLY + bill insurance (insurance field;
  // parseEasyPostInsuranceCost reads the billed fee). 'carrier' when verified, else
  // 'blocked'. Never parcelguard (a direct carrier can't buy the ShipStation product).
  if (code === 'easypost') {
    return flags.easyPostInsuranceVerified
      ? {
          required: 'carrier',
          carrierPurchasable: true,
          reason: 'EasyPost — direct carrier insures the declared value (verified)',
        }
      : {
          required: 'blocked',
          carrierPurchasable: false,
          reason: 'EasyPost — direct carrier insurance not yet verified; insured shipping blocked (never ParcelGuard)',
        };
  }

  // Shipp — direct connector, audited to DECLARE the insured value (customsValue),
  // but the application certainty is uncertain (it brokers UPS/FedEx/USPS). 'carrier'
  // when verified, else 'blocked'. Never parcelguard.
  if (code === 'shipp') {
    return flags.shippInsuranceVerified
      ? {
          required: 'carrier',
          carrierPurchasable: true,
          reason: 'Shipp — direct carrier declares the insured value (verified)',
        }
      : {
          required: 'blocked',
          carrierPurchasable: false,
          reason: 'Shipp — direct carrier insurance not yet verified; insured shipping blocked (never ParcelGuard)',
        };
  }

  // Any other carrier code (bare ups/fedex/usps, *_walleted, stamps_com, …) is either
  // ambiguous or genuinely ShipStation-brokered — fall through to the existing logic.
  return null;
}
