/**
 * Walmart ship-from resolution guard.
 *
 * THE BUG (2026-06-16): PrepShip's "Walmart" Rate Browser rates didn't match the
 * order's real origin (and the rates Walmart's own "Ship with Walmart" dialog shows).
 * Root cause: the Walmart connector read input.shipFrom with CAMELCASE field names
 * (postalCode, city, state, addressLine1, country) but input.shipFrom is an `Address`
 * with SNAKE_CASE fields (postal_code, city_locality, state_province, address_line1,
 * country_code — src/lib/shipstation/types.ts). So the selected origin was read as all
 * `undefined` and the connector silently fell back to a hardcoded Carson/"Warehouse"/
 * 90248 default — quoting Walmart from the wrong ship node (the "ship-from-mismatch"
 * the connector's own comment flags).
 *
 * THE FIX: resolveWalmartShipFrom reads the Address snake_case fields (with camelCase
 * + creds + hardcoded as ordered fallbacks) and prefers the SELECTED/resolved origin
 * so PrepShip quotes Walmart from the same origin it displays (and that every other
 * carrier already quotes from).
 *
 *   npx tsx scripts/walmart-ship-from-guard.ts
 */
import { resolveWalmartShipFrom } from '../src/connectors/carrier/walmart-ship-from';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// The real shape PrepShip passes: an `Address` (snake_case) for the GWH/Gardena origin.
const ADDRESS_ORIGIN = {
  name: 'GWH Fulfillment Center',
  address_line1: '413 W Walnut St',
  city_locality: 'Gardena',
  state_province: 'CA',
  postal_code: '90248',
  country_code: 'US',
  phone: '3105551234',
};

{
  // The bug fixed: snake_case Address fields are READ (not dropped to Carson/Warehouse).
  const a = resolveWalmartShipFrom(ADDRESS_ORIGIN, {});
  check('reads Address.city_locality (not the Carson default)', a.city === 'Gardena', `got ${a.city}`);
  check('reads Address.state_province', a.state === 'CA', `got ${a.state}`);
  check('reads Address.postal_code', a.postalCode === '90248', `got ${a.postalCode}`);
  check('reads Address.address_line1 (not the Warehouse default)',
    a.addressLines[0] === '413 W Walnut St', `got ${JSON.stringify(a.addressLines)}`);
  check('reads Address.name (not the Seller default)', a.name === 'GWH Fulfillment Center', `got ${a.name}`);
  check('reads Address.country_code', a.countryCode === 'US', `got ${a.countryCode}`);
}

{
  // The selected origin WINS over creds (display == sent): a creds ship node does not
  // silently override the operator's chosen origin.
  const a = resolveWalmartShipFrom(ADDRESS_ORIGIN, {
    shipFromCity: 'Carson',
    shipFromState: 'CA',
    shipFromZip: '90745',
  });
  check('selected origin wins over creds ship node', a.city === 'Gardena' && a.postalCode === '90248',
    `got ${a.city} ${a.postalCode}`);
}

{
  // Fallback chain: no shipFrom → use creds; then hardcoded default.
  const fromCreds = resolveWalmartShipFrom(null, {
    shipFromCity: 'Carson', shipFromState: 'CA', shipFromZip: '90745', shipFromAddress1: '1 Cred Way',
  });
  check('falls back to creds when no shipFrom', fromCreds.city === 'Carson' && fromCreds.postalCode === '90745');

  const fallbackZip = resolveWalmartShipFrom(null, {}, '78577-8153');
  check('uses the fromZip fallback (cleaned to 5 digits) when neither shipFrom nor creds set',
    fallbackZip.postalCode === '78577', `got ${fallbackZip.postalCode}`);

  const allDefault = resolveWalmartShipFrom(null, {});
  check('last-resort defaults when nothing provided',
    allDefault.postalCode === '90248' && allDefault.city === 'Carson');
}

{
  // camelCase shape still works (defensive — some callers pass camelCase).
  const a = resolveWalmartShipFrom(
    { city: 'Gardena', state: 'CA', postalCode: '90248', addressLine1: '413 W Walnut St' },
    {},
  );
  check('camelCase shipFrom still resolved as a fallback shape',
    a.city === 'Gardena' && a.postalCode === '90248' && a.addressLines[0] === '413 W Walnut St');
}

if (failures > 0) {
  console.error(`\nFAIL Walmart ship-from guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS Walmart ship-from guard');
