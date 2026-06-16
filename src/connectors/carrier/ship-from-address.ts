// THE single canonical reader of a carrier ship-from origin.
//
// Why this exists (2026-06-16): the origin passed to connectors (input.shipFrom) is an
// `Address` with SNAKE_CASE fields (src/lib/shipstation/types.ts: postal_code /
// city_locality / state_province / address_line1 / country_code / company_name). Several
// connectors independently re-read it with CAMELCASE / wrong names (postalCode, city,
// state, addressLine1, street1, zip, country) — which read undefined for an Address — and
// silently quoted/labeled from a hardcoded Carson/"Warehouse"/90248 default. That is the
// "ship-from mismatch" bug class (ups, shipp, easypost, ebay, shipengine, amazon, walmart).
//
// EVERY connector must read its origin through readShipFrom so the class can never recur
// (enforced by scripts/connector-ship-from-guard.ts). Pure + dependency-free → offline
// testable. Returns a NEUTRAL normalized shape; each connector maps it to its own API
// field names (street1 vs address_line1 vs addressLine1, zip vs postalCode, etc.).

export type NormalizedShipFrom = {
  name: string;
  company: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  /** US ZIP normalized to 5 digits. */
  postalCode: string;
  /** ISO-2, upper-cased. */
  country: string;
};

/** First non-empty trimmed string among the candidates, else ''. */
function first(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function cleanZip(value: unknown): string {
  return String(value ?? '').replace(/[^0-9]/g, '').slice(0, 5);
}

/**
 * Resolve a ship-from origin. Priority per field: the selected/resolved origin
 * (`shipFrom` — snake_case `Address` preferred, camelCase tolerated) → per-account
 * `creds` ship-from config → hardcoded last-resort default. `fallbackZip` is the
 * caller's already-resolved 5-digit origin ZIP (input.fromZip), tried before creds/default.
 */
export function readShipFrom(
  shipFrom: Record<string, unknown> | null | undefined,
  creds?: Record<string, unknown> | null,
  fallbackZip?: unknown,
): NormalizedShipFrom {
  const sf = (shipFrom ?? {}) as Record<string, unknown>;
  const cr = (creds ?? {}) as Record<string, unknown>;
  return {
    name: first(sf.name, cr.shipFromName, 'Seller'),
    company: first(sf.company_name, sf.company, cr.shipFromCompany),
    phone: first(sf.phone, cr.shipFromPhone, '0000000000'),
    line1: first(sf.address_line1, sf.addressLine1, sf.street1, cr.shipFromAddress1, 'Warehouse'),
    line2: first(sf.address_line2, sf.addressLine2, sf.street2, cr.shipFromAddress2),
    city: first(sf.city_locality, sf.city, cr.shipFromCity, 'Carson'),
    state: first(sf.state_province, sf.state, cr.shipFromState, 'CA'),
    postalCode: cleanZip(first(sf.postal_code, sf.postalCode, sf.zip, fallbackZip, cr.shipFromZip, '90248')),
    country: (first(sf.country_code, sf.country, 'US') || 'US').toUpperCase(),
  };
}
