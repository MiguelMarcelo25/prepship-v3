/**
 * PS-307 — REAL EXECUTION test for the direct-carrier markup ranking path.
 *
 * The QA audit (2026-06-23) found the PS-307 "byte-identical" comment was wrong for
 * direct-carrier rates, and that no test exercised the toDirectRate + applyMarkups + rateTotal
 * precedence interaction. This drives the REAL applyMarkups (the lift path) and the REAL
 * rateTotal (the comparison owner pickBestRate/priced.sort delegate to), proving:
 *   - a direct rate carries the UN-marked amount in customerShippingAmount before markup
 *     (so rateTotal previously ranked it at RAW cost), and
 *   - after applyMarkups, customerShippingAmount holds the MARKED charge, so rateTotal ranks it
 *     on the same marked-CHARGE basis as ShipStation (PS-203 intent) — a CORRECT ranking change,
 *     NOT a no-op: a direct rate cheaper on raw cost but pricier marked no longer wins.
 *
 * Pure + deterministic (no DB / I/O). Run: npm run test:ps-307-direct-rate-markup-behavior
 */
import { applyMarkups } from '../src/services/rates';
import { rateTotal } from '../src/services/rates-combined';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// A direct-carrier rate as toDirectRate stamps it: the customer fields carry the UN-marked
// provider amount (5), the synthetic provider id lives in carrier_id 'se-<pid>'.
const directRateRaw = () => ({
  carrier_id: 'se-777',
  carrier_code: 'ups',
  service_code: 'ups_ground',
  shipping_amount: { amount: 5, currency: 'USD' },
  other_amount: { amount: 0, currency: 'USD' },
  customerShippingAmount: 5,
  customer_shipping_amount: 5,
  customerRateAmount: 5,
  customer_rate_amount: 5,
}) as any;

// 1. Before markup, rateTotal ranks the direct rate at its RAW customer amount (the old basis).
check('pre-markup: rateTotal reads the un-marked direct customer amount (5)', rateTotal(directRateRaw()) === 5, rateTotal(directRateRaw()));

// 2. applyMarkups (+$2 on the se-777 key) overwrites customerShippingAmount with the MARKED charge.
const markups = new Map<string, any>([['se-777', { type: 'amount', value: 2 }]]);
const [marked] = applyMarkups([directRateRaw()], markups as any);
check('applyMarkups marks shipping_amount.amount to 7', marked.shipping_amount.amount === 7, marked.shipping_amount.amount);
check('PS-307: customerShippingAmount overwritten to the marked charge (7, not raw 5)', (marked as any).customerShippingAmount === 7, (marked as any).customerShippingAmount);
check('PS-307: markedShippingAmount stamped', (marked as any).markedShippingAmount === 7, (marked as any).markedShippingAmount);

// 3. The comparison owner now ranks the direct rate on the marked-CHARGE basis.
check('rateTotal ranks the marked direct rate at 7 (not 5)', rateTotal(marked as any) === 7, rateTotal(marked as any));

// 4. Ranking flip — the whole point: a direct rate cheaper on RAW cost (5) but pricier MARKED (7)
//    no longer beats a ShipStation rate charged at 6.
const shipstationCharged6 = { carrier_id: 'ss-1', shipping_amount: { amount: 6, currency: 'USD' }, other_amount: { amount: 0, currency: 'USD' } } as any;
check('pre-PS-307 basis would have let the direct rate (raw 5) win vs ShipStation 6', 5 < rateTotal(shipstationCharged6));
check('post-PS-307: marked direct (7) no longer wins vs ShipStation charged 6', rateTotal(marked as any) > rateTotal(shipstationCharged6));

// 5. A rate with no matching markup key is returned unchanged (no accidental over-marking).
const [unmatched] = applyMarkups([directRateRaw()], new Map<string, any>([['se-999', { type: 'amount', value: 2 }]]) as any);
check('no matching markup key → rate unchanged (customer amount stays 5)', (unmatched as any).customerShippingAmount === 5, (unmatched as any).customerShippingAmount);

// 6. Empty markup map → identity (applyMarkups early-returns).
const sameRef = directRateRaw();
check('empty markup map → rates returned unchanged', applyMarkups([sameRef], new Map())[0] === sameRef);

if (failures > 0) {
  console.error(`\nPS-307 direct-rate markup behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-307 direct-rate markup behavior test passed.');
