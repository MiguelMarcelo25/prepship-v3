/**
 * PS-346 shipped-label sync starvation guard.
 *
 * Root cause: a single backend worker mutex let a long shipments sync block every
 * other scheduled job, including the external-shipped classifier, tracking poll,
 * and reporting refresh. Shipped rows then displayed "Shipment sync error"
 * because the shipment/label read model could not catch up.
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
  'external-shipped classifier is not starved by active shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, classifierJob) === null
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
  'rate backfill has its own lane and is not blocked by shipment sync',
  getSyncJobLaneBlocker(activeShipmentSync, rateBackfillJob) === null
);

const schedulerActive = new Map([[syncJobLaneFor('shipments sync'), 'shipments sync']]);
check(
  'scheduler display names use the same non-starving lane policy',
  getSyncJobLaneBlocker(schedulerActive, 'external-shipped classifier') === null
);
check(
  'scheduler still serializes orders sync behind shipments sync',
  getSyncJobLaneBlocker(schedulerActive, 'orders sync') === 'shipments sync'
);

const queue = read('src/services/sync-job-queue.ts');
check(
  'pg-boss worker uses per-lane active jobs instead of one global activeJobName',
  /activeJobsByLane/.test(queue) && !/let activeJobName/.test(queue)
);
check(
  'pg-boss worker skips duplicate active job enqueues before creating more backlog',
  /isSyncJobNameActive\(activeJobsByLane, name\)/.test(queue)
);

const scheduler = read('src/services/sync-scheduler.ts');
check(
  'scheduler uses per-lane active jobs instead of one global heavySchedulerJobRunning',
  /activeSchedulerJobsByLane/.test(scheduler) && !/let heavySchedulerJobRunning/.test(scheduler)
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
