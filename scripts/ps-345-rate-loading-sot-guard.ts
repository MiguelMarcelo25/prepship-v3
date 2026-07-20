/**
 * PS-345 - Rate loading SOT cleanup.
 *
 * Offline/static only: no DB, no network, no labels, no queue mutation.
 * This pins the first runtime cleanup slice from the Trello PS-345 card:
 * Awaiting may display backend/cached state automatically, but broad live
 * Awaiting fan-out/backfill must be explicit operator intent or backend-owned.
 * Opening Rate Browser is explicit operator intent and must start its backend
 * live workflow rather than leaving the operator on partial cached rows.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`Missing ${endNeedle}`);
  return source.slice(start, end);
}

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const recalculateAll = read('web/src/components/Views/orders-recalculate-all.ts');
const modal = read('web/src/components/RateBrowserModal.tsx');
const openWorkflow = read('web/src/components/rate-browser-open-workflow.ts');
const packageJson = read('package.json');
const ledger = read('docs/ps-tickets/ps-ledger.md');
const docPath = 'docs/ps-tickets/ps-345-rate-loading-sot.md';
const doc = existsSync(docPath) ? read(docPath) : '';

const retryOrderRate = sliceBetween(
  ordersView,
  'function retryOrderRate(',
  '\n  async function getBatchRecalculateOrders(',
);
const modalOpenEffect = sliceBetween(
  modal,
  '// Start the live carrier workflow on open',
  '// Auto-select a package',
);
const browseRatesFunction = sliceBetween(
  modal,
  'async function browseRates(',
  '\n  function filterBySvcClass(',
);
const recalculateAllHandler = sliceBetween(
  ordersView,
  'async function handleRecalculateAll()',
  '\n  async function handleFullLiveRecalculateAll()',
);

check(
  'OrdersView removed browser-owned passive live rate constants and counters',
  !/PASSIVE_LIVE_BEST_RATE|PASSIVE_BACKFILL_MAX_AGE_HOURS|passiveLiveBestRateCountRef|passiveBackfillStartedRef/.test(ordersView),
);

check(
  'OrdersView no longer runs a page-mount passive auto-rating worker',
  !/refreshVisibleBestRate|runPassiveAutoRating|fetchCachedRatesBulk/.test(ordersView),
);

check(
  'OrdersView retry action delegates to explicit backend recalculate instead of re-triggering passive effects',
  /void runBatchRecalculateOrder\(order\)/.test(retryOrderRate) &&
    !/rateRetryNonce|setRateRetryNonce|autoBestRateRequestedRef/.test(retryOrderRate),
);

check(
  'OrdersView still keeps explicit manual Recalculate All backend-owned',
  /startRecalculateAllBestRates\(\)/.test(recalculateAllHandler),
);

check(
  'OrdersView observes backend/sync-started rate backfill jobs and attaches them to the row refresh poller',
  /fetchLatestRecalculateAllJob/.test(ordersView) &&
    /currentStatus !== 'awaiting_shipment'/.test(ordersView) &&
    /setRecalcAllJobId\(job\.jobId\)/.test(ordersView) &&
    /void attachLatestRateBackfillJob\(\)/.test(ordersView),
);

check(
  'Recalculate All helper can read the backend latest active/durable backfill job',
  /export async function fetchLatestRecalculateAllJob\(\)/.test(recalculateAll) &&
    /\/rates\/backfill-best\/latest/.test(recalculateAll) &&
    /durableJob/.test(recalculateAll) &&
    /normalizeRecalculateAllJob/.test(recalculateAll),
);

check(
  'Recalculate All job polling treats pending backend backfill jobs as active',
  /export function isRecalculateAllJobDone\(job: RecalculateAllJob\): boolean \{[\s\S]{0,180}job\.status !== 'pending'/.test(recalculateAll),
);

check(
  'RateBrowserModal open effect starts the backend live workflow for all scoped carriers',
  /rateBrowserOpenBrowseOptions/.test(openWorkflow) &&
    /return \{ forceLive: true \}/.test(openWorkflow) &&
    /browseRates\(undefined, rateBrowserOpenBrowseOptions\(\)\)/.test(modalOpenEffect) &&
    !/cachedOnly:\s*true/.test(modalOpenEffect),
);

check(
  'RateBrowserModal keeps manual Refresh Live Rates as an explicit backend workflow retry',
  /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(modal),
);

check(
  'RateBrowserModal open live workflow does not reintroduce Awaiting-table passive rate loading',
  !/PASSIVE_LIVE_BEST_RATE|PASSIVE_BACKFILL_MAX_AGE_HOURS|runPassiveAutoRating|fetchCachedRatesBulk/.test(ordersView) &&
    !/open effect live-fetches|forceLive pass whenever probe\.uncoveredPids|no live follow-up/.test(browseRatesFunction),
);

check(
  'package wires PS-345 guard',
  packageJson.includes('"test:ps-345-rate-loading-sot": "tsx scripts/ps-345-rate-loading-sot-guard.ts"'),
);

check(
  'ledger reserves PS-345 for the Trello rate loading SOT cleanup',
  ledger.includes('| PS-345 | Rate loading orchestration source-of-truth cleanup |'),
);

check(
  'PS-345 doc records backend owners, bad data injection, and first slice',
  doc.includes('## Backend Owners') &&
    doc.includes('## Imperfect Data Injection') &&
    doc.includes('## First Slice') &&
    doc.includes('No shipped/cancelled surfaces are touched'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-345 rate loading SOT guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-345 rate loading SOT guard');
