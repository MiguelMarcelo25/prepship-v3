/**
 * QA audit 2026-06-23 — REAL EXECUTION test: the persisted best rate must rank on the MARKED
 * CUSTOMER CHARGE, not raw provider cost.
 *
 * Reproduces the live bug (orders 1369361 / 1369321): a +15%-markup UPS account that is cheapest by
 * COST ($11.50) was saved as "best" over a cheaper-to-the-CUSTOMER rate (USPS $12.87 → stays $12.87
 * with no markup), because writeRateCache picked pickBestRate(rawRates) on the un-marked cost. The
 * fix picks on applyMarkups(rawRates) so the cheapest CUSTOMER charge wins.
 *
 * Pure + deterministic. Run: npm run test:ps-best-rate-charge-basis-behavior
 */
import { pickBestRate, applyMarkups } from '../src/services/rates';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// A = a UPS account (carrier_id se-777) cheapest by RAW cost ($11.50) but carrying a +15% markup.
const upsAccount = () => ({
  rate_id: 'A', carrier_id: 'se-777', carrier_code: 'ups', service_code: 'ups_ground', service_type: 'UPS Ground',
  shipping_amount: { amount: 11.5, currency: 'USD' }, other_amount: { amount: 0, currency: 'USD' },
}) as any;
// B = a USPS account (se-999) pricier by RAW cost ($12.87) but with NO markup → cheaper to the customer.
const uspsAccount = () => ({
  rate_id: 'B', carrier_id: 'se-999', carrier_code: 'usps', service_code: 'usps_ground_advantage', service_type: 'USPS Ground Advantage',
  shipping_amount: { amount: 12.87, currency: 'USD' }, other_amount: { amount: 0, currency: 'USD' },
}) as any;

// Only the UPS account carries a 15% markup (the live per-account markup that pushed it to $13.22).
const markups = new Map<string, any>([['se-777', { type: 'percent', value: 15 }]]);

// 1. The OLD (buggy) raw-cost basis would pick the UPS account (cheaper cost) — demonstrates the bug.
const rawPick = pickBestRate([upsAccount(), uspsAccount()]);
check('raw-cost basis picks the cheaper-COST UPS account (the bug we are fixing)', rawPick?.carrier_id === 'se-777', rawPick?.carrier_id);

// 2. The FIXED basis: pick on the MARKED customer charge → the USPS account (cheaper to the customer)
//    wins, even though UPS is cheaper by raw cost.
const marked = applyMarkups([upsAccount(), uspsAccount()], markups as any);
const chargePick = pickBestRate(marked);
check('charge basis picks the cheapest-to-CUSTOMER USPS account', chargePick?.carrier_id === 'se-999', chargePick?.carrier_id);

// 3. Sanity: the UPS account really did become pricier than USPS after its markup.
const markedUps = marked.find((r: any) => r.carrier_id === 'se-777') as any;
const markedUsps = marked.find((r: any) => r.carrier_id === 'se-999') as any;
check('UPS marked charge > USPS charge (so picking by cost would overcharge the customer)',
  Number(markedUps.shipping_amount.amount) > Number(markedUsps.shipping_amount.amount),
  { ups: markedUps.shipping_amount.amount, usps: markedUsps.shipping_amount.amount });

// 4. When markups are equal/absent across carriers, the cheapest cost is also the cheapest charge —
//    the fix is a no-op there (no behavior change for the common case).
const noMarkupPick = pickBestRate(applyMarkups([upsAccount(), uspsAccount()], new Map() as any));
check('no markups → cheapest cost is still picked (no regression for the common case)', noMarkupPick?.carrier_id === 'se-777', noMarkupPick?.carrier_id);

if (failures > 0) {
  console.error(`\nbest-rate charge-basis behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nbest-rate charge-basis behavior test passed.');
