/**
 * PS-352 - architecture-first shipping workflow SOT map guard.
 *
 * Static/offline only: no DB, no network, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function includesAll(source: string, values: string[]): boolean {
  return values.every((value) => source.includes(value));
}

const docPath = 'docs/ps-tickets/ps-352-shipping-workflow-sot-map.md';
const packageJson = read('package.json');
const ledger = read('docs/ps-tickets/ps-ledger.md');
const doc = existsSync(docPath) ? read(docPath) : '';

check(
  'package wires PS-352 guard',
  packageJson.includes('"test:ps-352-shipping-workflow-sot-map": "tsx scripts/ps-352-shipping-workflow-sot-map-guard.ts"'),
);

check(
  'PS-352 SOT map document exists with Trello reference',
  existsSync(docPath) &&
    doc.includes('# PS-352 - Architecture-first shipping workflow SOT map + wrapper deletion plan') &&
    doc.includes('https://trello.com/c/9IjFnCDa'),
);

check(
  'PS-352 doc contains required architecture sections',
  includesAll(doc, [
    '## Canonical Rule',
    '## Imperfect Data Injection Points',
    '## Decision Ownership Matrix',
    '## Wrapper / Resolver Inventory',
    '## Cutover Plan',
    '## Risk Map',
    '## Verification',
    '## Safety',
  ]),
);

check(
  'decision matrix covers every required shipping workflow decision',
  includesAll(doc, [
    'Rate current/stale',
    'Displayable rate',
    'Best Rate',
    'Selected rate',
    'Proof validity',
    'Can print queue',
    'Label purchase permission',
    'Shipped/cancelled lock',
    'Batch status',
    'Count/date filters',
  ]),
);

check(
  'decision matrix names imperfect data injection boundaries',
  includesAll(doc, [
    'Provider quote payloads',
    'Cache writes',
    'Operator panel input',
    'Rate Browser click/apply',
    'Orders list refresh',
    'Print Queue batch send',
    'Date/count filters',
  ]),
);

check(
  'backend rate owners are explicit',
  includesAll(doc, [
    'src/services/rates-combined.ts',
    'rateTotal',
    'rateCostTotal',
    'combineCarrierUniverses',
    'src/services/rate-browse-response-producer.ts',
    'src/services/shipping-workflow/best-rate-workflow-dto.ts',
    'src/services/shipping-workflow/rate-fingerprint.ts',
    'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  ]),
);

check(
  'backend queue and label owners are explicit without editing locked code',
  includesAll(doc, [
    'src/services/print-queue.ts',
    'src/services/print-queue/queue-send-status.ts',
    'src/routes/print-queue.ts',
    'src/services/labels.ts',
    'src/services/shipping-workflow/hugrab-label-purchase-gate.ts',
  ]),
);

check(
  'frontend wrappers are inventoried and classified',
  includesAll(doc, [
    'web/src/lib/v2-apiClient.ts',
    'web/src/hooks/useRateBrowseWorkflow.ts',
    'web/src/components/RateBrowserModal.tsx',
    'web/src/components/Views/OrdersView.tsx',
    'web/src/components/Views/orders-parity.ts',
    'web/src/components/Views/orders-rate-cells.tsx',
    'web/src/lib/rate-browser-money.ts',
    'web/src/lib/rate-browser-house-tuple.ts',
    'web/src/lib/rate-browser-best-emission.ts',
    'KEEP ACTIVE',
    'MIGRATE FIRST',
    'BLOCKED BY CONDITIONAL CARD',
    'DOCUMENT ONLY',
  ]),
);

check(
  'specific frontend truth helpers are named for delegation/deletion',
  includesAll(doc, [
    'classifyAwaitingRateCellState',
    'savedBestRateCanDisplayForCurrentRequest',
    'buildQueueAddPayload',
    'classifyQueueOrderRoute',
    'handleRateClick',
    'applyRateSelection',
    'withRateRequestMetadata',
    'persistAppliedRateForOrder',
  ]),
);

check(
  'cutover plan ties child PS cards to backend owners and deletion targets',
  includesAll(doc, [
    'PS-349 - Canonical backend order shipping state',
    'PS-350 - Backend rate jobs, partial results, and shared limiter',
    'PS-351 - Durable Print Queue/preflight jobs',
    'PS-353 - Count/date filter source of truth',
    'PS-355 and PS-332 - Remaining money display and margin/account labels',
    'PS-331 - Safe deletion last',
  ]),
);

check(
  'risk map covers live QA failure classes',
  includesAll(doc, [
    'Stale or unproven rate buys a label',
    'Hidden All Dates / count mismatch',
    'Indefinite spinner or Rate unavailable rows',
    'Slow provider blocks Rate Browser',
    'Print Queue in-memory job loss',
    'Label purchase timeout race',
    'Frontend wrapper becomes permanent truth',
  ]),
);

check(
  'verification list includes PS-352 and dependency gates',
  includesAll(doc, [
    'npm run test:ps-352-shipping-workflow-sot-map -- --no-color',
    'npm run test:ps-102-best-rate-workflow-dto -- --no-color',
    'npm run test:ps-105-backend-rate-snapshot-id -- --no-color',
    'npm run test:ps-340-backend-rate-engine -- --no-color',
    'npm run test:ps-345-rate-loading-sot -- --no-color',
    'npm run test:ps-346-rate-order-slow-paths -- --no-color',
    'npm run typecheck',
  ]),
);

check(
  'safety section proves this slice is docs/guard only',
  includesAll(doc, [
    'No deletion performed.',
    'No labels, postage, provider calls, marketplace notifications, billing,',
    'Locked shipped/cancelled surfaces remain untouched.',
    'This PS-352 slice is docs and guard only.',
  ]),
);

check(
  'ledger reserves PS-352 and links to the Trello card',
  ledger.includes('| PS-352 | Architecture-first shipping workflow SOT map + wrapper deletion plan | https://trello.com/c/9IjFnCDa | `prepshipv4-stable` | In progress |'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-352 shipping workflow SOT map guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-352 shipping workflow SOT map guard');
