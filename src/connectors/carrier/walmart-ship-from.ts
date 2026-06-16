// Canonical owner of the ship-from PrepShip sends to Walmart's shipping-estimates API.
//
// Why this exists (2026-06-16): the Walmart connector used to read input.shipFrom with
// camelCase field names (postalCode/city/state/addressLine1/country), but input.shipFrom
// is an `Address` with snake_case fields (postal_code/city_locality/state_province/
// address_line1/country_code — src/lib/shipstation/types.ts). The selected origin was
// therefore read as all-undefined and the connector silently quoted Walmart from a
// hardcoded Carson/"Warehouse"/90248 default — the "ship-from-mismatch" the connector's
// own diagnostic comment flags, and why PrepShip's Walmart rates didn't match the order.
//
// This pure resolver reads the snake_case Address first (with camelCase + creds + a
// last-resort default as ordered fallbacks) and prefers the SELECTED/resolved origin so
// PrepShip quotes Walmart from the same origin it displays and that every other carrier
// already quotes from. Pure + dependency-free so it is offline-testable.

export type WalmartFromAddress = {
  name: string;
  addressLines: string[];
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  phone: string;
};

/** First non-empty trimmed string among the candidates, else ''. */
function first(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** US ZIP normalized to 5 digits (Walmart estimates want a 5-digit origin ZIP). */
function cleanZip(value: unknown): string {
  return String(value ?? '').replace(/[^0-9]/g, '').slice(0, 5);
}

/**
 * Resolve the Walmart ship-from. Priority: the selected/resolved origin (`shipFrom`,
 * an `Address` — snake_case preferred, camelCase tolerated) → per-account creds
 * ship-from config → hardcoded last-resort default. `fallbackZip` is the connector's
 * already-resolved 5-digit origin ZIP (input.fromZip), used before the creds/default ZIP.
 */
export function resolveWalmartShipFrom(
  shipFrom: Record<string, unknown> | null | undefined,
  creds: Record<string, unknown> | null | undefined,
  fallbackZip?: unknown,
): WalmartFromAddress {
  const sf = (shipFrom ?? {}) as Record<string, unknown>;
  const cr = (creds ?? {}) as Record<string, unknown>;

  const line1 = first(sf.address_line1, sf.addressLine1, sf.street1, cr.shipFromAddress1, 'Warehouse');
  const line2 = first(sf.address_line2, sf.addressLine2, sf.street2, cr.shipFromAddress2);

  return {
    name: first(sf.name, cr.shipFromName, 'Seller'),
    addressLines: [line1, line2].filter(Boolean),
    city: first(sf.city_locality, sf.city, cr.shipFromCity, 'Carson'),
    state: first(sf.state_province, sf.state, cr.shipFromState, 'CA'),
    postalCode: cleanZip(first(sf.postal_code, sf.postalCode, fallbackZip, cr.shipFromZip, '90248')),
    countryCode: first(sf.country_code, sf.country, 'US'),
    phone: first(sf.phone, cr.shipFromPhone, '0000000000'),
  };
}
