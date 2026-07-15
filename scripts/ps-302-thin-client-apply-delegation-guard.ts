/**
 * PS-302 (FE) guard — the Apply Best Rate thin-client delegation.
 *
 * Proves the frontend no longer OWNS the apply orchestration: OrdersView's
 * persistAppliedRateForOrder delegates to the backend-owned command
 * (apiClient.applyBestRate -> POST /orders/:id/apply-best-rate, one atomic persist)
 * as the only path. A missing provider id fails closed and requires a re-rate;
 * the frontend cannot fall back to independent dims/best-rate writes.
 *
 * Offline/static only: no DB, no network, no providers, no labels, no postage, no
 * marketplace, no Trello mutation, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';

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

const apiClient = read('web/src/lib/v2-apiClient.ts');
check('apiClient exposes applyBestRate -> POST /orders/:id/apply-best-rate',
  /applyBestRate\(/.test(apiClient) &&
  /api\.post<any>\(`\/orders\/\$\{orderId\}\/apply-best-rate`/.test(apiClient));
check('apiClient applyBestRate does NOT send currentRequestFingerprint (behavior-equivalent to legacy save)',
  !/currentRequestFingerprint/.test(apiClient.slice(apiClient.indexOf('applyBestRate('), apiClient.indexOf('applyBestRate(') + 800)));

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const fnStart = ordersView.indexOf('async function persistAppliedRateForOrder');
const fn = fnStart >= 0 ? ordersView.slice(fnStart, fnStart + 2600) : '';
check('persistAppliedRateForOrder exists', fn.length > 0);
check('persistAppliedRateForOrder delegates to the backend apply command',
  /apiClient\.applyBestRate\(/.test(fn));
check('missing provider id fails closed before Apply',
  /if \(shippingProviderId == null\) \{[\s\S]*?throw new Error\(/.test(fn));
check('legacy independent save fallback is absent',
  !/apiClient\.(?:saveOrderDims|saveOrderBestRate|setOrderSelectedPid)\(/.test(fn));
check('setOrderSelectedPid is no longer part of the primary apply orchestration',
  !/apiClient\.setOrderSelectedPid\(/.test(fn));

if (failures > 0) {
  console.error(`\nPS-302 thin-client apply-delegation guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-302 thin-client apply-delegation guard passed.');
