/**
 * Guard: Rate Browser carrier-account clicks must apply a usable rate, not only
 * filter the right-hand list.
 *
 * This is a static UI wiring guard for the operator flow:
 * Browse Rates -> click "EasyPost Carrier" in Carrier Accounts -> panel adopts
 * that carrier/account via the normal apply-rate path.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('web/src/components/RateBrowserModal.tsx');
const source = readFileSync(file, 'utf8');

const checks = [
  {
    name: 'carrier-account click helper exists',
    ok: source.includes('function handleCarrierAccountClick('),
  },
  {
    name: 'helper picks the cheapest unblocked account rate',
    ok:
      source.includes('.filter((rate) => !isBlockedRate(rate, order, currentRateShippingOptions))') &&
      source.includes('.sort((a, b) => rateDisplayTotal(a, markups) - rateDisplayTotal(b, markups))[0]'),
  },
  {
    name: 'helper applies the selected carrier rate through handleRateClick',
    ok: /if \(bestRate\) \{[\s\S]*handleRateClick\(\{[\s\S]*shippingProviderId:[\s\S]*carrierNickname:[\s\S]*\}\);[\s\S]*return;[\s\S]*\}/.test(source),
  },
  {
    name: 'carrier account row is wired to apply helper',
    ok: source.includes('onClick={() => handleCarrierAccountClick(c, rates)}'),
  },
  {
    name: 'no-rate carrier account still opens carrier-filter view',
    ok: /function handleCarrierAccountClick[\s\S]*setViewMode\('carriers'\);/.test(source),
  },
];

let failures = 0;
for (const check of checks) {
  if (check.ok) {
    console.log(`ok   ${check.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${check.name}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL rate-browser carrier-account click guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS rate-browser carrier-account click guard');
