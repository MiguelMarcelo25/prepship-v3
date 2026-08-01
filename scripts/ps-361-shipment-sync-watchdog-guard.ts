/**
 * PS-361 shipment-sync watchdog guard.
 *
 * Pins the source-of-truth behavior for the split-sync failure DJ saw:
 * order sync can remain fresh while shipment/label sync silently goes stale.
 * The fix must live in backend sync health/recovery, expose operator status,
 * and use an explicit Render control-plane restart path instead of pretending
 * a dead worker can restart itself.
 */
import { readFileSync } from 'node:fs';
import {
  evaluateShipmentSyncWatchdog,
  SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
} from '../src/services/shipment-sync-watchdog';

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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const thresholds = SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS;

const healthy = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T11:57:00Z',
  workerHeartbeatAgeSeconds: 45,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 12, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
check('fresh order sync + fresh shipment sync -> ok', healthy.state === 'ok' && healthy.alert === false);

const splitBrain = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T09:13:00Z',
  workerHeartbeatAgeSeconds: 45,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 93, missingActiveShipments: 76 },
  consecutiveBacklogChecks: 0,
});
check('orders fresh but shipments stale -> shipment_stale alert', splitBrain.state === 'shipment_stale' && splitBrain.alert === true);
check('shipment stale verdict asks for shipment enqueue before restart', splitBrain.recommendedAction === 'enqueue_shipment_sync');

const allStale = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T07:00:00Z',
  shipmentLastSyncedAt: '2026-07-01T07:00:00Z',
  workerHeartbeatAgeSeconds: 45,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 0, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
check('orders stale and shipments stale -> all_stale, not split-brain shipment_stale', allStale.state === 'all_stale');

const staleWorker = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T09:13:00Z',
  workerHeartbeatAgeSeconds: thresholds.workerHeartbeatStaleSeconds + 1,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 20, missingActiveShipments: 10 },
  consecutiveBacklogChecks: 0,
});
check('stale worker heartbeat outranks enqueue recovery', staleWorker.state === 'worker_stale' && staleWorker.recommendedAction === 'restart_worker');

const stuckJob = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T11:57:00Z',
  workerHeartbeatAgeSeconds: 45,
  queue: {
    created: 0,
    retry: 0,
    active: 1,
    failed: 0,
    activeMaxAgeSeconds: thresholds.activeJobStuckSeconds + 1,
  },
  missingShipments: { recentShippedOrders: 12, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
check('stale active shipment job -> reap stale jobs before enqueue', stuckJob.state === 'shipment_job_stuck' && stuckJob.recommendedAction === 'reap_stale_jobs');

const staleWorkerAndStuckJob = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T11:57:00Z',
  workerHeartbeatAgeSeconds: thresholds.workerHeartbeatStaleSeconds + 1,
  queue: {
    created: 0,
    retry: 0,
    active: 1,
    failed: 0,
    activeMaxAgeSeconds: thresholds.activeJobStuckSeconds + 1,
  },
  missingShipments: { recentShippedOrders: 12, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
});
check('stale active shipment job is reaped before worker restart escalation',
  staleWorkerAndStuckJob.state === 'shipment_job_stuck' &&
  staleWorkerAndStuckJob.recommendedAction === 'reap_stale_jobs');

const backlog = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-01T12:00:00Z'),
  orderLastSyncedAt: '2026-07-01T11:58:00Z',
  shipmentLastSyncedAt: '2026-07-01T11:57:00Z',
  workerHeartbeatAgeSeconds: 45,
  queue: { created: thresholds.queueBacklogThreshold + 1, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 12, missingActiveShipments: 0 },
  consecutiveBacklogChecks: thresholds.queueBacklogConsecutiveChecks,
});
check('persistent shipment queue backlog -> backlog alert', backlog.state === 'shipment_backlog' && backlog.recommendedAction === 'reap_stale_jobs');

const syncRoute = read('src/routes/sync.ts');
const cronRoute = read('src/routes/cron.ts');
const main = read('src/main.ts');
const env = read('src/lib/env.ts');
const queue = read('src/services/sync-job-queue.ts');
const service = read('src/services/shipment-sync-watchdog.ts');
const reaper = read('src/services/sync-stuck-job-reaper.ts');
const pkg = read('package.json');

check('sync status exposes shipment watchdog state', syncRoute.includes('readShipmentSyncWatchdogStatus') && /watchdog/.test(syncRoute));
check('sync status exposes watchdog truth without recovery side effects',
  syncRoute.includes('readShipmentSyncWatchdogStatus') &&
  !syncRoute.includes('nudgeShipmentSyncWatchdogRecovery'));
check('cron route exposes cron-secret shipment watchdog tick', cronRoute.includes("'/shipment-sync-watchdog'") && cronRoute.includes('runShipmentSyncWatchdogTick'));
check('API process starts independent shipment watchdog timer', main.includes('startShipmentSyncWatchdog') && main.includes('SHIPMENT_SYNC_WATCHDOG_ENABLED'));
check('env defines PS-361 watchdog thresholds and restart gates',
  env.includes('SHIPMENT_SYNC_WATCHDOG_ENABLED') &&
  env.includes('SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS') &&
  env.includes('SHIPMENT_SYNC_WATCHDOG_RESTART_COOLDOWN_MS') &&
  env.includes('SHIPMENT_SYNC_WATCHDOG_MAX_RESTARTS_PER_HOUR') &&
  env.includes('RENDER_API_KEY'));
check('queue exports a safe watchdog shipment enqueue helper', queue.includes('enqueueShipmentSyncWatchdogJob'));
check('watchdog only targets shipment sync queue, not fulfillment outbox side effects',
  service.includes('prepship.sync.shipments') &&
  !service.includes('prepship.sync.fulfillment-outbox') &&
  !service.includes('external-shipped-classifier'));
check('watchdog recovery can clear stale busy-defer/watchdog shipment queue rows',
  service.includes('reapStaleQueuedCadenceJobs') &&
  reaper.includes("'busy-defer'") &&
  reaper.includes("'watchdog-recovery'") &&
  /PARTITION BY name, logical_singleton_key/.test(reaper));
check('Render restart path is explicit, env-gated, and auditable',
  service.includes('SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS') &&
  service.includes('RENDER_API_KEY') &&
  service.includes('recordWatchdogAction') &&
  service.includes('restart-requested'));
// The helper was renamed with -> try (non-blocking acquire: a second caller
// skips rather than queues, which still serializes the tick). The assertion kept
// grepping the old spelling and went red on a clean base while the lock was
// intact. Accept either form so a rename cannot masquerade as a lost lock, but
// still require the lock to be taken on the tick's own key.
check('timer and cron recovery drivers serialize the complete watchdog tick',
  /\b(with|try)AdvisoryTransactionLock\(WATCHDOG_TICK_LOCK/.test(service) &&
  /app\.post\('\/shipment-sync-watchdog'[\s\S]*runShipmentSyncWatchdogTick/.test(cronRoute) &&
  /app\.get\('\/shipment-sync-watchdog'[\s\S]*runShipmentSyncWatchdogTick/.test(cronRoute));
check('watchdog records shipped-data override comment and safety boundary', /unlock shipped data on 2026-07-01/.test(service));
check('package wires test:ps-361-shipment-sync-watchdog',
  /"test:ps-361-shipment-sync-watchdog"\s*:\s*"tsx scripts\/ps-361-shipment-sync-watchdog-guard\.ts"/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-361 shipment-sync watchdog guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-361 shipment-sync watchdog guard');
