/**
 * PS-409 - ShipStation status catch-up must be resumable/backlog-visible.
 *
 * The failure pattern: recent shipped/cancelled status changes can hide behind
 * historical ShipStation pages. Backend sync must expose partial status catch-up
 * as a health/backlog state instead of letting the sync pill imply clean health.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  evaluateShipmentSyncWatchdog,
  SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
} = await import('../src/services/shipment-sync-watchdog');
const { prioritizeOrderStatusCatchupPasses, mergeOrderStatusCatchupEntries } =
  await import('../src/services/order-sync');
type OrderStatusCatchupEntry =
  import('../src/services/order-sync').OrderStatusCatchupEntry;

const prioritizedPasses = prioritizeOrderStatusCatchupPasses(
  'main',
  [
    { orderStatus: 'shipped', sinceMs: 1, storeId: 356678 },
    { orderStatus: 'pending_fulfillment', sinceMs: 1, storeId: 378060 },
    { orderStatus: 'cancelled', sinceMs: 1, storeId: 376759 },
  ],
  {
    version: 1,
    updatedAt: '2026-07-15T00:00:00.000Z',
    hasBacklog: true,
    backlogCount: 1,
    entries: [
      {
        accountLabel: 'main',
        storeId: 378060,
        orderStatus: 'pending_fulfillment',
        sinceIso: '2026-06-15T00:00:00.000Z',
        sortDir: 'DESC',
        pageSize: 100,
        startPage: 2,
        totalPages: 3,
        pagesProcessed: 1,
        lastPageProcessed: 2,
        nextPage: 3,
        updatedRows: 0,
        hasBacklog: true,
        backlogPages: 1,
        stoppedBy: 'time_budget',
        checkedAt: '2026-07-15T00:00:00.000Z',
        stalledPasses: 0,
      },
    ],
    stalledCount: 0,
  },
);
assert.equal(prioritizedPasses[0]?.storeId, 378060);
assert.equal(prioritizedPasses[0]?.orderStatus, 'pending_fulfillment');
assert.deepEqual(
  prioritizedPasses.slice(1).map((pass) => pass.orderStatus),
  ['shipped', 'cancelled'],
  'non-backlogged status passes must retain their canonical relative order',
);

const healthyExceptStatusBacklog = evaluateShipmentSyncWatchdog(
  {
    nowMs: Date.parse('2026-07-07T01:00:00Z'),
    orderLastSyncedAt: '2026-07-07T00:59:00Z',
    shipmentLastSyncedAt: '2026-07-07T00:59:00Z',
    workerHeartbeatAgeSeconds: 30,
    queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
    missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
    consecutiveBacklogChecks: 0,
    orderStatusCatchupBacklog: true,
    orderStatusCatchupBacklogCount: 2,
  },
  SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
);

// PS-409's requirement is that a partial catch-up stays VISIBLE rather than
// implying clean health. That is the state, and it still reports unconditionally.
assert.equal(healthyExceptStatusBacklog.state, 'order_status_backlog');
assert.equal(healthyExceptStatusBacklog.orderFresh, true);
assert.equal(healthyExceptStatusBacklog.orderStatusBacklog, true);
assert.equal(healthyExceptStatusBacklog.orderStatusBacklogCount, 2);
assert.equal(healthyExceptStatusBacklog.recommendedAction, 'enqueue_order_sync');
assert.match(healthyExceptStatusBacklog.reason, /status catch-up/i);

// PS-431 refines only the ALARM. A page-budgeted catch-up on a store with more
// pages than the budget always leaves pages behind, so `hasBacklog` alone fired
// forever: production store 378060 (13 pages, 10-page budget) flapped the
// watchdog red/green 12 times in 20 runs while updating zero rows. A backlog
// that is still draining is progress, not a fault.
assert.equal(healthyExceptStatusBacklog.alert, false);
assert.match(healthyExceptStatusBacklog.reason, /working through/i);

const stalledStatusBacklog = evaluateShipmentSyncWatchdog(
  {
    nowMs: Date.parse('2026-07-07T01:00:00Z'),
    orderLastSyncedAt: '2026-07-07T00:59:00Z',
    shipmentLastSyncedAt: '2026-07-07T00:59:00Z',
    workerHeartbeatAgeSeconds: 30,
    queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
    missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
    consecutiveBacklogChecks: 0,
    orderStatusCatchupBacklog: true,
    orderStatusCatchupBacklogCount: 2,
    orderStatusCatchupStalledCount: 1,
  },
  SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
);

// ...but a backlog that has stopped advancing must still escalate, or PS-431
// would have traded false alarms for silence on a genuinely wedged catch-up.
assert.equal(stalledStatusBacklog.state, 'order_status_backlog');
assert.equal(stalledStatusBacklog.alert, true);
assert.equal(stalledStatusBacklog.orderStatusStalledCount, 1);
assert.match(stalledStatusBacklog.reason, /not draining/i);

// The stall counter itself: the owner is mergeOrderStatusCatchupEntries, which is
// the only place that can compare a pass against its predecessor.
const stallEntry = (over: Partial<OrderStatusCatchupEntry>): OrderStatusCatchupEntry => ({
  accountLabel: 'main',
  storeId: 378060,
  orderStatus: 'shipped',
  sinceIso: '2026-06-15T00:00:00.000Z',
  sortDir: 'DESC',
  pageSize: 100,
  startPage: 1,
  totalPages: 13,
  pagesProcessed: 10,
  lastPageProcessed: 10,
  nextPage: 11,
  updatedRows: 0,
  hasBacklog: true,
  backlogPages: 3,
  stoppedBy: 'page_budget',
  checkedAt: '2026-07-15T00:00:00.000Z',
  stalledPasses: 0,
  ...over,
});
const stallKeys = new Set(['main:378060:shipped']);
const stallOnce = mergeOrderStatusCatchupEntries(
  [stallEntry({ stalledPasses: 0 })], [stallEntry({})], stallKeys);
assert.equal(stallOnce[0]?.stalledPasses, 1, 'same nextPage across passes increments the stall');

const stallAdvanced = mergeOrderStatusCatchupEntries(
  [stallEntry({ stalledPasses: 4 })], [stallEntry({ nextPage: 12 })], stallKeys);
assert.equal(stallAdvanced[0]?.stalledPasses, 0, 'an advancing cursor is draining, not stalled');

// The exact production shape: budget-limited pass, then a completing pass. This
// is the alternation that caused the flap and it must never count as a stall.
const stallDrained = mergeOrderStatusCatchupEntries(
  [stallEntry({ stalledPasses: 2 })],
  [stallEntry({ hasBacklog: false, nextPage: null, stoppedBy: 'complete' })],
  stallKeys,
);
assert.equal(stallDrained[0]?.stalledPasses, 0, 'clearing the backlog resets the stall');

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
assert.match(
  orderSync,
  /STATUS_CATCHUP_SNAPSHOT_KEY = 'order_sync\.status_catchup\.snapshot'/,
  'order sync must persist status catch-up snapshot in backend settings',
);
assert.match(
  orderSync,
  /STATUS_CATCHUP_STATUSES\.flatMap/,
  'status catch-up must enumerate canonical backend statuses from one owner',
);
assert.match(
  orderSync,
  /function statusCatchupStoreTargets\(account: SyncAccount\)/,
  'status catch-up must prefer account/store-scoped provider calls',
);
assert.match(
  orderSync,
  /storeId: pass\.storeId/,
  'status catch-up provider calls must pass store scope when known',
);
assert.match(
  orderSync,
  /stoppedBy: 'not_started_budget_exhausted'/,
  'status catch-up must record passes skipped by the run budget',
);
assert.match(
  orderSync,
  /persistOrderStatusCatchupSnapshot\([\s\S]*previousStatusCatchup,[\s\S]*accounts,/,
  'order sync must merge the run-level status catch-up backlog with prior account cursors',
);
assert.match(
  orderSync,
  /mergeOrderStatusCatchupEntries/,
  'bounded runs must retain backlog entries for accounts they did not reach',
);
assert.match(
  orderSync,
  /prioritizeOrderStatusCatchupPasses/,
  'durable backlog cursors must run before fresh status passes on the next bounded run',
);
assert.match(
  orderSync,
  /statusCatchup: OrderStatusCatchupSnapshot/,
  'getSyncStatus must expose backend-owned status catch-up state',
);
assert.match(
  orderSync,
  /startPage: number/,
  'status catch-up snapshot must persist the page a pass started from',
);
assert.match(
  orderSync,
  /nextPage: number \| null/,
  'status catch-up snapshot must persist the next resumable page',
);
assert.match(
  orderSync,
  /function statusCatchupResumePage/,
  'order sync must compute a durable resume page from the previous catch-up snapshot',
);
assert.match(
  orderSync,
  /previousStatusCatchup = opts\.skipStatusPasses[\s\S]*getOrderStatusCatchupSnapshot\(\)/,
  'syncOrders must read the previous status catch-up snapshot before starting provider passes',
);
assert.match(
  orderSync,
  /startPage: statusCatchupResumePage\(/,
  'status catch-up provider calls must resume from the stored page cursor',
);
assert.match(
  orderSync,
  // Whitespace-tolerant: the condition is a multi-line `if (\n  startPage > 1 &&`.
  // The original regex required `if (startPage` adjacent and went red the moment
  // the condition grew a second clause -- protection intact, assertion rotted.
  /if \(\s*startPage > 1[\s\S]*processPage\(1\)/,
  'resumed status catch-up must still probe newest-first page 1 for recent transitions',
);
assert.match(
  orderSync,
  /resumes from the stored page cursor so a large history does not restart\s+\/\/ page 1 forever/,
  'order sync must document why the resume cursor exists',
);

const watchdog = readFileSync('src/services/shipment-sync-watchdog.ts', 'utf8');
assert.match(
  watchdog,
  /'order_status_backlog'/,
  'watchdog must have a non-healthy order_status_backlog state',
);
assert.match(
  watchdog,
  /orderStatusCatchupBacklog: orders\.statusCatchup\.hasBacklog/,
  'watchdog must consume the backend status catch-up snapshot',
);
assert.match(
  watchdog,
  /statusCatchup: orders\.statusCatchup/,
  'sync status payload must expose catch-up backlog details to the UI as backend data',
);

console.log('PASS PS-409 status catch-up backlog guard');
