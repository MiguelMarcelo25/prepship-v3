/**
 * PS-166 / PS-258 decomposition certification.
 *
 * Offline/static only: this guard certifies the current extracted OrdersView
 * slices and keeps the broad cards honest. It reads source/docs/guards, but it
 * does not run provider calls, labels, postage, queues, production mutations, or
 * shipped/cancelled data changes.
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

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

const packageJson = read('package.json');
const statusDoc = read('docs/ps-tickets/ps-166-ps-258-decomposition-status.md');
const certificationDocPath = 'docs/ps-tickets/ps-166-ps-258-decomposition-certification.md';
const certificationDoc = read(certificationDocPath);
const ps306Doc = read('docs/ps-tickets/ps-306-ordersview-parity-cutover.md');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const filteredSort = read('web/src/components/Views/orders-filtered-sort.ts');
const filteredSortGuard = read('scripts/ps-258-orders-filtered-sort-guard.ts');
const componentBoundaryGuard = read('scripts/ps-258-component-boundary-lockdown-guard.ts');
const emptyStateGuard = read('scripts/ps-258-orders-empty-state-props-contract-guard.ts');
const emptyPanelGuard = read('scripts/ps-258-orders-empty-panel-contract-guard.ts');
const searchBarGuard = read('scripts/ps-258-orders-search-bar-contract-guard.ts');
const leafRenderGuard = read('scripts/ps-166-ps-258-orders-leaf-render-parity-guard.ts');
const selectionRenderGuard = read('scripts/ps-166-ps-258-orders-selection-render-parity-guard.ts');

check('certification document exists', existsSync(certificationDocPath));

const requiredScripts: ReadonlyArray<[string, string]> = [
  ['test:ps-166-orders-rate-proof', 'scripts/ps-166-orders-rate-proof-guard.ts'],
  ['test:ps-258-daily-stats-rollover', 'scripts/ps-258-daily-stats-rollover-guard.ts'],
  ['test:ps-258-non-critical-scheduler', 'scripts/ps-258-non-critical-scheduler-guard.ts'],
  ['test:ps-258-orders-queue-parsers', 'scripts/ps-258-orders-queue-parsers-guard.ts'],
  ['test:ps-258-orders-filtered-sort', 'scripts/ps-258-orders-filtered-sort-guard.ts'],
  ['test:ps-258-orders-column-prefs-local', 'scripts/ps-258-orders-column-prefs-local-guard.ts'],
  ['test:ps-258-orders-table-density-prefs', 'scripts/ps-258-orders-table-density-prefs-guard.ts'],
  ['test:ps-258-component-boundary', 'scripts/ps-258-component-boundary-lockdown-guard.ts'],
  ['test:ps-258-empty-state-props-contract', 'scripts/ps-258-orders-empty-state-props-contract-guard.ts'],
  ['test:ps-258-empty-panel-contract', 'scripts/ps-258-orders-empty-panel-contract-guard.ts'],
  ['test:ps-258-search-bar-contract', 'scripts/ps-258-orders-search-bar-contract-guard.ts'],
  ['test:ps-166-ps-258-orders-leaf-render-parity', 'scripts/ps-166-ps-258-orders-leaf-render-parity-guard.ts'],
  ['test:ps-166-ps-258-orders-selection-render-parity', 'scripts/ps-166-ps-258-orders-selection-render-parity-guard.ts'],
  ['test:ps-166-ps-258-decomposition-certification', 'scripts/ps-166-ps-258-decomposition-certification-guard.ts'],
  ['test:ps-166-ps-258-decomposition-closeout', 'scripts/ps-166-ps-258-decomposition-closeout-guard.ts'],
];

for (const [scriptName, path] of requiredScripts) {
  check(`package.json wires ${scriptName}`, packageJson.includes(`"${scriptName}"`));
  check(`guard file exists for ${scriptName}`, existsSync(path));
  check(`certification doc lists ${scriptName}`, certificationDoc.includes(`\`${scriptName}\``));
  check(`status doc lists ${scriptName}`, statusDoc.includes(`\`${scriptName}\``));
}

check('status doc records the updated conservative percentages',
  /PS-166 75%/.test(statusDoc) && /PS-258 81%/.test(statusDoc));
check('certification doc records the updated conservative percentages',
  /PS-166 75%/.test(certificationDoc) && /PS-258 81%/.test(certificationDoc));
check('status and certification docs keep the cards out of Final Review',
  /not Final Review-ready/.test(statusDoc) && /not Final Review-ready/.test(certificationDoc));
check('docs record extracted render parity and still require larger shell/row parity before review',
  /selected-order toolbar/.test(statusDoc) &&
    /not the full table shell or row renderer/.test(statusDoc) &&
    /selected-toolbar branches/.test(certificationDoc) &&
    /not the full table shell\s+or row renderer/.test(certificationDoc));

check('filtered sort owner is pure and exported',
  filteredSort.includes('export function computeOrderedFilteredOrders') &&
    !/from ['"]react['"]|fetch\(|apiClient|createLabel|selectedRateProof|rateQuoteId|localStorage|sessionStorage|isReadOnly/.test(filteredSort));
check('filtered sort guard pins OrdersView delegation and no inline sort',
  filteredSortGuard.includes('orderedFilteredOrders useMemo delegates to computeOrderedFilteredOrders') &&
    filteredSortGuard.includes('no inline .sort() remains'));

checkIncludesAll('component-boundary guard pins the shipped/cancelled selection consumers', componentBoundaryGuard, [
  'row select cell early-returns null',
  'Select-All is gated',
  'SKU-group select-all',
  'batch-actions panel is suppressed',
  'OrdersBatchPanel early-returns null',
]);
checkIncludesAll('empty-results guard pins prop and DOM contract', emptyStateGuard, [
  'EXACTLY the six',
  'data-testid="orders-searching"',
  'id="searchingState"',
  'id="emptyState"',
]);
checkIncludesAll('empty-panel guard pins factory and keyboard contract', emptyPanelGuard, [
  'EXACTLY 1 arg',
  'onHide ?',
  'No order selected',
  'keyboard-hint',
]);
checkIncludesAll('search-bar guard pins prop and DOM contract', searchBarGuard, [
  'EXACTLY the three',
  'id="searchInput"',
  'id="searchClear"',
  'PS-210 global-search hint pill',
]);
checkIncludesAll('leaf render parity guard pins server-rendered DOM branches', leafRenderGuard, [
  'renderToStaticMarkup',
  'OrdersSearchBar active render shows clear button',
  'OrdersResultsEmptyState searching branch renders only the searching region',
  'buildEmptyPanel with onHide renders exactly one close affordance button',
]);
checkIncludesAll('selection render parity guard pins selected/batch DOM branches', selectionRenderGuard, [
  'renderToStaticMarkup',
  'OrdersSelectionToolbar awaiting mobile render keeps print and queue actions',
  'OrdersBatchPanel source keeps isReadOnly null gate',
  'OrdersBatchPanel source keeps non-awaiting read-only fallback',
]);

check('OrdersView lockdown caveat remains explicitly visible',
  /const isReadOnly = false/.test(ordersView) &&
    /SHIPPED \/ CANCELLED LOCKDOWN/.test(ordersView) &&
    /Defense-in-depth still applies at the BACKEND/.test(ordersView));
check('PS-306 still blocks full review while the UI read-only gate is disabled',
  /not Final Review-ready while `OrdersView\.tsx` has/.test(ps306Doc) &&
    /const isReadOnly = false/.test(ps306Doc));

checkIncludesAll('certification doc carries safety boundaries', certificationDoc, [
  'offline/static only',
  'does not change runtime UI behavior',
  'labels',
  'postage',
  'queues',
  'orders',
  'shipments',
  'marketplaces',
  'shipped/cancelled data',
  'No Trello comment or move is authorized',
]);

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 decomposition certification guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 decomposition certification guard');
