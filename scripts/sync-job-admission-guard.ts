import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MANUAL_FULL_ORDER_SINGLETON_KEY,
  OPERATOR_SYNC_PRIORITY,
  ORDER_REFRESH_SINGLETON_KEY,
  resolveSyncJobAdmission,
  SHIPMENT_REFRESH_SINGLETON_KEY,
  SHIPSTATION_SYNC_JOBS,
  STARVATION_RECOVERY_PRIORITY,
  syncQueuePolicyForJob,
  WATCHDOG_SYNC_PRIORITY,
} from '../src/services/sync-job-admission';

const orders = SHIPSTATION_SYNC_JOBS.orders;
const shipments = SHIPSTATION_SYNC_JOBS.shipments;

assert.equal(syncQueuePolicyForJob(orders), 'stately');
assert.equal(syncQueuePolicyForJob(shipments), 'stately');
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
  orderStarvation: true,
}), {
  policy: 'stately',
  singletonKey: ORDER_REFRESH_SINGLETON_KEY,
  priority: STARVATION_RECOVERY_PRIORITY,
});

for (const intent of [
  { kind: 'cadence' } as const,
  { kind: 'manual-shipment' } as const,
  { kind: 'watchdog-shipment' } as const,
  { kind: 'busy-defer', orderStarvation: false } as const,
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
assert.match(queue, /unlock shipped data on 2026-07-14/);
assert.match(queue, /SHIPSTATION_CONSUMER_LEADER_LOCK/);
assert.match(queue, /replace\(':6543\/', ':5432\/'\)/);
assert.match(queue, /const shipStationConsumerLeaderSql = postgres\(/);
assert.match(queue, /const reserved = await shipStationConsumerLeaderSql\.reserve\(\)/);
assert.match(queue, /pg_try_advisory_lock\(hashtext\(\$\{SHIPSTATION_CONSUMER_LEADER_LOCK\}\)\)/);
assert.match(queue, /async function readActiveShipStationSyncJobs/);
assert.match(queue, /WHERE state = 'active'[\s\S]*name = ANY/);
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
