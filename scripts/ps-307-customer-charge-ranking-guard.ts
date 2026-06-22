/**
 * PS-307 guard — Best Rate comparison ranks by the marked-up CUSTOMER charge.
 *
 * Drives the real comparison owner (rates-combined.rateTotal — which rates.ts rateTotal,
 * and therefore pickBestRate + the priced.sort, delegate to) and asserts the card's core
 * rule: a house-like rate that is CHEAPER on raw provider cost but MORE EXPENSIVE to the
 * customer must NOT win Best Rate. Also pins that applyMarkups stamps the explicit
 * customer charge and that selection uses combinedRateTotal (so this unit proof maps to
 * the live pipeline).
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no marketplace,
 * no Trello mutation, no shipped/cancelled mutation.
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
// Legacy row with no explicit customer field → rateTotal falls back to shipping_amount.amount.
const legacy = { shipping_amount: { amount: 9 } } as unknown as CombinableRate;

check('rateTotal ranks house by CUSTOMER charge (13), not raw cost (8)', rateTotal(house) === 13, rateTotal(house));
check('rateTotal(normal) = 10', rateTotal(normal) === 10, rateTotal(normal));
check('rateTotal(legacy) falls back to shipping_amount (9)', rateTotal(legacy) === 9, rateTotal(legacy));

// The card's rule: cheapest-by-customer wins, NOT cheapest-by-raw-cost.
const winner = [house, normal, legacy].slice().sort((a, b) => rateTotal(a) - rateTotal(b))[0];
check('cheapest-by-customer-charge wins (legacy 9), house does NOT win despite cheapest raw cost',
  winner === legacy, { winnerTotal: winner ? rateTotal(winner) : null });
check('house would have WRONGLY won if ranked by raw cost (8 is the lowest raw)',
  rateCostTotal(house) === 8 && rateCostTotal(house) < rateTotal(normal), { houseRaw: rateCostTotal(house) });

// Two-rate isolation: house (raw 8 / cust 13) vs normal (10) → normal wins on customer charge.
const headToHead = [house, normal].slice().sort((a, b) => rateTotal(a) - rateTotal(b))[0];
check('head-to-head: normal (customer 10) beats house (customer 13) despite house raw 8',
  headToHead === normal, headToHead ? rateTotal(headToHead) : null);

// Pipeline wiring: applyMarkups stamps the explicit customer charge, and selection uses combinedRateTotal.
const ratesSrc = read('src/services/rates.ts');
check('applyMarkups stamps customerShippingAmount (explicit customer charge in the real read path)',
  /customerShippingAmount: marked/.test(ratesSrc));
check('rates.ts rateTotal delegates to the combined comparison owner',
  /function rateTotal\(rate: Rate\): number\s*\{\s*return combinedRateTotal/.test(ratesSrc));
check('pickBestRate + priced.sort rank via rateTotal',
  /\.sort\(\(a, b\) => rateTotal\(a\) - rateTotal\(b\)\)/.test(ratesSrc));

if (failures > 0) {
  console.error(`\nPS-307 customer-charge ranking guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-307 customer-charge ranking guard passed.');
