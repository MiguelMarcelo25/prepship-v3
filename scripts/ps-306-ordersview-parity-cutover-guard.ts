/**
 * PS-306 OrdersView parity cutover gate.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no queue mutation, no production data mutation,
 * and no shipped/cancelled mutation. This pins the guardrails required before
 * future OrdersView extraction work can continue.
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

const docPath = 'docs/ps-tickets/ps-306-ordersview-parity-cutover.md';
const doc = read(docPath);
const packageJson = read('package.json');
const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
const decompositionStatus = read('docs/ps-tickets/ps-166-ps-258-decomposition-status.md');
const agents = read('AGENTS.md');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const batchPanel = read('web/src/components/Views/OrdersBatchPanel.tsx');
const filteredSort = read('web/src/components/Views/orders-filtered-sort.ts');
const componentBoundaryGuard = read('scripts/ps-258-component-boundary-lockdown-guard.ts');
const filteredSortGuard = read('scripts/ps-258-orders-filtered-sort-guard.ts');
const authorityRatchetGuard = read('scripts/ps-178-fe-authority-ratchet-guard.ts');
const ps305Doc = read('docs/ps-tickets/ps-305-authority-drift-guardrails.md');

check('PS-306 parity cutover doc exists', existsSync(docPath));
check('PS-306 doc states this slice is pre-extraction only',
  doc.includes('pre-extraction guardrail') &&
  doc.includes('does not move code out of `OrdersView.tsx` yet'));
checkIncludesAll('PS-306 doc lists backend authority prerequisites', doc, [
  'backend row workflow authority',
  'backend Apply Best Rate authority',
  'backend Print Queue authority',
  'backend package/carrier/account/display facts authority',
  'backend authority drift prevention',
]);
checkIncludesAll('PS-306 doc lists next extraction candidates', doc, [
  'passive auto-rating',
  'panel state',
  'filtered order rows',
  'memoized row rendering',
  'account-display fallback removal',
]);
checkIncludesAll('PS-306 doc preserves lockdown and safety language', doc, [
  'isReadOnly',
  'shipped/cancelled',
  'AGENTS.md',
  'currently has the shipped/cancelled UI',
  'const isReadOnly = false',
  'not be called fully',
  'does not run live labels',
  'production order mutations',
  'shipped/cancelled data mutations',
]);

const requiredScripts = [
  'test:ps-300-active-lawrence-workflow',
  'test:ps-301-row-workflow-authority',
  'test:ps-302-apply-best-rate-authority',
  'test:ps-303-print-queue-authority',
  'test:ps-304-shipping-display-facts-authority',
  'test:ps-305-authority-drift',
  'test:ps-178-fe-authority-ratchet',
  'test:ps-166-orders-rate-proof',
  'test:ps-258-orders-filtered-sort',
  'test:ps-258-component-boundary',
  'test:ps-258-empty-state-props-contract',
  'test:ps-258-empty-panel-contract',
  'test:ps-258-search-bar-contract',
  'test:ps-166-ps-258-decomposition-certification',
  'test:ps-166-ps-258-decomposition-closeout',
  'test:ps-306-ordersview-parity-cutover',
];

for (const scriptName of requiredScripts) {
  check(`package wires ${scriptName}`, packageJson.includes(`"${scriptName}"`));
  check(`PS-306 doc lists ${scriptName}`, doc.includes(`\`${scriptName}\``));
}

check('package wires PS-306 guard to this script',
  /"test:ps-306-ordersview-parity-cutover"\s*:\s*"tsx scripts\/ps-306-ordersview-parity-cutover-guard\.ts"/.test(packageJson));
check('PS-300 workflow records PS-306 guard command',
  workflowDoc.includes('test:ps-306-ordersview-parity-cutover'));
check('PS-300 workflow keeps PS-306 after PS-305 in Lane 1',
  /PS-305[\s\S]*PS-306/.test(workflowDoc));

check('AGENTS.md locks shipped/cancelled OrdersView protections',
  agents.includes('web/src/components/Views/OrdersView.tsx') &&
  agents.includes('`isReadOnly` flag and its consumers') &&
  agents.includes('Re-enable batch actions on the Shipped/Cancelled views'));
check('AGENTS.md requires exact unlock phrase for shipped/cancelled code paths',
  agents.includes('unlock shipped data') &&
  agents.includes('unless the user explicitly types the exact phrase'));

check('PS-166/PS-258 status remains conservative, not Final Review-ready',
  /PS-166 76%/.test(decompositionStatus) &&
  /PS-258 82%/.test(decompositionStatus) &&
  /not Final Review-ready/.test(decompositionStatus));
check('PS-166/PS-258 status records extracted parity but requires larger DOM or byte-equivalent cert',
  decompositionStatus.includes('selected-order toolbar') &&
  decompositionStatus.includes('daily strip') &&
  decompositionStatus.includes('not the full table shell or row renderer') &&
  decompositionStatus.includes('Do not change shipped/cancelled lockdown behavior'));

check('PS-305 doc carries PS-306 frontend debt forward',
  ps305Doc.includes('PS-306 follow-up') &&
  ps305Doc.includes('Keep remaining compatibility fallbacks explicit'));

check('OrdersView lockdown caveat is explicit: UI gate currently disabled, backend guards required',
  /const isReadOnly = false/.test(ordersView) &&
  /SHIPPED \/ CANCELLED LOCKDOWN/.test(ordersView) &&
  /DISABLED/.test(ordersView) &&
  /Defense-in-depth still applies at the BACKEND/.test(ordersView));
check('OrdersView still contains row select, Select All, and batch panel read-only gate sites',
  /if \(isReadOnly\) return null/.test(ordersView) &&
  (ordersView.match(/isReadOnly \? null :/g) ?? []).length >= 2 &&
  /<OrdersBatchPanel[\s\S]{0,400}?isReadOnly=\{isReadOnly\}/.test(ordersView));
check('OrdersBatchPanel still accepts and honors the read-only suppression prop',
  /isReadOnly: boolean/.test(batchPanel) &&
  /if \(isReadOnly\) return null/.test(batchPanel));

check('PS-306 doc does not overstate Final Review readiness while UI lock is disabled',
  /not Final Review-ready while `OrdersView\.tsx` has/.test(doc) &&
  /remains a cutover gate and dependency map/.test(doc));

checkIncludesAll('component-boundary guard pins the canonical lockdown consumers', componentBoundaryGuard, [
  'row select cell early-returns null',
  'Select-All is gated',
  'SKU-group select-all',
  'batch-actions panel is suppressed',
  'OrdersBatchPanel early-returns null',
]);
checkIncludesAll('frontend authority ratchet pins no-growth frontend business logic', authorityRatchetGuard, [
  'FE authority grew',
  'applyCarrierMarkup calls',
  'no FE pickBestRate resurrection',
  'planStrictBestRateRecalculate calls',
  'OrdersView line count',
  '11650',
]);

check('existing extracted OrdersView leaf modules exist for future parity targets',
  [
    'web/src/components/Views/orders-display-state.ts',
    'web/src/components/Views/orders-row-display.tsx',
    'web/src/components/Views/OrdersPrintQueueDrawer.tsx',
    'web/src/components/Views/OrdersSelectionToolbar.tsx',
    'web/src/components/Views/orders-empty-panel.tsx',
    'web/src/components/Views/OrdersSearchBar.tsx',
    'web/src/components/Views/OrdersPanelShippingFields.tsx',
  ].every((path) => existsSync(path)));

check('OrdersView line-count ratchet is currently inside the PS-178 ceiling',
  ordersView.split('\n').length <= 11_650,
  { lineCount: ordersView.split('\n').length });

check('filtered-order sort owner stays pure display ordering logic',
  filteredSort.includes('export function computeOrderedFilteredOrders') &&
  !/from ['"]react['"]|fetch\(|apiClient|createLabel|selectedRateProof|rateQuoteId|localStorage|sessionStorage|isReadOnly/.test(filteredSort));
check('filtered-order sort guard pins OrdersView delegation and no inline sort',
  filteredSortGuard.includes('the orderedFilteredOrders useMemo delegates to computeOrderedFilteredOrders') &&
  filteredSortGuard.includes('no inline .sort() remains in the orderedFilteredOrders useMemo'));
check('OrdersView table state still flows from orderedFilteredOrders',
  /const skuOrderGroups = useMemo\([\s\S]{0,500}?orderedFilteredOrders/.test(ordersView) &&
  /const visibleOrderIds = useMemo\(\s*\(\) => orderedFilteredOrders\.map/.test(ordersView) &&
  ordersView.includes('orderedFilteredOrders.length > 0') &&
  ordersView.includes('skuSortActive ? skuOrderGroups.flatMap') &&
  ordersView.includes(': orderedFilteredOrders.map') &&
  ordersView.includes('hasNoFilteredOrders={orderedFilteredOrders.length === 0}'));

if (failures > 0) {
  console.error(`\nFAIL PS-306 OrdersView parity cutover guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-306 OrdersView parity cutover guard');
