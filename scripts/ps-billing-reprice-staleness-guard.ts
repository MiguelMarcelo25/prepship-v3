/**
 * Guard: billingNeedsRepriceForPriceChange — the pure staleness rule behind
 * making "Update Billing" detect package-price / billing-config changes.
 *
 *   npx tsx scripts/ps-billing-reprice-staleness-guard.ts
 */
import { billingNeedsRepriceForPriceChange } from '../src/services/billing';

let failures = 0;
function check(name: string, got: boolean, want: boolean) {
  if (got !== want) {
    failures += 1;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const gen = '2026-06-01T06:18:00.000Z';

// Price changed AFTER generation -> stale (must re-price).
check('changed after generation', billingNeedsRepriceForPriceChange(gen, '2026-06-02T05:30:00.000Z'), true);
// Price changed BEFORE generation -> not stale (already reflected).
check('changed before generation', billingNeedsRepriceForPriceChange(gen, '2026-05-31T00:00:00.000Z'), false);
// Exactly equal -> not stale (strict greater-than).
check('changed equals generation', billingNeedsRepriceForPriceChange(gen, gen), false);
// No billing generated yet -> handled elsewhere, not here.
check('null generation time', billingNeedsRepriceForPriceChange(null, '2026-06-02T05:30:00.000Z'), false);
// No price-change timestamp -> not stale.
check('null pricing time', billingNeedsRepriceForPriceChange(gen, null), false);
// Date objects accepted.
check('date objects', billingNeedsRepriceForPriceChange(new Date(gen), new Date('2026-06-02T00:00:00Z')), true);
// Garbage input -> safe false.
check('unparseable input', billingNeedsRepriceForPriceChange('not-a-date', 'also-bad'), false);

if (failures > 0) {
  console.error(`\nFAIL billing reprice-staleness guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS billing reprice-staleness guard');
