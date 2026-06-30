/**
 * PS-307/PS-356 guard - customer charge is preserved, Best Rate ranks by
 * marked/customer charge.
 *
 * Drives the real money owners: rates-combined.rateTotal for marked/customer
 * ranking and rateCostTotal for the internal cost line. A house-like rate with
 * cheaper internal cost must lose Best Rate when its marked customer charge is
 * higher.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace, no Trello mutation, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { rateTotal, rateCostTotal, type CombinableRate } from '../src/services/rates-combined';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// House-like row: raw provider cost 8 (cheapest), but customer charge 13 (most expensive).
const house = { shipping_amount: { amount: 8 }, cost: 8, rateCostAmount: 8, customerShippingAmount: 13 } as unknown as CombinableRate;
// Normal row: marked customer charge 10 (== shipping_amount after applyMarkups).
const normal = { shipping_amount: { amount: 10 }, customerShippingAmount: 10 } as unknown as CombinableRate;
// Legacy row with no explicit customer field -> rateTotal falls back to shipping_amount.amount.
const legacy = { shipping_amount: { amount: 9 } } as unknown as CombinableRate;

check('rateTotal ranks house by CUSTOMER charge (13), not raw cost (8)', rateTotal(house) === 13, rateTotal(house));
check('rateTotal(normal) = 10', rateTotal(normal) === 10, rateTotal(normal));
check('rateTotal(legacy) falls back to shipping_amount (9)', rateTotal(legacy) === 9, rateTotal(legacy));

// PS-356: cheapest marked/customer charge wins Best Rate; internal cost stays separate.
const winner = [house, normal, legacy].slice().sort((a, b) => rateTotal(a) - rateTotal(b) || rateCostTotal(a) - rateCostTotal(b))[0];
check('cheapest marked/customer charge wins Best Rate (legacy 9)',
  winner === legacy, { winnerCost: winner ? rateCostTotal(winner) : null, winnerCustomer: winner ? rateTotal(winner) : null });
check('house still carries the higher customer charge separately for C. Shipping',
  rateCostTotal(house) === 8 && rateTotal(house) === 13, { houseRaw: rateCostTotal(house), houseCustomer: rateTotal(house) });

// Two-rate isolation: house (raw 8 / customer 13) vs normal (10) -> normal wins by customer charge.
const headToHead = [house, normal].slice().sort((a, b) => rateTotal(a) - rateTotal(b) || rateCostTotal(a) - rateCostTotal(b))[0];
check('head-to-head: normal customer charge 10 beats house customer charge 13 despite higher internal cost',
  headToHead === normal, headToHead ? { cost: rateCostTotal(headToHead), customer: rateTotal(headToHead) } : null);

// Pipeline wiring: applyMarkups stamps the explicit customer charge, and selection uses combinedRateTotal.
const ratesSrc = read('src/services/rates.ts');
check('applyMarkups stamps customerShippingAmount (explicit customer charge in the real read path)',
  /customerShippingAmount: marked/.test(ratesSrc));
check('rates.ts rateCostTotal delegates to the combined internal-cost owner',
  /function rateCostTotal\(rate: Rate\): number\s*\{\s*return combinedRateCostTotal/.test(ratesSrc));
check('rates.ts rateTotal still delegates to the combined customer amount owner',
  /function rateTotal\(rate: Rate\): number\s*\{\s*return combinedRateTotal/.test(ratesSrc));
check('pickBestRate + priced.sort rank via rateTotal before rateCostTotal tie-break',
  /rateTotal\(a\) - rateTotal\(b\)\) \|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)/.test(ratesSrc));

if (failures > 0) {
  console.error(`\nPS-307 customer-charge ranking guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-307 customer-charge ranking guard passed.');
