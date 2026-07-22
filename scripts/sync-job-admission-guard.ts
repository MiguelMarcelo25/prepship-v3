import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FULFILLMENT_OUTBOX_JOB_NAME,
  FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS,
  FULFILLMENT_OUTBOX_SINGLETON_KEY,
  MANUAL_FULL_ORDER_SINGLETON_KEY,
  OPERATOR_SYNC_PRIORITY,
  ORDER_RECOVERY_SINGLETON_KEY,
  ORDER_REFRESH_SINGLETON_KEY,
  rateBackfillOperationalBlocker,
  resolveSyncJobAdmission,
  runnableOperationalSyncQueueSizes,
  shipmentSyncRequestHasRecoveryPriority,
  SHIPMENT_REFRESH_SINGLETON_KEY,
  SHIPSTATION_SYNC_JOBS,
  shouldYieldOrderSyncToFulfillmentOutbox,
  shouldYieldOrderSyncToShipmentRecovery,
  shouldYieldShipmentSyncToOrders,
  STARVED_SHIPMENT_LOOKAHEAD_MS,
  STARVATION_RECOVERY_PRIORITY,
  SYNC_STARVATION_DEFER_THRESHOLD,
  syncQueuePolicyForJob,
  WATCHDOG_SYNC_PRIORITY,
} from '../src/services/sync-job-admission';

const orders = SHIPSTATION_SYNC_JOBS.orders;
const shipments = SHIPSTATION_SYNC_JOBS.shipments;
const fulfillmentOutbox = FULFILLMENT_OUTBOX_JOB_NAME;
const now = Date.parse('2026-07-18T06:45:00.000Z');

assert.deepEqual(
  runnableOperationalSyncQueueSizes([
    { name: orders, state: 'created', startAfter: new Date(now - 1) },
    { name: shipments, state: 'retry', startAfter: new Date(now) },
    { name: shipments, state: 'created', startAfter: new Date(now + 60_000) },
    { name: orders, state: 'active', startAfter: new Date(now - 60_000) },
  ], now),
  { orders: 1, shipments: 1 },
  'only due created/retry rows are runnable admission blockers',
);
assert.deepEqual(
  runnableOperationalSyncQueueSizes([
    { name: shipments, state: 'created', startAfter: new Date(now + 60_000) },
  ], now),
  { orders: 0, shipments: 0 },
  'a future shipment defer must not starve rates that can run now',
);

assert.equal(
  rateBackfillOperationalBlocker({ orders: 1, shipments: 1 }),
  orders,
);
assert.equal(
  rateBackfillOperationalBlocker({ orders: 0, shipments: 2 }),
  shipments,
);
assert.equal(
  rateBackfillOperationalBlocker({ orders: 0, shipments: 0 }),
  null,
);

assert.equal(
  shouldYieldShipmentSyncToOrders({
    ordersPending: true,
    priorDeferCount: 0,
    recoveryRequested: false,
  }),
  true,
  'a fresh shipment attempt yields once to pending order work',
);
assert.equal(
  shouldYieldShipmentSyncToOrders({
    ordersPending: true,
    priorDeferCount: 1,
    recoveryRequested: false,
  }),
  false,
  'the durable replacement cannot be preempted by recurring cadence orders',
);
assert.equal(
  shouldYieldShipmentSyncToOrders({
    ordersPending: false,
    priorDeferCount: 0,
    recoveryRequested: false,
  }),
  false,
  'shipment work continues when no order work is pending',
);
assert.equal(
  shouldYieldShipmentSyncToOrders({
    ordersPending: true,
    priorDeferCount: 0,
    recoveryRequested: true,
  }),
  false,
  'an explicit shipment recovery cannot preempt itself back to orders',
);
assert.equal(shipmentSyncRequestHasRecoveryPriority({
  requestedBy: 'manual-shipment-sync',
}), true);
assert.equal(shipmentSyncRequestHasRecoveryPriority({
  requestedBy: 'shipment-sync-watchdog',
}), true);
assert.equal(shipmentSyncRequestHasRecoveryPriority({
  requestedBy: 'pg-boss-cron',
}), false);

const starvedShipment = {
  name: shipments,
  state: 'created',
  startAfter: new Date(now + STARVED_SHIPMENT_LOOKAHEAD_MS),
  priority: 0,
  deferCount: String(SYNC_STARVATION_DEFER_THRESHOLD),
};
assert.equal(
  shouldYieldOrderSyncToShipmentRecovery([starvedShipment], now),
  true,
  'a repeatedly deferred shipment blocks another long order refresh',
);
assert.equal(
  shouldYieldOrderSyncToShipmentRecovery([{
    ...starvedShipment,
    deferCount: '0',
    priority: WATCHDOG_SYNC_PRIORITY,
  }], now),
  true,
  'a watchdog shipment recovery receives cross-queue admission priority',
);
assert.equal(
  shouldYieldOrderSyncToShipmentRecovery([{
    ...starvedShipment,
    startAfter: new Date(now + STARVED_SHIPMENT_LOOKAHEAD_MS + 1),
  }], now),
  false,
  'far-future shipment work does not block current order work',
);
assert.equal(
  shouldYieldOrderSyncToShipmentRecovery([{
    ...starvedShipment,
    state: 'active',
    startAfter: new Date(now + STARVED_SHIPMENT_LOOKAHEAD_MS + 1),
  }], now),
  true,
  'an already-claimed shipment attempt wins the advisory-lock race',
);
assert.equal(
  shouldYieldOrderSyncToShipmentRecovery([{
    ...starvedShipment,
    deferCount: '0',
    priority: 0,
  }], now),
  false,
  'fresh cadence work retains the existing orders-first behavior',
);

const outboxRecovery = {
  name: fulfillmentOutbox,
  state: 'created',
  startAfter: new Date(now + FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS),
  priority: STARVATION_RECOVERY_PRIORITY,
  deferCount: '1',
};
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([outboxRecovery], now),
  true,
  'an approaching durable outbox recovery blocks another long order refresh',
);
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([{
    ...outboxRecovery,
    startAfter: new Date(now + FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS + 1),
  }], now),
  false,
  'a far-future outbox recovery does not block current order work',
);
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([{
    ...outboxRecovery,
    startAfter: new Date(now),
    priority: 0,
    deferCount: '0',
  }], now),
  true,
  'a due cadence outbox wake-up receives the shared lane',
);
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([{
    ...outboxRecovery,
    startAfter: new Date(now),
    priority: 0,
    deferCount: '0',
  }], now, SYNC_STARVATION_DEFER_THRESHOLD),
  false,
  'a repeatedly deferred order receives one protected recovery turn',
);
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([{
    ...outboxRecovery,
    state: 'active',
    startAfter: new Date(now + FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS + 1),
  }], now, SYNC_STARVATION_DEFER_THRESHOLD),
  true,
  'an active outbox attempt still wins the shared-lane race',
);
assert.equal(
  shouldYieldOrderSyncToFulfillmentOutbox([{
    ...outboxRecovery,
    priority: 0,
    deferCount: '0',
  }], now),
  false,
  'a not-yet-due cadence row does not preempt order work',
);

assert.equal(syncQueuePolicyForJob(orders), 'stately');
assert.equal(syncQueuePolicyForJob(shipments), 'stately');
assert.equal(syncQueuePolicyForJob(fulfillmentOutbox), 'stately');
assert.equal(syncQueuePolicyForJob('prepship.reporting.refresh'), 'standard');

assert.deepEqual(resolveSyncJobAdmission(orders, { kind: 'cadence' }), {
  policy: 'stately',
  singletonKey: ORDER_REFRESH_SINGLETON_KEY,
  priority: 0,
});
assert.deepEqual(resolveSyncJobAdmission(orders, {
  kind: 'manual-order',
  mode: 'incremental',
}), {
  policy: 'stately',
  singletonKey: ORDER_REFRESH_SINGLETON_KEY,
  priority: OPERATOR_SYNC_PRIORITY,
});
assert.deepEqual(resolveSyncJobAdmission(orders, {
  kind: 'manual-order',
  mode: 'full',
}), {
  policy: 'stately',
  singletonKey: MANUAL_FULL_ORDER_SINGLETON_KEY,
  priority: OPERATOR_SYNC_PRIORITY,
});
assert.deepEqual(resolveSyncJobAdmission(orders, { kind: 'watchdog-order' }), {
  policy: 'stately',
  singletonKey: ORDER_REFRESH_SINGLETON_KEY,
  priority: WATCHDOG_SYNC_PRIORITY,
});
assert.deepEqual(resolveSyncJobAdmission(orders, {
  kind: 'busy-defer',
  recoveryPriority: true,
}), {
  policy: 'stately',
  singletonKey: ORDER_RECOVERY_SINGLETON_KEY,
  priority: STARVATION_RECOVERY_PRIORITY,
});
assert.equal(
  resolveSyncJobAdmission(orders, {
    kind: 'busy-defer',
    recoveryPriority: false,
  }).singletonKey,
  ORDER_RECOVERY_SINGLETON_KEY,
  'order deferral lineage must not be overwritten by a cadence replacement',
);

for (const intent of [
  { kind: 'cadence' } as const,
  { kind: 'manual-shipment' } as const,
  { kind: 'watchdog-shipment' } as const,
  { kind: 'busy-defer', recoveryPriority: false } as const,
]) {
  assert.equal(
    resolveSyncJobAdmission(shipments, intent).singletonKey,
    SHIPMENT_REFRESH_SINGLETON_KEY,
  );
}
assert.equal(
  resolveSyncJobAdmission(shipments, { kind: 'manual-shipment' }).priority,
  OPERATOR_SYNC_PRIORITY,
);
assert.equal(
  resolveSyncJobAdmission(shipments, { kind: 'watchdog-shipment' }).priority,
  WATCHDOG_SYNC_PRIORITY,
);
assert.ok(OPERATOR_SYNC_PRIORITY > WATCHDOG_SYNC_PRIORITY);
assert.ok(WATCHDOG_SYNC_PRIORITY > STARVATION_RECOVERY_PRIORITY);

assert.deepEqual(resolveSyncJobAdmission(fulfillmentOutbox, { kind: 'cadence' }), {
  policy: 'stately',
  singletonKey: FULFILLMENT_OUTBOX_SINGLETON_KEY,
  priority: 0,
});
assert.deepEqual(resolveSyncJobAdmission(fulfillmentOutbox, {
  kind: 'busy-defer',
  recoveryPriority: true,
}), {
  policy: 'stately',
  singletonKey: FULFILLMENT_OUTBOX_SINGLETON_KEY,
  priority: STARVATION_RECOVERY_PRIORITY,
});

assert.throws(
  () => resolveSyncJobAdmission(shipments, { kind: 'manual-order', mode: 'incremental' }),
  /Manual order sync cannot target/,
);
assert.throws(
  () => resolveSyncJobAdmission(orders, { kind: 'manual-shipment' }),
  /Shipment recovery cannot target/,
);
assert.throws(
  () => resolveSyncJobAdmission(shipments, { kind: 'watchdog-order' }),
  /Order recovery cannot target/,
);

const read = (path: string): string => readFileSync(path, 'utf8');
const queue = read('src/services/sync-job-queue.ts');
const reaper = read('src/services/sync-stuck-job-reaper.ts');
const pkg = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.match(queue, /policy: syncQueuePolicyForJob\(name\)/);
assert.match(queue, /await targetBoss\.createQueue\(name, options\)/);
assert.match(queue, /await targetBoss\.updateQueue\(name, options\)/);
assert.match(queue, /resolveSyncJobAdmission\(JOBS\.orders,[\s\S]*kind: 'manual-order'/);
assert.match(queue, /resolveSyncJobAdmission\(JOBS\.orders,[\s\S]*kind: 'watchdog-order'/);
assert.match(queue, /resolveSyncJobAdmission\(JOBS\.shipments,[\s\S]*kind: 'manual-shipment'/);
assert.match(queue, /resolveSyncJobAdmission\(JOBS\.shipments,[\s\S]*kind: 'watchdog-shipment'/);
assert.match(queue, /resolveSyncJobAdmission\(name, \{[\s\S]*kind: 'busy-defer'/);
assert.match(queue, /resolveSyncJobAdmission\(name, \{ kind: 'cadence' \}\)/);
assert.match(queue, /shouldYieldShipmentSyncToOrders\(\{[\s\S]*ordersPending: hasPendingOrderSyncWork\(queueTruth\),[\s\S]*priorDeferCount/);
assert.match(queue, /pendingShipmentRecoveryBlockerForOrders[\s\S]*shouldYieldOrderSyncToShipmentRecovery\(rows\)/);
assert.match(queue, /pendingFulfillmentOutboxBlockerForOrders[\s\S]*shouldYieldOrderSyncToFulfillmentOutbox\(rows, Date\.now\(\), priorOrderDeferCount\)/);
assert.match(queue, /pendingFulfillmentOutboxBlockerForOrders\(priorDeferCount\)/);
assert.match(queue, /name === JOBS\.orders[\s\S]*fulfillment_outbox_recovery_pending[\s\S]*shipment_recovery_pending/);
assert.match(queue, /runOrderSyncWithOutboxPriority[\s\S]*yielded_to_pending_fulfillment_outbox/);
assert.match(queue, /registerWorker\(JOBS\.fulfillmentOutbox, runFulfillmentOutboxTick\)/);
assert.match(queue, /return id \?\? `coalesced:\$\{admission\.singletonKey\}`/);
assert.match(
  queue,
  /name === JOBS\.rateBackfill[\s\S]*pendingOperationalBlockerForRateBackfill\(\)[\s\S]*reason: 'operational_sync_pending'/,
);
assert.match(
  queue,
  /pendingOperationalBlockerForRateBackfill[\s\S]*start_after AS "startAfter"[\s\S]*runnableOperationalSyncQueueSizes\(rows\)/,
);
assert.doesNotMatch(
  queue,
  /pendingOperationalBlockerForRateBackfill[\s\S]{0,400}getQueueSize/,
);
assert.match(queue, /unlock shipped data on 2026-07-14/);
assert.match(queue, /SHIPSTATION_CONSUMER_LEADER_LOCK/);
assert.match(queue, /replace\(':6543\/', ':5432\/'\)/);
assert.match(queue, /const shipStationConsumerLeaderSql = postgres\(/);
assert.match(queue, /const reserved = await shipStationConsumerLeaderSql\.reserve\(\)/);
assert.match(queue, /pg_try_advisory_lock\(hashtext\(\$\{SHIPSTATION_CONSUMER_LEADER_LOCK\}\)\)/);
assert.match(queue, /async function readActiveShipStationSyncJobs/);
assert.match(queue, /WHERE state = 'active'[\s\S]*name = ANY/);
assert.match(queue, /const shipStationConsumerStateSql = postgres\(/);
assert.match(
  queue,
  /readActiveShipStationSyncJobs[\s\S]*return shipStationConsumerStateSql<ActiveShipStationSyncJob\[\]>/,
);
assert.match(queue, /await maintainShipStationConsumerLeadership\(\)/);
assert.match(queue, /await registerShipStationStatelyWorkers\(\)/);
assert.match(queue, /pg_advisory_unlock\(hashtext\(\$\{SHIPSTATION_CONSUMER_LEADER_LOCK\}\)\)/);

assert.match(reaper, /PARTITION BY name, logical_singleton_key/);
assert.match(reaper, /LEGACY_ORDER_REFRESH_SINGLETON_KEYS/);
assert.match(reaper, /LEGACY_SHIPMENT_REFRESH_SINGLETON_KEYS/);
assert.doesNotMatch(reaper, /DELETE FROM/);
assert.match(
  pkg,
  /"test:sync-job-admission"\s*:\s*"tsx scripts\/sync-job-admission-guard\.ts"/,
);
assert.match(guardPack, /'test:sync-job-admission'/);

console.log('PASS sync job admission guard');
