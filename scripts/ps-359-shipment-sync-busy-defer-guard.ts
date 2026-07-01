/**
 * PS-359 ShipStation sync busy-defer guard.
 *
 * Root cause: order sync and shipment sync correctly share the ShipStation
 * lane, but a shipment tick blocked behind order sync was being completed as
 * "skipped". Under a busy backlog that can starve shipment_sync.last_created_ms
 * while order_sync.last_modified_ms keeps advancing.
 *
 * This guard pins the queue-owner behavior: only order/shipment import jobs get
 * a durable one-minute deferred retry when the ShipStation lane is busy. Side
 * effect queues stay excluded.
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
const pkg = read('package.json');
const deferSet = queue.match(/const BUSY_DEFER_JOB_NAMES = new Set<JobName>\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
const skipBlock =
  queue.match(/if \(blockedBy\) \{([\s\S]*?)activeJobsByLane\.set\(lane, name\);/)?.[1] ?? '';

check('queue defines a short busy-defer delay', /const BUSY_DEFER_SECONDS = 60;/.test(queue));
check('busy-defer set includes order sync', /JOBS\.orders/.test(deferSet));
check('busy-defer set includes shipment sync', /JOBS\.shipments/.test(deferSet));
check('busy-defer set excludes fulfillment outbox side effects', !/JOBS\.fulfillmentOutbox/.test(deferSet));
check('busy-defer set excludes external shipped classifier mutations', !/JOBS\.externalShippedClassifier/.test(deferSet));
check('busy-defer set excludes walmart fees sync', !/JOBS\.walmartFees/.test(deferSet));
check('busy-defer uses pg-boss sendAfter for durable retry', /await boss\.sendAfter\(/.test(queue));
check('busy-defer uses its own singleton key to prevent pileups', /singletonKey:\s*'busy-defer'/.test(queue));
check('blocked queue jobs call deferBusySyncJob before returning skipped', /deferBusySyncJob\(name, blockedBy, lane\)/.test(skipBlock));
check('blocked queue return exposes deferred status', /deferred:\s*Boolean\(deferredJobId\)/.test(skipBlock));
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
