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
  /persistOrderStatusCatchupSnapshot\(statusCatchupEntries, runStartMs\)/,
  'order sync must persist the run-level status catch-up backlog snapshot',
);
assert.match(
  orderSync,
  /statusCatchup: OrderStatusCatchupSnapshot/,
  'getSyncStatus must expose backend-owned status catch-up state',
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
