import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MERGE_JOB_DURABLE_INTERRUPTED_AFTER_MS,
  deriveMergeJobSnapshotStatus,
  MERGE_JOB_DURABLE_STALE_AFTER_MS,
} from '../src/services/print-queue/merge-job-status.js';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, fn: () => void): void {
  fn();
  console.log(`ok   ${name}`);
}

const baseSnapshot = {
  status: 'running',
  message: 'Merging labels...',
  errorMessage: null,
  persistedAt: '2026-07-14T00:00:00.000Z',
};

check('missing heartbeat derives stale visibility within the recovery window', () => {
  const result = deriveMergeJobSnapshotStatus(baseSnapshot, {
    now: Date.parse(baseSnapshot.persistedAt) + MERGE_JOB_DURABLE_STALE_AFTER_MS + 1,
    inMemoryJobPresent: false,
  });
  assert.equal(result.status, 'running');
  assert.equal(result.active, true);
  assert.equal(result.staleReason, 'worker_heartbeat_stale');
  assert.match(result.message, /interrupted|stale/i);
});

check('missing worker beyond the generation lease derives a terminal error', () => {
  const result = deriveMergeJobSnapshotStatus(baseSnapshot, {
    now: Date.parse(baseSnapshot.persistedAt) + MERGE_JOB_DURABLE_INTERRUPTED_AFTER_MS + 1,
    inMemoryJobPresent: false,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.active, false);
  assert.equal(result.staleReason, 'worker_missing_stale_snapshot');
  assert.match(result.message, /interrupted|stale/i);
});

check('recent active snapshot remains running', () => {
  const result = deriveMergeJobSnapshotStatus(baseSnapshot, {
    now: Date.parse(baseSnapshot.persistedAt) + MERGE_JOB_DURABLE_STALE_AFTER_MS - 1,
    inMemoryJobPresent: false,
  });
  assert.equal(result.status, 'running');
  assert.equal(result.active, true);
  assert.equal(result.staleReason, null);
});

check('terminal done snapshot is never reclassified stale', () => {
  const result = deriveMergeJobSnapshotStatus(
    { ...baseSnapshot, status: 'done' },
    {
      now: Date.parse(baseSnapshot.persistedAt) + MERGE_JOB_DURABLE_INTERRUPTED_AFTER_MS * 10,
      inMemoryJobPresent: false,
    },
  );
  assert.equal(result.status, 'done');
  assert.equal(result.staleReason, null);
});

const migration = read('drizzle/0064_print_queue_merge_jobs.sql');
const fenceMigration = read('drizzle/0067_durable_worker_execution_fences.sql');
const store = read('src/services/print-queue/merge-job-store.ts');
const service = read('src/services/print-queue.ts');
const worker = read('src/services/print-queue-worker.ts');
const route = read('src/routes/print-queue.ts');
const readiness = read('src/services/runtime-schema-readiness.ts');
const pdfStore = read('src/services/print-queue-pdf-store.ts');
const workerDeadline = read('src/lib/print-queue-worker-deadline.ts');
const env = read('src/lib/env.ts');

check('migration owns per-job merge snapshots and their lookup index', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS print_queue_merge_jobs/);
  assert.match(migration, /job_id text PRIMARY KEY/);
  assert.match(migration, /snapshot jsonb NOT NULL/);
  assert.match(migration, /print_queue_merge_jobs_updated_at_idx/);
  assert.match(migration, /ALTER TABLE print_queue_merge_jobs ENABLE ROW LEVEL SECURITY/);
});

check('migration never mutates protected order or shipment data', () => {
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE\s+FROM)\s+(?:orders|shipments)\b/i);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+(?:orders|shipments)\b/i);
});

check('merge store persists and reads snapshots by job id with monotonic writes', () => {
  assert.match(store, /export async function persistMergeJobRecord/);
  assert.match(store, /ON CONFLICT \(job_id\) DO UPDATE/);
  assert.match(store, /AND print_queue_merge_jobs\.snapshot_updated_at <= \$\{snapshot\.persistedAt\}/);
  assert.match(store, /export async function getMergeJobRecord\(jobId: string\)/);
  assert.match(store, /WHERE job_id = \$\{jobId\}/);
  assert.match(store, /export async function getLatestMergeJobRecord/);
});

check('boot readiness keeps worker-fence objects at the latest migration frontier', () => {
  assert.match(readiness, /'print_queue_merge_jobs'/);
  assert.match(readiness, /'print_queue_merge_jobs_updated_at_idx'/);
  assert.match(
    readiness,
    /0074_billing_current_period_adjustments\.sql/,
    'readiness reports the latest additive migration while retaining earlier schema requirements',
  );
  assert.match(readiness, /0075_inventory_quantity_sot\.sql/);
  assert.match(fenceMigration, /input_payload jsonb/);
  assert.match(fenceMigration, /generation integer/);
  assert.match(fenceMigration, /print_queue_merge_jobs_recovery_idx/);
});

check('merge lifecycle requires initial status persistence before returning a job id', () => {
  const startBlock = service.slice(service.indexOf('export async function startPrintJob'), service.indexOf('export function getMergeJobStatus'));
  assert.match(startBlock, /await persistMergeJobSnapshot\(job, \{[\s\S]{0,120}required: true/);
  assert.ok(startBlock.indexOf('await persistMergeJobSnapshot') < startBlock.indexOf('await enqueuePrintMergeWorkerJob'));
  assert.doesNotMatch(startBlock, /runMergeJob\(/);
  assert.match(worker, /claimPrintMergeJobRecord/);
  assert.match(worker, /runPrintMergeJobFromWorker/);
});

check('chunk artifacts and terminal merge state are awaited', () => {
  assert.doesNotMatch(service, /void persistMergedPdfChunk/);
  assert.doesNotMatch(service, /void persistMergedPdf\(/);
  assert.match(service, /const durableChunk = await persistMergedPdfChunk/);
  assert.match(service, /if \(!durableChunk\)/);
  const terminalBlock = service.slice(service.indexOf('const doneMessage ='), service.indexOf('} catch (err)', service.indexOf('const doneMessage =')));
  assert.doesNotMatch(terminalBlock, /persistMergedPdf\(/);
  assert.match(terminalBlock, /await persistMergeJobSnapshot\(job, \{ required: true \}\)/);
  assert.match(pdfStore, /WHERE print_queue_pdf_chunks\.generation <= \$\{input\.generation\}/);
});

check('status route reads the requested job and derives staleness in the backend', () => {
  assert.match(route, /getMergeJobSnapshot\(jobId\)/);
  assert.match(route, /deriveMergeJobSnapshotStatus\(durableJob/);
  assert.match(route, /stale_reason: durableStatus\.staleReason/);
  assert.match(route, /Per user override unlock shipped data on 2026-07-14/);
  assert.match(workerDeadline, /PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS = 60_000/);
  assert.match(worker, /PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS/);
  assert.match(env, /DURABLE_PRINT_QUEUE_PDF: booleanFlag\(true\)/);
});

check('durable PDF chunks are mandatory for worker-owned merge completion', () => {
  assert.match(pdfStore, /durablePrintQueuePdfEnabled\(\): boolean \{\s*return true/);
  assert.doesNotMatch(pdfStore, /if \(!durablePrintQueuePdfEnabled\(\)\)/);
});

console.log('\nPASS Audit 3.5 print-queue merge durability guard');
