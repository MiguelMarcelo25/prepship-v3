// PS-474: an active hazmat declaration must not lose the ship-from phone.
//
// 2026-07-30. Three HU-10 HUGRAB orders (3240, 3241, 3242) were auto-declared
// hazmat and then could not rate. The provider's own words, captured by PS-473:
//
//   HTTP 400 — ShipStation 400: 'phone' should not be empty.
//
// It is NOT the dangerous-goods contact. All three declarations carry
// emergency_contact_phone "310-720-1871" (12 chars, not null). It is the ORIGIN
// phone, and it went missing for a structural reason:
//
//   no hazmat  -> buildShipStationEstimateBody -> /v2/rates/estimate
//                 postal codes only, NO addresses, so no phone is ever sent
//   hazmat     -> buildShipStationFullRateBody -> /v2/rates, rateMode shipment
//                 a full shipment object, so ship_from.phone is suddenly required
//
// getDefaultShipFrom always sets a phone, but rates.ts resolves
// `input.shipFrom ?? await getDefaultShipFrom()` and /rates accepts shipFrom as
// z.object({}).catchall(z.unknown()) -- so a Ship From chosen in the Rate
// Browser bypasses the default. Address.phone is optional, so nothing caught it.
//
// The fix normalises at the ship-from owner, not at the hazmat body, so every
// consumer gets a usable phone rather than only the caller that hit the bug.
import { readFileSync } from 'node:fs';
import { withShipFromPhone } from '../src/lib/ship-from.js';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const rates = readFileSync('src/services/rates.ts', 'utf8');
const shipFromSrc = readFileSync('src/lib/ship-from.ts', 'utf8');

const base = { postal_code: '90248', country_code: 'US' } as const;

// --- behaviour ------------------------------------------------------------
check(
  'a missing phone is filled',
  Boolean(withShipFromPhone({ ...base }).phone),
);
check(
  'an empty-string phone is filled',
  Boolean(withShipFromPhone({ ...base, phone: '' }).phone),
);
check(
  'a whitespace-only phone is filled',
  String(withShipFromPhone({ ...base, phone: '   ' }).phone ?? '').trim().length > 0,
);
check(
  'a real phone is preserved exactly',
  withShipFromPhone({ ...base, phone: '555-123-4567' }).phone === '555-123-4567',
);
check(
  'no other address field is altered',
  (() => {
    const out = withShipFromPhone({
      ...base, name: 'GWH Fulfillment Center', city_locality: 'Gardena', state_province: 'CA',
    });
    return out.name === 'GWH Fulfillment Center'
      && out.city_locality === 'Gardena'
      && out.state_province === 'CA'
      && out.postal_code === '90248'
      && out.country_code === 'US';
  })(),
);
check(
  'the input object is not mutated',
  (() => {
    const input = { ...base } as { phone?: string };
    withShipFromPhone(input as never);
    return input.phone === undefined;
  })(),
);

// --- wiring: BOTH origin resolutions are normalised -----------------------
// The bug was one un-normalised resolution, so pin that neither reverts to a
// bare `input.shipFrom ?? await getDefaultShipFrom()`.
check(
  'the shipstation origin is normalised',
  rates.includes('withShipFromPhone(input.shipFrom ?? (await getDefaultShipFrom()))'),
);
check(
  'both origin resolutions are normalised',
  (rates.match(/withShipFromPhone\(input\.shipFrom \?\? \(await getDefaultShipFrom\(\)\)\)/g) ?? []).length >= 2,
);
check(
  'no un-normalised origin resolution remains',
  !/(?<!withShipFromPhone\()input\.shipFrom \?\? \(await getDefaultShipFrom\(\)\)/.test(rates),
);
check(
  'the owner still guarantees a phone on the default path',
  shipFromSrc.includes('phone: loc.phone || fallbackPhone()')
    && shipFromSrc.includes('phone: fallbackPhone()'),
);
// The hazmat body is what exposed this; keep the recipient phone non-empty too.
check(
  'the hazmat shipment still sends a non-empty ship_to phone',
  /ship_to: \{[\s\S]*?phone: '[^']+'/.test(rates),
);

if (failures > 0) {
  console.error(`\nFAIL PS-474 hazmat ship-from phone guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-474 hazmat ship-from phone guard');
