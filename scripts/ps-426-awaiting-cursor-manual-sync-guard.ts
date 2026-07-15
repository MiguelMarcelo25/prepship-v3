/**
 * PS-426 offline guard.
 *
 * No DB/provider calls, labels, postage, marketplace notifications, or
 * production order/shipment mutations occur in this test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  awaitingOrderPageCountRebasePage,
  buildAwaitingOrderCursorState,
  parseAwaitingOrderCursorState,
} = await import('../src/services/order-sync');
const {
  classifyOrderSyncQueueRows,
  orderSyncQueueBlocker,
  orderSyncQueueState,
} = await import('../src/services/order-sync-queue-state');
const { formatSyncPill } = await import('../web/src/components/Views/orders-parity');

type Cursor = ReturnType<typeof buildAwaitingOrderCursorState>;

function boundedRun(cursor: Cursor | null, totalPages: number, maxPages: number) {
  const startPage = cursor?.hasBacklog ? cursor.nextPage : 1;
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  const sequence = Array.from(
    { length: Math.max(0, endPage - startPage + 1) },
    (_, index) => startPage + index,
  );
  const complete = endPage >= totalPages;
  return {
    sequence,
    cursor: buildAwaitingOrderCursorState({
      accountId: 'client:42',
      storeId: 9001,
      sinceMs: Date.parse('2026-07-01T00:00:00.000Z'),
      untilMs: Date.parse('2026-07-16T00:00:00.000Z'),
      pageSize: 100,
      checkedAtMs: Date.parse('2026-07-16T00:01:00.000Z'),
      result: {
        pages: totalPages,
        totalOrders: totalPages * 100,
        startPage,
        lastPageProcessed: endPage,
        complete,
        stoppedBy: complete ? 'complete' : 'page_budget',
        resumePage: null,
      },
    }),
  };
}

const runOne = boundedRun(null, 25, 10);
assert.deepEqual(runOne.sequence, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.equal(runOne.cursor.nextPage, 11);

const restartedCursor = parseAwaitingOrderCursorState(
  JSON.parse(JSON.stringify(runOne.cursor)),
  { accountId: 'client:42', storeId: 9001 },
);
assert.ok(restartedCursor, 'serialized durable cursor must survive a worker restart');
const runTwo = boundedRun(restartedCursor, 25, 10);
assert.deepEqual(runTwo.sequence, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
assert.equal(runTwo.cursor.nextPage, 21);

const runThree = boundedRun(runTwo.cursor, 25, 10);
assert.deepEqual(runThree.sequence, [21, 22, 23, 24, 25]);
assert.equal(runThree.cursor.hasBacklog, false);
assert.equal(runThree.cursor.nextPage, 1);

assert.equal(
  awaitingOrderPageCountRebasePage({
    startPage: 21,
    previousTotalOrders: 2500,
    currentTotalOrders: 1800,
    pageSize: 100,
  }),
  14,
  'a shrinking frozen window must rewind by removed pages instead of declaring completion',
);
assert.equal(
  awaitingOrderPageCountRebasePage({
    startPage: 11,
    previousTotalOrders: 2500,
    currentTotalOrders: 2600,
    pageSize: 100,
  }),
  null,
  'growth may continue from the cursor because it shifts old rows later, not earlier',
);

const queueTruth = classifyOrderSyncQueueRows([
  { id: 'active-1', state: 'active' },
  { id: 'queued-1', state: 'created' },
]);
assert.equal(orderSyncQueueState(queueTruth), 'running');
assert.deepEqual(orderSyncQueueBlocker(queueTruth), { state: 'running', jobId: 'active-1' });
assert.equal(
  formatSyncPill({
    status: 'syncing',
    syncState: 'queued',
    mode: 'incremental',
    page: 0,
    lastSync: null,
  }).text,
  'Sync queuedâ€¦',
  'queued backend truth must not render as completed',
);
assert.equal(
  formatSyncPill({
    status: 'syncing',
    syncState: 'retrying',
    mode: 'incremental',
    page: 0,
    lastSync: null,
  }).text,
  'Sync retryingâ€¦',
);

const read = (path: string): string => readFileSync(path, 'utf8');
const orderSync = read('src/services/order-sync.ts');
const connector = read('src/connectors/store/shipstation.ts');
const route = read('src/routes/sync.ts');
const queue = read('src/services/sync-job-queue.ts');
const admission = read('src/services/sync-job-admission.ts');
const storeImport = read('src/services/store-order-import.ts');
const home = read('web/src/Home.tsx');
const ui = read('web/src/components/Views/orders-parity.ts');

assert.match(orderSync, /AWAITING_RESUME_CURSOR_KEY_PREFIX[\s\S]*shipStationSyncAccountId\(account\)/);
assert.match(orderSync, /const awaitingSinceMs = activeCursor\?\.sinceMs/);
assert.match(orderSync, /const awaitingUntilMs = activeCursor\?\.untilMs/);
assert.match(orderSync, /probeFirstPageOnResume: false/);
assert.match(orderSync, /expectedTotalOrders: activeCursor\?\.totalOrders/);
assert.match(orderSync, /readAwaitingOrderBacklogByAccount/);
assert.match(orderSync, /orderStatus: 'awaiting_shipment' as const/);
assert.match(connector, /modifyDateEnd/);

const postStart = route.indexOf("app.post('/orders'");
const statusStart = route.indexOf("app.get('/status'", postStart);
const postRoute = route.slice(postStart, statusStart);
assert.match(postRoute, /await enqueueManualOrderSyncJob\(body\)/);
assert.doesNotMatch(postRoute, /syncOrders\(|startBackfillBestRates\(/);
assert.match(postRoute, /status: result\.queueState/);
assert.match(admission, /ORDER_REFRESH_SINGLETON_KEY/);
assert.match(queue, /orderSyncQueueBlocker\(await readOrderSyncQueueTruth\(\)\)/);
assert.match(queue, /syncOrders\(\{ \.\.\.options, runIdentity: identity, signal \}\)/);

assert.match(storeImport, /enqueueBackfillBestRatesForOrderIds\(/);
assert.match(storeImport, /rateOnIngestOrderIds/);
assert.match(storeImport, /'rate-on-ingest'/);
assert.doesNotMatch(queue, /result\.synced > 0 && isRateBackfillSchedulerEnabled\(\)/);

assert.match(route, /const syncState = orders\.queueState/);
assert.match(home, /syncState,/);
assert.match(ui, /Sync queued/);
assert.match(ui, /Sync retrying/);

console.log('PASS PS-426 durable Awaiting cursor and manual sync queue guard');
