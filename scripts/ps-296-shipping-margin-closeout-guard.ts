/**
 * PS-296 closeout checkpoint.
 *
 * Pins the current shipping-margin status as backend-owned and code/test
 * verified, while keeping final completion blocked on read-only production
 * evidence and missing-row review.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const packageJson = readFileSync('package.json', 'utf8');
const doc = readFileSync('docs/ps-tickets/ps-296-shipping-margin-status.md', 'utf8');
const guard = readFileSync('scripts/ps-296-shipping-margin-guard.ts', 'utf8');
const service = readFileSync('src/services/shipping-margin-analytics.ts', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');

check('package wires PS-296 source guard',
  packageJson.includes('"test:ps-296-shipping-margin"'));
check('package wires PS-296 closeout guard',
  packageJson.includes('"test:ps-296-shipping-margin-closeout"'));
check('status doc lists source guard',
  doc.includes('`test:ps-296-shipping-margin`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-296-shipping-margin-closeout`'));
check('status doc keeps PS-296 conservative at 86%',
  /PS-296 86%/.test(doc));
check('status doc says backend read model owns margin math',
  /backend read model/.test(doc) && /margin arithmetic/.test(doc));
check('status doc keeps final close blocked on production evidence',
  /production evidence/.test(doc) || /production canary/.test(doc));
check('status doc calls out missing-row cleanup',
  /missing-row cleanup/.test(doc));
check('status doc preserves no live label/postage safety',
  /no labels, postage, queue mutation/.test(doc));

check('source guard pins dashboard fallback for deploy route skew',
  guard.includes('dashboard shipping margin falls back to billing endpoint during deploy route skew'));
check('source guard pins missing actual-cost proof counts',
  guard.includes('missingActualCostCount') && guard.includes('missingAnyProofCount'));
check('service exports the shippingMarginAnalytics backend owner',
  /export async function shippingMarginAnalytics/.test(service));
check('service reads shipments but does not mutate them',
  service.includes('from ${shipments}') && !/\.insert\(|\.update\(|\.delete\(/.test(service));
check('api client keeps dashboard 404 fallback to billing shipping-margin endpoint',
  apiClient.includes('fetchDashboardShippingMarginAnalytics') &&
  apiClient.includes('err instanceof ApiRequestError && err.status === 404') &&
  apiClient.includes('fetchShippingMarginAnalytics(query.from, query.to, query.clientId)'));

if (failures > 0) {
  console.error(`\nFAIL PS-296 shipping margin closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-296 shipping margin closeout guard');
