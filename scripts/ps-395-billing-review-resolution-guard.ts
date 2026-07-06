import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `Missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `Missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const route = read('src/routes/billing.ts');
const billingService = read('src/services/billing.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

const patchBlock = sliceBetween(
  route,
  "app.patch('/details/:orderId",
  '// ─── PS-275: $0-shipping review',
);

check('box-cost $0 save still inserts an explicit package_cost line',
  /lineType === 'package_cost'/.test(patchBlock) &&
    /rows\.length === 0 && \(value > 0 \|\| lineType === 'package_cost'\)/.test(patchBlock));

check('box-cost save deletes the package_cost_missing review row immediately',
  /eq\(billingLineItems\.lineType,\s*'package_cost_missing'\)/.test(patchBlock) &&
    /delete\(billingLineItems\)/.test(patchBlock));

check('shipping save deletes shipping_missing review rows immediately',
  /body\.shipping !== undefined/.test(patchBlock) &&
    /eq\(billingLineItems\.lineType,\s*'shipping_missing'\)/.test(patchBlock) &&
    /PS-395/.test(patchBlock));

check('billing details derive manual shipping override from durable backend override rows',
  /const hasManualShippingOverride = manualBillingOverrideLineTypes\.includes\('shipping'\)/.test(billingService));

check('manual shipping override suppresses $0 shipping review in backend DTO',
  /const zeroShippingReview = isShippingLine && !hasManualShippingOverride/.test(billingService) &&
    /shippingZeroNeedsReview: isZeroShippingReviewLine/.test(billingService));

check('manual override markers still ride on billing detail rows',
  /manualBillingOverrideLineTypes/.test(billingService) &&
    /manualBillingOverrideLabels/.test(billingService));

check('package exposes PS-395 guard',
  packageJson.scripts?.['test:ps-395-billing-review-resolution'] ===
    'tsx scripts/ps-395-billing-review-resolution-guard.ts');

if (failures > 0) {
  console.error(`\nFAIL PS-395 billing review resolution guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-395 billing review resolution guard');
