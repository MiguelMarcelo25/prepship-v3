/**
 * PS-351 - durable Print Queue preflight/batch job owner.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

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

const packageJson = read('package.json');
const printQueue = read('src/services/print-queue.ts');
const route = read('src/routes/print-queue.ts');
const jobStorePath = 'src/services/print-queue/queue-send-job-store.ts';
const preflightPath = 'src/services/print-queue/queue-send-preflight.ts';
const snapshotPath = 'src/services/print-queue/queue-send-snapshot.ts';
const jobStore = read(jobStorePath);
const preflight = read(preflightPath);
const snapshot = read(snapshotPath);
const runtimeSchemaMigration = read('drizzle/0062_runtime_schema_ownership.sql');
const doc = read('docs/ps-tickets/ps-351-durable-print-queue-jobs.md');
const ps352Doc = read('docs/ps-tickets/ps-352-shipping-workflow-sot-map.md');

check('PS-351 package guard is wired',
  packageJson.includes('"test:ps-351-durable-print-queue-jobs": "tsx scripts/ps-351-durable-print-queue-jobs-guard.ts"'));

check('dedicated queue-send job store module exists',
  existsSync(jobStorePath));

check('dedicated backend preflight module exists',
  existsSync(preflightPath));

check('migration owns queue-send schema and job store verifies readiness',
  /CREATE TABLE IF NOT EXISTS print_queue_send_jobs/.test(runtimeSchemaMigration) &&
    /job_id text PRIMARY KEY/.test(runtimeSchemaMigration) &&
    /job_type text NOT NULL DEFAULT 'batch_send'/.test(runtimeSchemaMigration) &&
    /snapshot jsonb NOT NULL/.test(runtimeSchemaMigration) &&
    /CREATE INDEX IF NOT EXISTS print_queue_send_jobs_updated_at_idx/.test(runtimeSchemaMigration) &&
    /ensureQueueSendJobStoreSchema/.test(jobStore) && /assertRuntimeSchemaReady/.test(jobStore));

check('job store owns durable per-order item states, not just batch snapshots',
  /CREATE TABLE IF NOT EXISTS print_queue_batch_job_items/.test(runtimeSchemaMigration) &&
    /job_id text NOT NULL/.test(runtimeSchemaMigration) &&
    /order_id integer NOT NULL/.test(runtimeSchemaMigration) &&
    /state text NOT NULL/.test(runtimeSchemaMigration) &&
    /blocked_reason text/.test(runtimeSchemaMigration) &&
    /error_message text/.test(runtimeSchemaMigration) &&
    /UNIQUE \(job_id, order_id\)/.test(runtimeSchemaMigration) &&
    /print_queue_batch_job_items_job_idx/.test(runtimeSchemaMigration));

check('job store persists and reads per-job snapshots without using the settings blob',
  /export async function persistQueueSendJobRecord/.test(jobStore) &&
    /export async function getQueueSendJobRecord/.test(jobStore) &&
    /export async function getLatestQueueSendJobRecord/.test(jobStore) &&
    !/settings/.test(jobStore) &&
    !/PRINT_QUEUE_SEND_STATUS_KEY/.test(jobStore));

check('job store exposes item-state persistence APIs',
  /export async function persistQueueSendJobItems/.test(jobStore) &&
    /export async function updateQueueSendJobItemState/.test(jobStore) &&
    /export async function getQueueSendJobItemRecords/.test(jobStore));

check('preflight classifies ready and blocked orders before label purchase',
  /export async function preflightQueueSendOrders/.test(preflight) &&
    /QueueSendPreflightBlockReason/.test(preflight) &&
    /missing_rate_proof/.test(preflight) &&
    /order_not_editable/.test(preflight) &&
    /missing_weight/.test(preflight) &&
    /missing_package/.test(preflight) &&
    /missing_address/.test(preflight) &&
    /carrier_provider_unavailable/.test(preflight) &&
    /assertLabelPurchaseRateSelection/.test(preflight) &&
    /readyOrders/.test(preflight) &&
    /blockedResults/.test(preflight));

check('print queue service imports the dedicated job store owner',
  /from '\.\/print-queue\/queue-send-job-store'/.test(printQueue) &&
    /persistQueueSendJobRecord/.test(printQueue) &&
    /getQueueSendJobRecord/.test(printQueue) &&
    /getLatestQueueSendJobRecord/.test(printQueue) &&
    /persistQueueSendJobItems/.test(printQueue) &&
    /updateQueueSendJobItemState/.test(printQueue));

check('print queue service runs backend preflight before starting purchases',
  /from '\.\/print-queue\/queue-send-preflight'/.test(printQueue) &&
    /preflightQueueSendOrders/.test(printQueue) &&
    /const preflight = orders\.length > 0[\s\S]{0,120}await preflightQueueSendOrders\(orders\)/.test(printQueue) &&
    /readyOrders/.test(printQueue) &&
    /blockedResults/.test(printQueue) &&
    /persistQueueSendJobItems/.test(printQueue));

check('initial queue-send job requires the durable job store before returning a job id',
  /await persistQueueSendJobSnapshot\(job, \{ required: true \}\);/.test(printQueue) &&
    /await persistQueueSendJobRecord\(snapshot\);/.test(printQueue) &&
    /if \(options\.required\) \{[\s\S]{0,160}throw new PrintQueueDurableStatusError/.test(printQueue));

check('settings status blob is retained only as legacy fallback after the canonical job store write',
  /persistLegacyQueueSendSettingsSnapshot/.test(printQueue) &&
    /await persistQueueSendJobRecord\(snapshot\);[\s\S]{0,900}await persistLegacyQueueSendSettingsSnapshot\(snapshot\);/.test(printQueue) &&
    /const durableJob = await getQueueSendJobRecord\(jobId\);[\s\S]{0,240}if \(durableJob\) return (?:durableJob|withFreshQueueSendItemStates\(durableJob\));/.test(printQueue) &&
    /const durableJob = await getLatestQueueSendJobRecord\(\);[\s\S]{0,240}if \(durableJob\) return (?:durableJob|withFreshQueueSendItemStates\(durableJob\));/.test(printQueue));

check('batch-send status route still reads by requested job id before latest fallback',
  /getQueueSendJobSnapshot\(jobId\)[\s\S]{0,120}getLatestQueueSendJobSnapshot/.test(route) &&
    /durableJob\?\.jobId === jobId/.test(route) &&
    /item_states/.test(route));

check('snapshots retain durable per-order item states for cheap status polling',
  /itemStates/.test(snapshot) &&
    /toQueueSendItemSnapshot/.test(snapshot) &&
    /QueueSendItemSnapshot/.test(snapshot));

check('unsafe non-cancelling label-purchase timeout race is removed',
  !/Promise\.race\(\[\s*processQueueSendOrder/.test(printQueue) &&
    !/function timeoutAfter/.test(printQueue) &&
    /provider_pending_recovery/.test(printQueue) &&
    /QUEUE_SEND_PROVIDER_PENDING_AFTER_MS/.test(printQueue));

check('PS-351 doc records backend owner, imperfect data injection, and safety boundary',
  doc.includes('Backend Owner') &&
    doc.includes('Imperfect Data Injection') &&
    doc.includes('Bulk Preflight') &&
    doc.includes('provider_pending_recovery') &&
    doc.includes('settings blob is legacy fallback') &&
    doc.includes('No labels, postage, provider calls, queue mutation, billing, inventory, or shipped/cancelled mutation'));

check('PS-352 map can point PS-351 to durable job-store evidence',
  ps352Doc.includes('PS-351 durable queue-send job store') &&
    ps352Doc.includes('print_queue_send_jobs') &&
    ps352Doc.includes('print_queue_batch_job_items'));

if (failures > 0) {
  console.error(`\nFAIL PS-351 durable print queue jobs guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-351 durable print queue jobs guard');
