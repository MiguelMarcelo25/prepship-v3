/**
 * PS-397 - order sync freshness must be backend-owned.
 *
 * The failure pattern: order-sync jobs are scheduled, but successful order import
 * freshness stays stale because the shared ShipStation lane is repeatedly
 * blocked. Status/watchdog must report stale/blocked order sync and recover by
 * enqueueing the order-sync job, not by declaring healthy just because worker
 * heartbeat or shipment sync is fresh.
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
const { buildOrderSyncWatchdogJobPayload } = await import('../src/services/manual-order-sync-job');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const thresholds = SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS;

const staleOrdersFreshShipments = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-06T07:00:00Z'),
  orderLastSyncedAt: '2026-07-06T06:20:00Z',
  shipmentLastSyncedAt: '2026-07-06T06:59:00Z',
  workerHeartbeatAgeSeconds: 30,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
assert.equal(staleOrdersFreshShipments.state, 'order_stale');
assert.equal(staleOrdersFreshShipments.alert, true);
assert.equal(staleOrdersFreshShipments.orderFresh, false);
assert.equal(staleOrdersFreshShipments.recommendedAction, 'enqueue_order_sync');
assert.match(staleOrdersFreshShipments.reason, /order sync.+stale/i);

const bothStale = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-06T07:00:00Z'),
  orderLastSyncedAt: '2026-07-06T06:00:00Z',
  shipmentLastSyncedAt: '2026-07-06T06:00:00Z',
  workerHeartbeatAgeSeconds: 30,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 0, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
assert.equal(bothStale.state, 'all_stale');
assert.equal(bothStale.recommendedAction, 'enqueue_order_sync');

const staleWorkerStillOutranksOrderRecovery = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-06T07:00:00Z'),
  orderLastSyncedAt: '2026-07-06T06:20:00Z',
  shipmentLastSyncedAt: '2026-07-06T06:59:00Z',
  workerHeartbeatAgeSeconds: thresholds.workerHeartbeatStaleSeconds + 1,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 0, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
assert.equal(staleWorkerStillOutranksOrderRecovery.state, 'worker_stale');
assert.equal(staleWorkerStillOutranksOrderRecovery.recommendedAction, 'restart_worker');

const watchdogRecoveryPayload = buildOrderSyncWatchdogJobPayload();
assert.equal(watchdogRecoveryPayload.requestedBy, 'watchdog-recovery');
assert.equal(watchdogRecoveryPayload.mode, 'incremental');
assert.equal(
  watchdogRecoveryPayload.skipStatusPasses,
  undefined,
  'watchdog recovery must run canonical status catch-up instead of repeating the fast manual refresh',
);

const watchdog = read('src/services/shipment-sync-watchdog.ts');
const queue = read('src/services/sync-job-queue.ts');
const route = read('src/routes/sync.ts');
const ui = read('web/src/components/Views/orders-parity.ts');
const pkg = read('package.json');

assert.ok(
  watchdog.includes("'order_stale'") && watchdog.includes("'enqueue_order_sync'"),
  'watchdog verdict must have an explicit order_stale state and enqueue_order_sync action',
);
assert.ok(
  watchdog.includes('enqueueOrderSyncWatchdogJob') &&
    watchdog.includes("action === 'enqueue_order_sync'") &&
    watchdog.includes('order sync recovery job enqueued'),
  'watchdog recovery must target the status-capable order-sync recovery job',
);
assert.ok(
  queue.includes('buildOrderSyncWatchdogJobPayload') &&
    queue.includes("kind: 'watchdog-order'"),
  'watchdog order recovery must use its own backend payload and admission intent',
);
assert.ok(
  watchdog.includes('orderBlockedBy') &&
    watchdog.includes('orderAgeSeconds') &&
    watchdog.includes('fresh: verdict.orderFresh && !orders.statusCatchup.hasBacklog') &&
    watchdog.includes('stale: !verdict.orderFresh || orders.statusCatchup.hasBacklog'),
  'watchdog status payload must expose order freshness, status backlog, and blocker details',
);
assert.ok(
  queue.includes('ORDER_STARVATION_DEFER_THRESHOLD') &&
    queue.includes('ORDER_STARVATION_DEFER_SECONDS') &&
    queue.includes('deferCount') &&
    queue.includes("kind: 'busy-defer'") &&
    queue.includes('priority: admission.priority'),
  'queue owner must escalate repeated order deferrals instead of using the same one-minute retry forever',
);
assert.ok(
  queue.includes('blockedBy') &&
    queue.includes('deferredBecause') &&
    queue.includes('deferCount'),
  'queue defer payload must preserve the blocker and deferral count for status/recovery evidence',
);
assert.ok(
  route.includes('watchdog') &&
    route.includes('readShipmentSyncWatchdogStatus') &&
    !route.includes('nudgeShipmentSyncWatchdogRecovery'),
  '/sync/status must expose backend watchdog truth without triggering recovery side effects',
);
assert.ok(
  ui.includes('Warning: sync needs attention.') &&
    !ui.includes('Warning: shipment/label sync needs attention.'),
  'Orders sync pill must display backend watchdog alerts without implying only label sync can be stale',
);
assert.match(
  pkg,
  /"test:ps-397-order-sync-freshness"\s*:\s*"tsx scripts\/ps-397-order-sync-freshness-guard\.ts"/,
);

console.log('PASS PS-397 order-sync freshness guard');
