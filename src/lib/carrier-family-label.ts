/**
 * PS-216 — operator-safe carrier-family display labels.
 *
 * The Rate Browser disambiguates duplicate account nicknames (two HUGRAB
 * accounts both named "GREG PAYABILITY 6/17") with a HUMAN label derived from
 * the carrier code — "USPS" / "UPS" / "FedEx" — never with provider ids
 * (se-442006, synthetic direct ids, DB ids), which are implementation details
 * that must not leak into operator-facing labels.
 *
 * Pure module (no imports) so the PS-216 guard exercises it offline. The
 * carriers-for-store read DTO stamps this as `display_disambiguator`; the FE
 * consumes it and keeps only a same-shaped defensive fallback.
 */

const FAMILY_LABELS: Record<string, string> = {
  stamps_com: 'USPS',
  usps: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
  dhl_express: 'DHL',
  dhl_express_walleted: 'DHL',
  dhl_ecommerce: 'DHL eCommerce',
  globalpost: 'GlobalPost',
  shipp: 'Shipp',
  easypost: 'EasyPost',
  shipengine: 'ShipEngine',
  walmart_shipping: 'Walmart Shipping',
  ebay_shipping: 'eBay Shipping',
  amazon_shipping: 'Amazon Shipping',
  amazon_buy_shipping: 'Amazon Shipping',
  prepship_test: 'PrepShip Test',
};

/**
 * Human carrier-family label for a carrier/provider code. Returns null when
 * no safe human label can be derived — callers must then show NO suffix
 * rather than falling back to an identifier.
 */
export function carrierFamilyDisplayLabel(code: string | null | undefined): string | null {
  const normalized = String(code ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const known = FAMILY_LABELS[normalized];
  if (known) return known;
  // Unknown codes: only prettify when the code is clearly a word-like token
  // (letters with separators) — anything numeric/opaque yields null so an id
  // can never sneak through as a "label".
  if (!/^[a-z][a-z_\- ]*$/.test(normalized)) return null;
  return normalized
    .split(/[_\- ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
