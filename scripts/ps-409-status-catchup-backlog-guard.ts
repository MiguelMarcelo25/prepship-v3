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

assert.equal(healthyExceptStatusBacklog.state, 'order_status_backlog');
assert.equal(healthyExceptStatusBacklog.alert, true);
assert.equal(healthyExceptStatusBacklog.orderFresh, true);
assert.equal(healthyExceptStatusBacklog.orderStatusBacklog, true);
assert.equal(healthyExceptStatusBacklog.orderStatusBacklogCount, 2);
assert.equal(healthyExceptStatusBacklog.recommendedAction, 'enqueue_order_sync');
assert.match(healthyExceptStatusBacklog.reason, /status catch-up/i);

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
  /if \(startPage > 1[\s\S]*processPage\(1\)/,
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
