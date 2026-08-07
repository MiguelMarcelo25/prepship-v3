/**
 * PS-492 international origination guard.
 *
 * Offline: the REAL policy. No provider, no postage, no production.
 *
 * PrepShip cannot originate an international label, and until this gate the label purchase
 * funnel did not say so — its guard chain (scope, shipped/cancelled lock, shipping safety,
 * quote authorization, hazmat, insurance, PO-Box, residential parity, carrier-family
 * eligibility, weight) contained NO destination check. An operator could start a purchase
 * that cannot succeed.
 *
 * Four independent blockers make it impossible, any one sufficient: the canonical service
 * catalog holds zero international service codes; the ShipStation label body has no
 * customs key and no builder to delegate to; there was no country guard; and quote
 * authorization uppercases without ISO-2 aliasing so 'Canada' seals as 'CANADA' while the
 * rate priced 'CA'. Production agrees: 0 of 1,101 PrepShip-originated labels are
 * international.
 *
 * THE two assertions here are the ones that would break real shipping if wrong:
 *   - US territories must PASS. PR/VI/GU are not 'US' but ship domestically. Blocking them
 *     would refuse working domestic labels — the same trap PS-493 fixed in the ParcelGuard
 *     tier, and the one billing-destination-international.ts warns about in its header.
 *   - An UNKNOWN country must PASS. 293 production orders carry no country at all.
 *     Refusing them would break currently-working shipments to prevent a hypothetical one.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const {
  assertInternationalOriginationSupported,
  isInternationalOriginationUnsupportedError,
} = await import('../src/services/shipping-workflow/international-origination-policy');

function refuses(toCountry: unknown): boolean {
  try {
    assertInternationalOriginationSupported({ toCountry });
    return false;
  } catch (err) {
    return isInternationalOriginationUnsupportedError(err);
  }
}

// ── international destinations are refused ─────────────────────────────────
for (const country of ['CA', 'ca', 'GB', 'MH', 'DE', 'AU']) {
  check(`${country} is refused before any provider call`, refuses(country));
}

// ── THE assertion: domestic must still ship ────────────────────────────────
// PR/VI/GU are NOT 'US' but ship at USPS domestic rates. A naive country !== 'US' here
// would refuse working domestic labels.
for (const domestic of ['US', 'us', 'USA', 'United States', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM']) {
  check(`${JSON.stringify(domestic)} is allowed — it ships domestically`, !refuses(domestic));
}

// ── THE other assertion: unknown must not be refused ───────────────────────
// 293 production orders carry no country. Blocking them breaks real shipping.
for (const unknown of [null, undefined, '', '   ', 'N/A', '-', 90210, {}]) {
  check(`an unknown country ${JSON.stringify(unknown)} is ALLOWED, not refused`,
    !refuses(unknown), 'refusing unknown would break 293 domestic orders');
}

// ── the refusal is actionable ──────────────────────────────────────────────
try {
  assertInternationalOriginationSupported({ toCountry: 'CA' });
  check('a refusal actually throws', false);
} catch (err) {
  const e = err as { code?: string; message?: string; details?: { toCountry?: string } };
  check('the error carries a stable machine code',
    e.code === 'INTERNATIONAL_ORIGINATION_UNSUPPORTED', e.code);
  check('the message names the country the operator tried', /\bCA\b/.test(String(e.message)));
  check('the message says what to do instead, not just that it failed',
    /ShipStation|directly with the carrier/i.test(String(e.message)), e.message);
  check('the details carry the destination for logging', e.details?.toCountry === 'CA');
}

// ── placement ──────────────────────────────────────────────────────────────
const policy = readFileSync('src/services/shipping-workflow/international-origination-policy.ts', 'utf8').replace(/\r\n/g, '\n');
const labels = readFileSync('src/services/labels.ts', 'utf8').replace(/\r\n/g, '\n');
const labelsCode = labels
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

check('the policy delegates to the canonical destination classifier',
  /classifyDestinationCountry\(input\.toCountry\)/.test(policy));
check('the policy does NOT re-derive international from a country comparison',
  !/country\s*[!=]==?\s*['"]US['"]/.test(policy.replace(/\/\*[\s\S]*?\*\//g, '')),
  'PR is not US but ships domestically');
check('only a positively-International destination is refused',
  /destination !== 'International'\) return;/.test(policy),
  'anything else, including unknown, must pass');

check('the label purchase funnel calls the gate',
  /assertInternationalOriginationSupported\(\{ toCountry: carrierShipTo\.country \}\)/.test(labelsCode));
// carrierShipTo is the SEALED provider address. Gating body.shipTo instead would miss an
// authorized quote whose country differs from the request body.
check('the gate checks the SEALED provider address, not the request body',
  !/assertInternationalOriginationSupported\(\{ toCountry: body\./.test(labelsCode));
// It must run before the test-label branch too: a mock success for a destination PrepShip
// cannot ship to teaches the operator the wrong thing.
const gateAt = labelsCode.indexOf('assertInternationalOriginationSupported({');
const testLabelAt = labelsCode.indexOf('if (body.testLabel === true) {');
check('the gate runs BEFORE the test-label branch',
  gateAt > 0 && testLabelAt > 0 && gateAt < testLabelAt, { gateAt, testLabelAt });
// Search AFTER the gate for the durable purchase call. A bare indexOf finds the IMPORT of
// consumeFulfillmentOperation at the top of the file, which is always earlier than the
// gate and made this check pass for the wrong reason.
check('the durable purchase operation runs AFTER the gate',
  gateAt > 0 && labelsCode.indexOf('const consumed = await consumeFulfillmentOperation(', gateAt) > gateAt,
  'a refusal after the provider call would be too late');

if (failures > 0) {
  console.error(`\nFAIL PS-492 international origination guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-492 international origination guard');
