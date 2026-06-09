// PS-126 — Canonical owner of postal-code normalization for shipping / rating.
//
// THE RULE:
//   - Canonical ShipStation rating & labeling use the EXACT postal code when known
//     (US ZIP+4 like "11364-2081"), because UPS/ShipStation negotiated rates can
//     differ by exact ZIP+4. NEVER truncate the exact postal before a ShipStation
//     rate request or selected-rate proof.
//   - ZIP5 is ONLY a compatibility / reference-rate derivative — for direct-carrier
//     connectors that require 5 digits and for billing reference rates. It is not the
//     canonical rate postal code.
//
// Every caller should use `.exact` for ShipStation rating/labeling and `.zip5` ONLY
// where a provider/billing path explicitly requires 5 digits — so nobody keeps
// copying `slice(0, 5)`.

export type NormalizedPostalCode = {
  /**
   * Exact, provider-ready postal code:
   *  - US with +4 -> "11364-2081"; US 5-digit -> "11364"
   *  - non-US -> trimmed, uppercased as-is (never truncated to 5)
   *  - blank/invalid -> null
   */
  exact: string | null;
  /**
   * 5-digit compatibility form for US (direct carriers / billing ref rates).
   * For non-US this equals `exact` (no 5-digit concept). Blank -> null.
   */
  zip5: string | null;
};

function isUsCountry(country?: string | null): boolean {
  const cc = String(country ?? 'US').trim().toUpperCase();
  return cc === '' || cc === 'US' || cc === 'USA';
}

/**
 * Normalize a postal code into its exact (ZIP+4-preserving) and zip5-compatibility
 * forms. Examples (US):
 *   "11364-2081" -> { exact: "11364-2081", zip5: "11364" }
 *   "113642081"  -> { exact: "11364-2081", zip5: "11364" }
 *   "11364"      -> { exact: "11364",      zip5: "11364" }
 *   ""/null      -> { exact: null,         zip5: null }
 * Non-US (e.g. CA "K1A 0B1") -> { exact: "K1A 0B1", zip5: "K1A 0B1" } (never truncated).
 */
export function normalizeShippingPostalCode(
  postal: string | null | undefined,
  country?: string | null,
): NormalizedPostalCode {
  const raw = String(postal ?? '').trim();
  if (!raw) return { exact: null, zip5: null };

  if (!isUsCountry(country)) {
    const up = raw.toUpperCase();
    return { exact: up, zip5: up };
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 9) {
    const z5 = digits.slice(0, 5);
    return { exact: `${z5}-${digits.slice(5, 9)}`, zip5: z5 };
  }
  if (digits.length >= 5) {
    const z5 = digits.slice(0, 5);
    return { exact: z5, zip5: z5 };
  }
  // Fewer than 5 digits = not a valid US ZIP; preserve what we have (callers still
  // validate length) and never fabricate a +4.
  const fallback = digits || raw.toUpperCase();
  return { exact: fallback, zip5: fallback };
}

// PS-139: removed dead convenience wrappers exactShippingPostalCode / zip5ShippingPostalCode
// (0 callers; callers use normalizeShippingPostalCode(...).exact / .zip5 directly).
