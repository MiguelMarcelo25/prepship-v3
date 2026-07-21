/**
 * PS-359 ShipStation sync busy-defer guard.
 *
 * Root cause: order sync and shipment sync correctly share the ShipStation
 * lane, but a shipment tick blocked behind order sync was being completed as
 * "skipped". Under a busy backlog that can starve shipment_sync.last_created_ms
 * while order_sync.last_modified_ms keeps advancing.
 *
 * This guard pins the queue-owner behavior: order/shipment import jobs and the
 * fulfillment control-plane wake-up get a durable deferred retry when the
 * shared lane is busy. Deferral itself must never execute a provider handler.
 */
import { readFileSync } from 'node:fs';

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

const queue = read('src/services/sync-job-queue.ts');
const laneLock = read('src/services/sync-lane-lock.ts');
const pkg = read('package.json');
const deferSet = queue.match(/const BUSY_DEFER_JOB_NAMES = new Set<JobName>\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
const skipBlock =
  queue.match(/if \(blockedBy\) \{([\s\S]*?)activeJobsByLane\.set\(lane, name\);/)?.[1] ?? '';
const deferFunction = queue.slice(
  queue.indexOf('async function deferBusySyncJob'),
  queue.indexOf('async function reconcileDurableSchedule'),
);

check('queue defines a short busy-defer delay', /const BUSY_DEFER_SECONDS = 60;/.test(queue));
check('busy-defer set includes order sync', /JOBS\.orders/.test(deferSet));
check('busy-defer set includes shipment sync', /JOBS\.shipments/.test(deferSet));
check('busy-defer set includes fulfillment outbox control-plane recovery', /JOBS\.fulfillmentOutbox/.test(deferSet));
check('busy-defer set excludes external shipped classifier mutations', !/JOBS\.externalShippedClassifier/.test(deferSet));
check('busy-defer set excludes walmart fees sync', !/JOBS\.walmartFees/.test(deferSet));
check('busy-defer uses pg-boss sendAfter for durable retry', /await boss\.sendAfter\(/.test(queue));
check('busy-defer delegates singleton keys to the canonical admission owner',
  /resolveSyncJobAdmission\(name, \{[\s\S]*kind: 'busy-defer',[\s\S]*recoveryPriority,[\s\S]*singletonKey: admission\.singletonKey/.test(queue));
check('fulfillment deferral schedules only and never calls its provider-capable handler',
  /fulfillmentOutboxRecovery/.test(deferFunction) &&
    /boss\.sendAfter/.test(deferFunction) &&
    !/runFulfillmentOutboxTick|processFulfillmentOutboxOnce|confirmShipment/.test(deferFunction));
check('blocked queue jobs call deferBusySyncJob before returning skipped',
  /deferBusySyncJob\(\s*name,\s*blockedBy,\s*lane,\s*busyDeferCount\(job\?\.data\),\s*job\?\.data,?\s*\)/.test(skipBlock));
check('blocked queue return exposes deferred status', /deferred:\s*Boolean\(deferredJobId\)/.test(skipBlock));
check(
  'cross-process ShipStation lane lock module exists',
  /export async function withSyncLaneAdvisoryLock/.test(laneLock) &&
    /pg_try_advisory_xact_lock/.test(laneLock) &&
    /idle_in_transaction_session_timeout: SYNC_LANE_IDLE_TRANSACTION_TIMEOUT_MS/.test(laneLock) &&
    !/pg_advisory_unlock/.test(laneLock),
);
check(
  'cross-process lane lock uses a dedicated DB client so heartbeats are not starved',
  /import postgres from 'postgres';/.test(laneLock) &&
    /const laneLockSql = postgres\(env\.DATABASE_URL/.test(laneLock) &&
    !/from ['"]\.\.\/db\/client['"]/.test(laneLock),
);
check(
  'cross-process ShipStation lane lock is transaction-scoped for Supavisor restarts',
  /return laneLockSql\.begin\(async \(tx\) => \{[\s\S]*pg_try_advisory_xact_lock/.test(laneLock),
);
check(
  'worker acquires DB lane lock before marking local lane active',
  /withSyncLaneAdvisoryLock\(lane,\s*async\s*\(\)\s*=>\s*\{[\s\S]*?activeJobsByLane\.set\(lane, name\);/.test(queue),
);
check(
  'pg-boss order and shipment workers call canonical sync services directly',
    /import \{ syncOrders \} from '\.\/order-sync';/.test(queue) &&
    /import \{ syncShipments \} from '\.\/shipment-sync';/.test(queue) &&
    /registerWorker\(JOBS\.orders,\s*\(jobData, \{ identity, signal \}\) =>[\s\S]*runOrderSyncWithOutboxPriority\(jobData, identity, signal\)/.test(queue) &&
    /runOrderSyncWithOutboxPriority[\s\S]*orderSyncOptionsFromJobPayload\(jobData\)[\s\S]*syncOrders\(\{ \.\.\.options, runIdentity: identity, signal: workSignal \}\)/.test(queue) &&
    /registerWorker\(JOBS\.shipments,\s*\(jobData, \{ signal \}\) =>[\s\S]*runShipmentSyncWithOrderPriority\(jobData, signal\)/.test(queue) &&
    /runShipmentSyncWithOrderPriority[\s\S]*syncShipments\(\{[\s\S]*shipmentSyncOptionsFromJobPayload\(jobData\)[\s\S]*signal: workSignal/.test(queue) &&
    !/runOrderSync\(/.test(queue) &&
    !/runShipmentSync\(/.test(queue),
);
check(
  'cross-process lane lock miss defers shared-lane recovery instead of running concurrently',
  /lane_lock_held/.test(queue) && /deferBusySyncJob\(\s*name,\s*blockedBy,\s*lane,\s*busyDeferCount\(job\?\.data\),\s*job\?\.data,?\s*\)/.test(queue),
);
check(
  'outbox deferral fails closed when no durable replacement is created',
  /assertDurableBusyDeferral\(name, deferredJobId\)/.test(queue) &&
    /durable fulfillment-outbox deferral failed; retrying original queue job/.test(queue),
);
check('busy-defer comment records the shipped-data override and safety boundary', /unlock shipped data on 2026-07-01/.test(queue));
check(
  'package.json wires test:ps-359-shipment-sync-busy-defer',
  /"test:ps-359-shipment-sync-busy-defer"\s*:\s*"tsx scripts\/ps-359-shipment-sync-busy-defer-guard\.ts"/.test(pkg),
);

if (failures > 0) {
  console.error(`\nFAIL PS-359 shipment sync busy-defer guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-359 shipment sync busy-defer guard');
