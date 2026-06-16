/**
 * Carrier ship-from CLASS guard (future-proof, all connectors).
 *
 * THE BUG CLASS (2026-06-16): the canonical origin is an `Address` (snake_case:
 * postal_code / city_locality / state_province / address_line1 / country_code —
 * src/lib/shipstation/types.ts). Multiple connectors (ups, shipp, easypost, ebay,
 * shipengine, amazon, and formerly walmart) read it with camelCase / wrong field
 * names (postalCode, city, state, addressLine1, street1, zip, country) — which read
 * undefined for an Address — and silently fell back to a hardcoded Carson/Warehouse/
 * 90248 origin. Every carrier was quoted/labeled from the WRONG ship-from.
 *
 * THE FIX (one canonical owner): src/connectors/carrier/ship-from-address.ts
 * readShipFrom() reads the Address correctly (camelCase + creds + default as ordered
 * fallbacks) and returns a neutral normalized shape every connector maps to its own
 * API fields. This guard has TWO parts:
 *   (A) behavior — readShipFrom reads snake_case Address and prefers the selected origin.
 *   (B) structure — NO connector reads ship-from address fields directly off input.shipFrom;
 *       they must delegate to readShipFrom. A new connector physically cannot reintroduce
 *       the class.
 *
 *   npx tsx scripts/connector-ship-from-guard.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { readShipFrom } from '../src/connectors/carrier/ship-from-address';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── (A) behavior: the canonical reader reads the snake_case Address ───────────
const ADDRESS = {
  name: 'GWH Fulfillment Center',
  company_name: 'DR PREPPER USA',
  address_line1: '413 W Walnut St',
  address_line2: 'Suite 5',
  city_locality: 'Gardena',
  state_province: 'CA',
  postal_code: '90248',
  country_code: 'US',
  phone: '3105551234',
};
{
  const a = readShipFrom(ADDRESS, {});
  check('snake_case city_locality → city', a.city === 'Gardena', a.city);
  check('snake_case state_province → state', a.state === 'CA', a.state);
  check('snake_case postal_code → postalCode', a.postalCode === '90248', a.postalCode);
  check('snake_case address_line1 → line1', a.line1 === '413 W Walnut St', a.line1);
  check('snake_case address_line2 → line2', a.line2 === 'Suite 5', a.line2);
  check('snake_case country_code → country (upper)', a.country === 'US', a.country);
  check('snake_case company_name → company', a.company === 'DR PREPPER USA', a.company);
  check('name read', a.name === 'GWH Fulfillment Center', a.name);
}
{
  // selected origin wins over a creds ship node (display == sent)
  const a = readShipFrom(ADDRESS, { shipFromCity: 'Carson', shipFromState: 'CA', shipFromZip: '90745' });
  check('selected origin wins over creds', a.city === 'Gardena' && a.postalCode === '90248');
}
{
  const fromCreds = readShipFrom(null, { shipFromCity: 'Carson', shipFromZip: '90745', shipFromAddress1: '1 Cred Way' });
  check('creds fallback when no shipFrom', fromCreds.city === 'Carson' && fromCreds.postalCode === '90745');
  const viaFallbackZip = readShipFrom(null, {}, '78577-8153');
  check('fallbackZip used + cleaned to 5 digits', viaFallbackZip.postalCode === '78577', viaFallbackZip.postalCode);
  const def = readShipFrom(null, {});
  check('last-resort defaults', def.postalCode === '90248' && def.city === 'Carson');
}
{
  // camelCase Address shape still tolerated
  const a = readShipFrom({ city: 'Gardena', state: 'CA', postalCode: '90248', street1: '413 W Walnut St' }, {});
  check('camelCase shape tolerated', a.city === 'Gardena' && a.postalCode === '90248' && a.line1 === '413 W Walnut St');
}

// ── (B) structure: no connector reads ship-from fields directly ───────────────
// Any connector that reads a ship-from address field off input.shipFrom with the
// wrong (camelCase / non-Address) names is a latent Carson-default bug. The ONLY
// place allowed to read both casings is the canonical reader itself.
const CONNECTOR_DIR = 'src/connectors/carrier';
const ALLOWED = new Set(['ship-from-address.ts', 'walmart-ship-from.ts']);
// Patterns that indicate a connector is reading a ship-from address field directly
// (a shipFrom-ish variable .<addressField>) instead of via readShipFrom.
// The raw origin variables (input.shipFrom / a `shipFrom`/`shipFromInput` alias) read with
// camelCase / non-Address field names. The canonical reader returns a NEUTRAL object the
// connectors name `from`/`a`/`resolved`/`origin` — those are intentionally NOT matched.
const BAD_READ = /\b(shipFrom|shipFromInput)\s*[?.]?\.\s*(postalCode|city|state|addressLine1|addressLine2|street1|street2|zip|country)\b/;
const files = readdirSync(CONNECTOR_DIR).filter((f) => f.endsWith('.ts') && !ALLOWED.has(f));
// A connector building its own origin with hardcoded Carson/Warehouse defaults (amazon's
// old manifestation) is the same class — those literals belong ONLY to the canonical reader.
const HARDCODED_ORIGIN = /'(Carson|Warehouse)'/;
for (const file of files) {
  const src = readFileSync(`${CONNECTOR_DIR}/${file}`, 'utf8');
  const offending = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => BAD_READ.test(line) && !line.startsWith('//') && !line.startsWith('*'));
  check(`${file}: no direct ship-from address-field reads (use readShipFrom)`,
    offending.length === 0,
    offending.length ? `lines ${offending.map((o) => o.n).join(',')}` : undefined);
  // A connector that builds an origin with hardcoded Carson/Warehouse but does NOT go
  // through the canonical reader is the amazon-style manifestation of the class. Once a
  // connector imports readShipFrom, a remaining literal is just a harmless redundant fallback.
  const usesCanonical = src.includes('readShipFrom') || src.includes('resolveWalmartShipFrom');
  check(`${file}: builds its origin via readShipFrom (no standalone hardcoded Carson/Warehouse)`,
    !HARDCODED_ORIGIN.test(src) || usesCanonical);
}

if (failures > 0) {
  console.error(`\nFAIL connector ship-from guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS connector ship-from guard');
