/**
 * Guard: Rate Browser carrier-account clicks must browse/filter within the
 * modal. Applying a rate is reserved for actual rate rows.
 *
 * This is a static UI wiring guard for the operator flow:
 * Browse Rates -> click "EasyPost Carrier" in Carrier Accounts -> modal stays
 * open and shows EasyPost rates. Click an EasyPost rate row -> panel adopts
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
    name: 'carrier-account click is filter-only',
    ok:
      /onClick=\{\(\) => \{\s*setSelectedPid\(c\.shippingProviderId\);\s*setViewMode\('carriers'\);\s*\}\}/.test(source) &&
      !source.includes('onClick={() => handleCarrierAccountClick(c, rates)}'),
  },
  {
    name: 'carrier-account click does not call rate apply path',
    ok: !/function handleCarrierAccountClick[\s\S]*handleRateClick/.test(source),
  },
  {
    name: 'rate row click applies through handleRateClick',
    ok: source.includes('onClick={blocked ? undefined : () => handleRateClick(r)}'),
  },
  {
    name: 'rate row apply path closes the modal after onApplyRate',
    ok: /function handleRateClick[\s\S]*onApplyRate\(\{[\s\S]*\}\);\s*onClose\(\);/.test(source),
  },
  {
    name: 'account count still reflects only available rates when hidden rates are filtered',
    ok: source.includes('rates.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions)).length'),
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
