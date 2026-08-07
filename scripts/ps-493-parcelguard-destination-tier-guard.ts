/**
 * PS-493 ParcelGuard destination-tier guard.
 *
 * Offline: the REAL premium function. No provider, no postage, no production.
 *
 * Two defects, pointing in OPPOSITE directions, from one root cause — there was no single
 * owner of "is this destination international":
 *
 *   1. The label path called parcelGuardScheduledPremium with only two arguments, so
 *      `toCountry ?? 'US'` priced every insured non-US label at the DOMESTIC tier while
 *      the rate path had quoted $1.39. An omitted argument was indistinguishable from a
 *      stated US destination, and the two-argument call typechecked cleanly.
 *   2. The tier test was `country !== 'US' && country !== 'USA'`, which is the exact
 *      mistake billing-destination-international.ts warns about in its own header: Puerto
 *      Rico carries 'PR', is not 'US', and ships at USPS DOMESTIC rates. Every PR/VI/GU
 *      shipment was quoted the international tier.
 *
 * Blast radius when fixed was nil — PrepShip has never originated a non-US label (PS-492),
 * so no customer was mischarged. This guard exists so that stays true when it can.
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

const { parcelGuardScheduledPremium } = await import('../src/services/shipping-workflow/insurance-cost');

const ups = { carrier_code: 'ups', service_code: 'ups_ground' };
const usps = { carrier_code: 'stamps_com', service_code: 'usps_priority_mail' };
/** $100 insured => exactly one increment, so the premium IS the per-hundred rate. */
const premium = (country: string | null, rate: Record<string, unknown> = ups) =>
  parcelGuardScheduledPremium(100, rate as never, country);

// ── defect 2: the territories ──────────────────────────────────────────────
// THE assertion. PR/VI/GU are not 'US' but they ship domestically. A naive
// `country !== 'US'` prices them at $1.39 and overcharges every one.
for (const territory of ['PR', 'VI', 'GU', 'AS', 'MP', 'UM']) {
  check(`${territory} prices at the DOMESTIC tier (it ships at USPS domestic rates)`,
    premium(territory) === 0.99, { territory, got: premium(territory) });
}
check('a territory on USPS still gets the USPS domestic tier, not the international one',
  premium('PR', usps) === 1.09, premium('PR', usps));

// ── genuine international ──────────────────────────────────────────────────
for (const country of ['CA', 'GB', 'ca', 'MH']) {
  check(`${country} prices at the INTERNATIONAL tier`,
    premium(country) === 1.39, { country, got: premium(country) });
}

// ── domestic and its aliases ───────────────────────────────────────────────
for (const domestic of ['US', 'us', 'USA', 'United States']) {
  check(`${JSON.stringify(domestic)} prices domestic`, premium(domestic) === 0.99,
    { domestic, got: premium(domestic) });
}
check('USPS domestic is the $1.09 tier (PS-171 is unchanged by this fix)',
  premium('US', usps) === 1.09, premium('US', usps));

// ── unknown country ────────────────────────────────────────────────────────
// A premium must be a number, so unknown prices DOMESTIC. Deliberate: 71,985 of 72,444
// orders are US, and per PS-492 an international label cannot be originated at all today.
for (const unknown of [null, '', '   ', 'N/A']) {
  check(`an unknown country ${JSON.stringify(unknown)} prices domestic rather than $1.39`,
    premium(unknown as string | null) === 0.99, { unknown, got: premium(unknown as string | null) });
}

// ── the increment maths still holds ────────────────────────────────────────
check('increments round UP per $100 (250 insured => 3 increments)',
  parcelGuardScheduledPremium(250, ups as never, 'CA') === Number((3 * 1.39).toFixed(2)),
  parcelGuardScheduledPremium(250, ups as never, 'CA'));
check('a zero/negative insured value yields no premium',
  parcelGuardScheduledPremium(0, ups as never, 'CA') === null
  && parcelGuardScheduledPremium(-5, ups as never, 'CA') === null);
check('an unknown carrier still yields no premium on a DOMESTIC destination',
  parcelGuardScheduledPremium(100, {} as never, 'US') === null);
// International short-circuits before the carrier is consulted — that is intentional:
// the international tier is carrier-independent in the schedule.
check('an international destination prices even without a carrier code',
  parcelGuardScheduledPremium(100, {} as never, 'CA') === 1.39);

// ── defect 1: the label path must thread the country ───────────────────────
const cost = readFileSync('src/services/shipping-workflow/insurance-cost.ts', 'utf8').replace(/\r\n/g, '\n');
const labels = readFileSync('src/services/labels.ts', 'utf8').replace(/\r\n/g, '\n');
const recovery = readFileSync('src/services/verified-forward-label-recovery.ts', 'utf8').replace(/\r\n/g, '\n');

check('the tier delegates to the canonical destination owner',
  /classifyDestinationCountry\(toCountry\)\.destination === 'International'/.test(cost));

// Strip comments before the "must not contain" checks. The doc comments here QUOTE the
// old broken comparison to explain the fix, and an earlier version of this guard failed
// on its own explanation. Only executable code counts.
const codeOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
const costCode = codeOf(cost);

// THE placement assertion. Re-introducing this comparison re-creates the PR bug.
check('insurance-cost does NOT re-derive international from a country comparison',
  !/country\s*!==\s*'US'/.test(costCode),
  "use classifyDestinationCountry — PR is not 'US' but ships domestically");
check('insurance-cost no longer defaults a missing country to US',
  !/toCountry \?\? 'US'/.test(costCode),
  'defaulting hid the difference between "omitted" and "US" — that WAS the bug');

// Required, not optional: this is what makes the compiler catch the next forgetful caller.
// Scoped to the EXPORTED function — the private parcelGuardPerHundred keeps an optional
// parameter, which is fine because every caller of it is in this file.
const exported = costCode.slice(costCode.indexOf('export function parcelGuardScheduledPremium'));
const exportedSignature = exported.slice(0, exported.indexOf('): number | null {'));
check('parcelGuardScheduledPremium REQUIRES the destination country',
  /toCountry: string \| null,/.test(exportedSignature)
  && !/toCountry\?:/.test(exportedSignature),
  'an optional parameter restores the silent-domestic hole');
check('persistCreatedLabel REQUIRES the destination country',
  /toCountry: string \| null;/.test(labels) && !/toCountry\?: string \| null;/.test(labels));

// All three persistence sites and the preflight must actually pass one.
check('the post-purchase persistence prices against the threaded country',
  /service_code: created\.serviceCode \?\? null,[\s\S]{0,400}?\}, args\.toCountry\)/.test(labels));
check('the preflight prices against the SEALED provider address, not body.shipTo',
  /\}, carrierShipTo\.country \?\? null\)/.test(labels),
  'body.shipTo is overridden on an authorized purchase, so it would be the wrong country');
check('the main label path passes the sealed country into persistence',
  /toCountry: carrierShipTo\.country \?\? null,/.test(labels));
check('the RECOVERY path passes a country — it can carry parcelguard, so it prices premiums',
  /toCountry: orderShipToCountryFromRaw\(order\),/.test(recovery));
check('the country extractor returns null for a missing country instead of assuming US',
  /export function orderShipToCountryFromRaw[\s\S]{0,600}?country\.trim\(\) !== ''\s*\? country\s*:\s*null/.test(labels));

if (failures > 0) {
  console.error(`\nFAIL PS-493 ParcelGuard destination tier guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-493 ParcelGuard destination tier guard');
