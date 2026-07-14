/**
 * PS-346 shipped-label sync starvation guard.
 *
 * Root cause: unrestricted lane overlap saturated the shared Supabase client,
 * while one global mutex previously starved unrelated tracking/reporting work.
 * Database-heavy mutation workflows are serialized together; independent
 * tracking and reporting lanes must continue to run.
 */
import { readFileSync } from 'node:fs';
import {
  getSyncJobLaneBlocker,
  isSyncJobNameActive,
  syncJobLaneFor,
} from '../src/services/sync-job-lanes';

let failures = 0;

function check(name: string, condition: boolean) {
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

const ordersJob = 'prepship.sync.orders';
const shipmentsJob = 'prepship.sync.shipments';
const classifierJob = 'prepship.shipping.external-shipped-classifier';
const fulfillmentJob = 'prepship.sync.fulfillment-outbox';
const trackingJob = 'prepship.tracking.poll';
const reportingJob = 'prepship.reporting.refresh';
const rateBackfillJob = 'prepship.sync.rate-backfill';

const shipmentsLane = syncJobLaneFor(shipmentsJob);
const activeShipmentSync = new Map([[shipmentsLane, shipmentsJob]]);

check(
  'orders and shipments remain serialized in the ShipStation sync lane',
  syncJobLaneFor(ordersJob) === syncJobLaneFor(shipmentsJob)
);
check(
  'external-shipped classifier shares the DB-heavy lane with shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, classifierJob) === shipmentsJob
);
check(
  'fulfillment outbox shares the DB-heavy lane with shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, fulfillmentJob) === shipmentsJob
);
check(
  'shipment tracking is not starved by active shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, trackingJob) === null
);
check(
  'reporting refresh is not starved by active shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, reportingJob) === null
);
check(
  'another ShipStation sync job is still blocked by active shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, ordersJob) === shipmentsJob
);
check(
  'duplicate shipment sync enqueue is recognized while shipment sync is active',
  isSyncJobNameActive(activeShipmentSync, shipmentsJob) === true
);
check(
  'rate backfill shares the DB-heavy lane with shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, rateBackfillJob) === shipmentsJob
);

const schedulerActive = new Map([[syncJobLaneFor('shipments sync'), 'shipments sync']]);
check(
  'scheduler display names use the same DB-heavy lane policy',
  getSyncJobLaneBlocker(schedulerActive, 'external-shipped classifier') === 'shipments sync'
);
check(
  'scheduler still serializes orders sync behind shipments sync',
  getSyncJobLaneBlocker(schedulerActive, 'orders sync') === 'shipments sync'
);

const queue = read('src/services/sync-job-queue.ts');
const admission = read('src/services/sync-job-admission.ts');
check(
  'pg-boss worker uses per-lane active jobs instead of one global activeJobName',
  /activeJobsByLane/.test(queue) && !/let activeJobName/.test(queue)
);
check(
  'pg-boss admission prevents duplicate order/shipment backlog across workers',
  /await targetBoss\.updateQueue\(name, options\)/.test(queue) &&
    /policy: syncQueuePolicyForJob\(name\)/.test(queue) &&
    /return name === SHIPSTATION_SYNC_JOBS\.orders \|\| name === SHIPSTATION_SYNC_JOBS\.shipments[\s\S]*\? 'stately'/.test(admission)
);

const scheduler = read('src/services/sync-scheduler.ts');
// Per user override unlock shipped data on 2026-07-14: the durable queue is
// now the only lane-admission owner; scheduler handlers only execute admitted
// work and therefore cannot reserve DB_POOL_MAX=1 behind their own lock.
check(
  'scheduler delegates lane admission to pg-boss instead of owning a second lock',
  /runSchedulerJob/.test(scheduler) &&
    !/activeSchedulerJobsByLane/.test(scheduler) &&
    !/pg\.reserve\(\)|pg_try_advisory_lock/.test(scheduler)
);

const pkg = read('package.json');
check(
  'package.json wires test:ps-346-shipment-sync-worker-lanes',
  /test:ps-346-shipment-sync-worker-lanes/.test(pkg)
);

if (failures > 0) {
  console.error(`\nFAIL PS-346 shipment sync worker lanes guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-346 shipment sync worker lanes guard');
