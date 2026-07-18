import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const migration = read('drizzle/0067_durable_worker_execution_fences.sql');
const rateWorkflow = read('src/services/rate-browse-workflow.ts');
const rateStore = read('src/services/rate-browse-job-store.ts');
const rateWorker = read('src/services/rate-browse-worker.ts');
const ratesRoute = read('src/routes/rates.ts');
const printService = read('src/services/print-queue.ts');
const printStore = read('src/services/print-queue/merge-job-store.ts');
const printWorker = read('src/services/print-queue-worker.ts');
const pdfStore = read('src/services/print-queue-pdf-store.ts');
const reaper = read('src/services/sync-stuck-job-reaper.ts');
const syncQueue = read('src/services/sync-job-queue.ts');
const worker = read('src/worker.ts');

assert.ok(!existsSync('src/services/rate-browse-job-scheduler.ts'));
assert.doesNotMatch(rateWorkflow, /queueMicrotask|scheduleDetachedRateBrowseJob/);
assert.match(rateWorkflow, /await enqueueRateBrowseWorkerJob\(reservation\.snapshot\.jobId\)/);
assert.match(rateWorkflow, /workerInput:\s*\{/);
assert.doesNotMatch(ratesRoute, /getInitialResult:|run:\s*\(\)\s*=>\s*produceRateBrowsePayload/);

assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS rate_browse_jobs_request_active_unq/);
assert.match(migration, /WHERE active = true AND request_key IS NOT NULL/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0/g);
assert.match(migration, /ADD COLUMN IF NOT EXISTS input_payload jsonb/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS request_payload jsonb/);
assert.doesNotMatch(migration, /(?:UPDATE|DELETE\s+FROM)\s+(?:orders|shipments)\b/i);

for (const source of [rateStore, printStore]) {
  assert.match(source, /generation = generation \+ 1/);
  assert.match(source, /heartbeat_at =/);
  assert.match(source, /cancel_requested_at/);
  assert.match(source, /cancel_acknowledged_at/);
}
assert.match(rateStore, /WHERE rate_browse_jobs\.generation = \$\{snapshot\.generation\}/);
assert.match(printStore, /WHERE print_queue_merge_jobs\.generation = \$\{snapshot\.generation\}/);
assert.match(rateWorker, /runDurableWorkerAttempt/);
assert.match(rateWorker, /produceRateBrowsePayload/);
assert.match(rateWorker, /listRecoverableRateBrowseJobIds/);
assert.match(worker, /await startRateBrowseWorker\(\)/);

const startPrint = printService.slice(
  printService.indexOf('export async function startPrintJob'),
  printService.indexOf('export function getMergeJobStatus'),
);
assert.match(startPrint, /await enqueuePrintMergeWorkerJob\(jobId\)/);
assert.doesNotMatch(startPrint, /runMergeJob\(/);
assert.doesNotMatch(startPrint, /mergeJobs\.set/);
assert.match(printWorker, /PRINT_QUEUE_MERGE_JOB_NAME/);
assert.match(printWorker, /claimPrintMergeJobRecord/);
assert.match(printWorker, /runPrintMergeJobFromWorker/);
assert.match(printWorker, /recoverStalePrintMergeJobs/);
assert.match(printWorker, /error instanceof DeadlineExceededError[\s\S]{0,500}await handlerPromise\.catch/);
assert.match(printService, /const storedChunks = await getMergedPdfChunks\(jobId\)/);
assert.match(printService, /delete context\.chunk\.mergedPdfBase64/);
assert.match(pdfStore, /WHERE print_queue_pdf_chunks\.generation <= \$\{input\.generation\}/);
assert.match(pdfStore, /FROM print_queue_merge_jobs[\s\S]{0,180}generation = \$\{input\.generation\}[\s\S]{0,80}active = true/);
assert.match(pdfStore, /return true/);
assert.doesNotMatch(pdfStore, /if \(!durablePrintQueuePdfEnabled\(\)\)/);

assert.match(reaper, /REAPER_MIN_ACTIVE_AGE_MS = SYNC_JOB_RUNNING_LEASE_MS/);
assert.match(reaper, /if \(laneIsHeld && !pastAgeThreshold\) continue/);
assert.match(
  syncQueue,
  /err instanceof DeadlineExceededError[\s\S]{0,1400}requireCancellationAcknowledgement\(\{[\s\S]*work: handlerPromise[\s\S]*terminateWorkerForUnacknowledgedCancellation/,
);

console.log('PASS PS-428 durable worker execution static guard');
