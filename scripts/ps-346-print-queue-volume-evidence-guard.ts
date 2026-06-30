/**
 * PS-346 - Print Queue high-volume evidence guard.
 *
 * Offline/static only. This proves the current safe boundary for the queue
 * volume slice without touching locked Print Queue implementation files.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function fileText(path: string): string {
  return existsSync(path) ? read(path) : '';
}

const packageJson = read('package.json');
const plan = read('docs/superpowers/plans/2026-06-29-ps-346-rate-order-slow-paths.md');
const findings = read('docs/ps-tickets/ps-346-rate-order-slow-path-findings.md');
const evidencePath = 'docs/ps-tickets/ps-346-print-queue-volume-evidence.md';
const evidence = fileText(evidencePath);
const printQueueService = read('src/services/print-queue.ts');
const printQueueRoute = read('src/routes/print-queue.ts');
const queueStatus = read('src/services/print-queue/queue-send-status.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const persistentQueueJob = read('web/src/components/Views/orders-persistent-queue-job.ts');

const persistBatchStatusBlock = printQueueService.slice(
  printQueueService.indexOf('export async function persistQueueSendJobSnapshot'),
  printQueueService.indexOf('export async function getQueueSendJobSnapshot'),
);

const routeStatusBlock = printQueueRoute.slice(
  printQueueRoute.indexOf("app.get('/batch-send/status/:jobId'"),
  printQueueRoute.indexOf('// existing /batch-send route above is unchanged'),
);
const createQueueOrderSnapshotBlock = persistentQueueJob.slice(
  persistentQueueJob.indexOf('export function createQueueOrderSnapshot'),
  persistentQueueJob.indexOf('export function readPersistentQueueJob'),
);
const createPersistentQueueJobBlock = persistentQueueJob.slice(
  persistentQueueJob.indexOf('export function createPersistentQueueJob'),
  persistentQueueJob.indexOf('export function yieldToBrowser'),
);

check(
  'package wires PS-346 print queue volume evidence guard',
  packageJson.includes('"test:ps-346-print-queue-volume-evidence": "tsx scripts/ps-346-print-queue-volume-evidence-guard.ts"'),
);

check(
  'PS-346 queue volume evidence doc exists',
  existsSync(evidencePath),
);

check(
  'PS-346 queue volume evidence doc records root cause, current safe proof, and remaining locked blocker',
  evidence.includes('## Root-Cause Findings') &&
    evidence.includes('## Current Safe Proof') &&
    evidence.includes('## Remaining Blocker') &&
    evidence.includes('unlock shipped data'),
);

check(
  'PS-346 queue volume evidence doc defines the selected-count acceptance matrix',
  evidence.includes('Selected 10') &&
    evidence.includes('Selected 20') &&
    evidence.includes('queued + failed = total') &&
    evidence.includes('not cumulative'),
);

check(
  'PS-346 plan keeps Print Queue internals locked without explicit override',
  plan.includes('Do not modify `src/services/print-queue.ts`, `src/routes/print-queue.ts`') &&
    plan.includes('If implementation requires changing Print Queue internals, stop until the user types exactly `unlock shipped data`'),
);

check(
  'batch-send status snapshots use shared JSON settings helper instead of hand-rolled multi-row settings upsert',
  /import \{ setJsonSettings \} from ['"]\.\/settings-json['"]/.test(printQueueService) &&
    /await setJsonSettings\(\[\s*\{\s*key: PRINT_QUEUE_SEND_STATUS_KEY,\s*value: snapshot\s*\},\s*\{\s*key: jobKey,\s*value: snapshot\s*\},\s*\]\)/s.test(persistBatchStatusBlock) &&
    !/\.insert\(settings\)/.test(persistBatchStatusBlock),
);

check(
  'backend active batch-send status returns the full in-memory per-order results for the current run',
  /const job = getQueueSendJobStatus\(jobId\)/.test(routeStatusBlock) &&
    /results: job\.results/.test(routeStatusBlock) &&
    /total: job\.total/.test(routeStatusBlock) &&
    /current: job\.current/.test(routeStatusBlock) &&
    /queued: job\.queued/.test(routeStatusBlock) &&
    /failed: job\.failed/.test(routeStatusBlock),
);

check(
  'durable fallback remains capped and must not be treated as full per-order proof for long batches',
  /resultSamples: job\.results\.slice\(-10\)/.test(printQueueService) &&
    /results: durableJob\.resultSamples/.test(routeStatusBlock) &&
    evidence.includes('durable fallback is capped to the latest 10 result samples'),
);

check(
  'queue-send status derivation clamps stale/current values to the selected run total',
  /const current = total > 0 \? Math\.min\(total, rawCurrent\) : rawCurrent/.test(queueStatus) &&
    /if \(isQueueSendActiveStatus\(status\) && total > 0 && current >= total\)/.test(queueStatus) &&
    /status: 'done'/.test(queueStatus),
);

check(
  'OrdersView polls each backend queue-send job with the selected run total, not a cumulative queue count',
  /pollBackendQueueSendJob\(\s*backendJobId: string,\s*progressTotal: number/.test(ordersView) &&
    /total: progressTotal/.test(ordersView) &&
    /completed: Math\.min\(progressTotal, completedOffset \+ current\)/.test(ordersView) &&
    /pollBackendQueueSendJob\(started\.job_id, Math\.max\(jobOrders\.length, 1\)/.test(ordersView),
);

check(
  'persistent queue job creation resets totals per selected run and stores identifiers only',
  /export function createPersistentQueueJob/.test(persistentQueueJob) &&
    /total: Math\.max\(orders\.length, 1\)/.test(createPersistentQueueJobBlock) &&
    /completedOrderIds: \[\]/.test(createPersistentQueueJobBlock) &&
    /failedOrderIds: \[\]/.test(createPersistentQueueJobBlock) &&
    /orders: orders\.map\(createQueueOrderSnapshot\)/.test(createPersistentQueueJobBlock) &&
    !/bestRate|selectedRate|labelUrl|shipmentCost|otherCost/.test(createQueueOrderSnapshotBlock),
);

check(
  'PS-346 findings doc links the queue-volume evidence slice',
  findings.includes('## 2026-06-30 Print Queue Volume Evidence Slice') &&
    findings.includes('ps-346-print-queue-volume-evidence.md'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-346 print queue volume evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-346 print queue volume evidence guard');
