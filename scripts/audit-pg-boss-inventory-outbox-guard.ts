/** Audit 3.2 boundary guard: one durable scheduler + retryable inventory lane. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const scheduler = read('src/services/sync-scheduler.ts');
const queue = read('src/services/sync-job-queue.ts');
const worker = read('src/worker.ts');
const main = read('src/main.ts');
const env = read('src/lib/env.ts');
const envExample = read('.env.example');
const deductionOwner = read('src/services/fulfillment-deductions.ts');
const deductionOutbox = read('src/services/fulfillment/inventory-deduction-outbox.ts');
const fulfillmentOutbox = read('src/services/fulfillment/outbox.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.match(packageJson, /"test:audit-pg-boss-inventory-outbox"/);
assert.match(guardPack, /'test:audit-pg-boss-inventory-outbox'/);

assert.doesNotMatch(scheduler, /startSyncScheduler|stopSyncScheduler|setInterval\(|setTimeout\(/);
assert.doesNotMatch(main, /startSyncScheduler|services\/sync-scheduler/);
assert.match(worker, /await startQueuedSyncScheduler\(\)/);
assert.doesNotMatch(worker, /startSyncScheduler|USE_PG_BOSS_SCHEDULER/);
assert.doesNotMatch(env + envExample, /USE_PG_BOSS_SCHEDULER/);

assert.match(queue, /await boss\.schedule\(/);
assert.match(queue, /await boss\.unschedule\(name\)/);
assert.match(queue, /singletonKey: 'cadence'/);
assert.doesNotMatch(queue, /scheduleEnqueue|SYNC_STARTUP_DELAY_MS|setTimeout\(/);
assert.equal(
  queue.match(/setInterval\(/g)?.length ?? 0,
  1,
  'only the worker heartbeat may remain process-local',
);
for (const [job, cron] of [
  ['fulfillmentOutbox', 'everyMinute'],
  ['orders', 'everyThreeMinutes'],
  ['shipments', 'everyThreeMinutes'],
  ['rateBackfill', 'everyTenMinutes'],
  ['inventoryImport', 'everyThirtyMinutes'],
  ['syncProducts', 'hourly'],
  ['reportingRefresh', 'everyThirtyMinutes'],
  ['externalShippedClassifier', 'everyThreeMinutes'],
  ['shipmentTracking', 'everyFifteenMinutes'],
  ['walmartFees', 'dailyAtNineUtc'],
  ['rateMaintenance', 'everyFiveMinutes'],
  ['queueMaintenance', 'everyTenMinutes'],
  ['carrierAccountSnapshots', 'everyMinute'],
] as const) {
  assert.match(
    queue,
    new RegExp(`JOBS\\.${job},[\\s\\S]{0,100}?SCHEDULE_CRON\\.${cron}`),
    `${job} must use durable ${cron} cadence`,
  );
}
assert.match(queue, /registerWorker\(JOBS\.queueMaintenance,[\s\S]*reapStuckActiveJobs\(\)[\s\S]*reapStaleQueuedCadenceJobs\(\)/);
assert.match(queue, /registerWorker\(JOBS\.rateMaintenance,[\s\S]*runReapStaleRateJobsTick\(\)[\s\S]*runRateCacheEvictionTick\(\)/);
assert.match(queue, /registerWorker\([\s\S]{0,80}JOBS\.carrierAccountSnapshots,[\s\S]{0,80}runShipStationCarrierAccountSnapshotTick/);
assert.doesNotMatch(read('src/services/shipstation-carrier-account-snapshot-worker.ts'), /setInterval\(|setTimeout\(|startShipStationCarrierAccountSnapshotWorker/);

assert.match(deductionOwner, /INVENTORY_AUTO_DEDUCT/);
assert.match(deductionOwner, /inventory:ship:order:/);
assert.match(deductionOutbox, /await deductInventoryForOrder\(/);
assert.match(deductionOutbox, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
assert.match(deductionOutbox, /export async function enqueueMissingInventoryDeductions/);
assert.match(deductionOutbox, /o\.order_status = 'shipped'/);
assert.doesNotMatch(deductionOutbox, /UPDATE orders|UPDATE shipments|DELETE FROM/);

for (const path of [
  'src/services/labels.ts',
  'src/services/order-sync.ts',
  'src/services/shipment-sync.ts',
  'src/services/fulfillment/mark-shipped-externally.ts',
  'scripts/reconcile-orphan-shipstation-shipments.ts',
]) {
  const source = read(path);
  assert.match(source, /enqueueInventoryDeduction/);
  assert.doesNotMatch(source, /await deductInventoryForOrder\(/);
}
assert.doesNotMatch(read('src/services/labels.ts'), /background\('inventory deduction'/);

assert.match(fulfillmentOutbox, /event_type IN \('shipment_confirmation_requested', \$\{INVENTORY_DEDUCTION_OUTBOX_EVENT\}\)/);
assert.match(fulfillmentOutbox, /processInventoryDeductionOutboxEvent/);
const complete = fulfillmentOutbox.slice(
  fulfillmentOutbox.indexOf('async function completeOutboxRow'),
  fulfillmentOutbox.indexOf('async function failOutboxRow'),
);
const fail = fulfillmentOutbox.slice(
  fulfillmentOutbox.indexOf('async function failOutboxRow'),
  fulfillmentOutbox.indexOf('// Per user override unlock shipped data on 2026-06-13'),
);
assert.match(complete, /isInventoryDeductionOutboxEvent\(row\.event_type\)\) return;/);
assert.ok(complete.indexOf('isInventoryDeductionOutboxEvent') < complete.indexOf('markShipmentConfirmationState'));
assert.match(fail, /isInventoryDeductionOutboxEvent\(row\.event_type\)\) return;/);
assert.ok(fail.indexOf('isInventoryDeductionOutboxEvent') < fail.indexOf('markShipmentConfirmationState'));

console.log('PASS Audit 3.2 durable pg-boss + inventory outbox guard');
