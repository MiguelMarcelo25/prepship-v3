/**
 * Rate Browser manual selection apply-error guard.
 *
 * The backend apply-best-rate command is the rate source of truth. If it rejects
 * a selected row (expired quote proof, unavailable service, missing dims, etc.),
 * the client transport must reject too so OrdersView can show the operator the
 * real reason instead of silently refetching back to the previous best rate.
 *
 * Offline/static only: no DB, no network, no providers, no labels, no postage,
 * no marketplace notification, no production data mutation, and no
 * shipped/cancelled mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

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
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function sliceBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  if (start < 0) return '';
  const end = source.indexOf(endToken, start + startToken.length);
  return end > start ? source.slice(start, end) : '';
}

const packageJson = read('package.json');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const apiApplyBlock = sliceBetween(
  apiClient,
  'applyBestRate(',
  '\n  // PS-179: updateOrderBestRateSelectionStrict removed',
);
const applySelectionStart = ordersView.indexOf('function applyRateSelection(');
const applySelectionEnd = applySelectionStart >= 0
  ? ordersView.indexOf('\n  async function printPicklist', applySelectionStart)
  : -1;
const applySelectionBlock = applySelectionStart >= 0
  ? ordersView.slice(applySelectionStart, applySelectionEnd > applySelectionStart ? applySelectionEnd : applySelectionStart + 5000)
  : '';

check('package wires Rate Browser apply-error guard',
  /"test:rate-browser-manual-selection-apply-error"\s*:\s*"tsx scripts\/rate-browser-manual-selection-apply-error-guard\.ts"/.test(packageJson));

check('apiClient.applyBestRate posts to backend apply-best-rate command',
  /api\.post<any>\(`\/orders\/\$\{orderId\}\/apply-best-rate`/.test(apiApplyBlock),
  apiApplyBlock);

check('apiClient.applyBestRate rejects backend failures instead of safe-fallback swallowing them',
  apiApplyBlock.length > 0 &&
  !/return\s+safe\(/.test(apiApplyBlock) &&
  !/,\s*\{\s*\}\s*\)/.test(apiApplyBlock) &&
  /return\s+api\.post<any>/.test(apiApplyBlock),
  apiApplyBlock);

check('OrdersView manual apply catches rejected apply command and shows the backend message',
  /persistAppliedRateForOrder\(/.test(applySelectionBlock) &&
  /\.catch\(\(error\) => \{[\s\S]*?showToast\(error instanceof Error \? error\.message : 'Failed to save selected rate', 'error'\)/.test(applySelectionBlock),
  applySelectionBlock);

if (failures > 0) {
  console.error(`\nFAIL Rate Browser manual selection apply-error guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS Rate Browser manual selection apply-error guard');
