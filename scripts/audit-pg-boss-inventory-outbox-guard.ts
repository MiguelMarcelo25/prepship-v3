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
assert.match(queue, /resolveSyncJobAdmission\(name, \{ kind: 'cadence' \}\)/);
assert.match(queue, /singletonKey: admission\.singletonKey/);
assert.doesNotMatch(queue, /scheduleEnqueue|SYNC_STARTUP_DELAY_MS/);
assert.equal(
  queue.match(/setTimeout\(/g)?.length ?? 0,
  1,
  'only the ShipStation consumer-leadership control-plane retry timer may remain process-local',
);
assert.match(
  queue,
  /class ShipStationConsumerLeadershipController[\s\S]*private schedule\([\s\S]*dependencies\.setTimer[\s\S]*setTimer: \(callback, delayMs\) => \{[\s\S]{0,120}setTimeout\(callback, delayMs\)/,
  'the remaining timeout must be scoped to queue-consumer leadership, not durable job cadence',
);
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
assert.match(deductionOwner, /export async function applyInventoryClaimsForLifecycleEvent/);
// PS-497 Slice 2 Release B (S2.4x): the legacy inventory_deduction_requested lane is QUARANTINED. The minters
// + recovery are no-ops, the processor fails closed, and forward deduction moved to the dedicated occurrence
// lane that delegates to the kill-switch-governed executor (applyOccurrenceClaims). The master kill switch +
// legacy owner symbols asserted above are unchanged. Re-anchored to where the durable lane moved.
const occurrenceOutbox = read('src/services/fulfillment/occurrence-deduction-outbox.ts');
assert.match(deductionOutbox, /quarantined \(fail-closed\)/);
assert.match(deductionOutbox, /export async function enqueueInventoryClaimDeduction/);
assert.match(deductionOutbox, /export async function enqueueMissingInventoryDeductions/);
assert.match(deductionOutbox, /export async function processInventoryDeductionOutboxEvent/);
assert.doesNotMatch(deductionOutbox, /await deductInventoryForOrder\(/);
assert.doesNotMatch(deductionOutbox, /await applyInventoryClaimsForLifecycleEvent\(/);
assert.doesNotMatch(deductionOutbox, /UPDATE orders|UPDATE shipments|DELETE FROM/);
assert.match(occurrenceOutbox, /export async function processFulfillmentOccurrenceOutboxOnce/);
assert.match(occurrenceOutbox, /applyOccurrenceClaims/);
assert.match(occurrenceOutbox, /FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT = 'fulfillment_occurrence_deduction_requested'/);

for (const [path, ownerPattern] of [
  ['src/services/labels.ts', /applyOrderLifecycleCommandInTransaction/],
  ['src/services/order-sync.ts', /applyOrderLifecycleCommand/],
  ['src/services/shipment-sync.ts', /applyOrderLifecycleCommandInTransaction/],
  ['src/services/fulfillment/mark-shipped-externally.ts', /applyOrderLifecycleCommand/],
  ['scripts/reconcile-orphan-shipstation-shipments.ts', /upsertNormalizedStoreOrders/],
] as const) {
  const source = read(path);
  assert.match(source, ownerPattern);
  assert.doesNotMatch(source, /await deductInventoryForOrder\(/);
}
assert.doesNotMatch(read('scripts/reconcile-orphan-shipstation-shipments.ts'), /enqueueInventoryDeduction/);
assert.doesNotMatch(read('src/services/labels.ts'), /background\('inventory deduction'/);

// PS-497 Slice 2 Release B (S2.4x): the generic claimer is de-scoped to confirmation-only, so it can never
// claim the quarantined legacy inventory event nor the dedicated occurrence event.
assert.match(fulfillmentOutbox, /WHERE event_type = 'shipment_confirmation_requested'/);
assert.match(fulfillmentOutbox, /processInventoryDeductionOutboxEvent/);
const complete = fulfillmentOutbox.slice(
  fulfillmentOutbox.indexOf('async function settleOutboxRowWithExecutor'),
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
