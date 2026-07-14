import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const serviceSource = read('src/services/print-queue.ts');
const routeSource = read('src/routes/print-queue.ts');
const snapshotSource = read('src/services/print-queue/queue-send-snapshot.ts');
const jobStoreSource = read('src/services/print-queue/queue-send-job-store.ts');
const mergeJobStoreSource = read('src/services/print-queue/merge-job-store.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  serviceSource.includes("import { settings } from '../db/schema/settings'"),
  'print queue imports settings table',
);

assert(
  snapshotSource.includes("PRINT_QUEUE_SEND_STATUS_KEY = 'print_queue.batch_send.last_run'") &&
    serviceSource.includes("} from './print-queue/queue-send-snapshot'"),
  'print queue batch-send uses durable settings key',
);

assert(
  serviceSource.includes("PRINT_QUEUE_MERGE_STATUS_KEY = 'print_queue.pdf_merge.last_run'"),
  'print queue retains the legacy latest-merge compatibility key',
);

assert(
  serviceSource.includes('persistQueueSendJobSnapshot'),
  'print queue persists batch-send job snapshots',
);
assert(
  jobStoreSource.includes('WHERE print_queue_send_jobs.updated_at <= ${snapshot.updatedAt}'),
  'durable batch-send job snapshots cannot be overwritten by older progress writes',
);
assert(
  snapshotSource.includes("PRINT_QUEUE_SEND_JOB_STATUS_PREFIX = 'print_queue.batch_send.job.'") &&
    snapshotSource.includes('queueSendJobStatusKey(jobId: string)') &&
    serviceSource.includes('getQueueSendJobSnapshot'),
  'print queue persists readable per-job batch-send snapshots',
);
assert(
  snapshotSource.includes('results: QueueSendResultSnapshot[]') &&
    snapshotSource.includes('const results = job.results.map(toQueueSendResultSnapshot)') &&
    snapshotSource.includes('results,') &&
    snapshotSource.includes('resultSamples: results.slice(-10)'),
  'print queue durable snapshots preserve full results plus compact samples',
);
assert(
  serviceSource.includes('PrintQueueDurableStatusError') &&
    serviceSource.includes('options: { required?: boolean }') &&
    serviceSource.includes('persistQueueSendJobSnapshot(job, { required: true })'),
  'print queue requires the initial durable batch-send snapshot before returning a job id',
);

assert(
  serviceSource.includes('persistMergeJobSnapshot'),
  'print queue persists PDF-merge job snapshots',
);
assert(
  mergeJobStoreSource.includes('INSERT INTO print_queue_merge_jobs') &&
    mergeJobStoreSource.includes('WHERE print_queue_merge_jobs.updated_at <= ${snapshot.persistedAt}'),
  'PDF-merge snapshots persist per job and reject older racing writes',
);
assert(
  serviceSource.includes('getMergeJobSnapshot') &&
    routeSource.includes('getMergeJobSnapshot(jobId)'),
  'PDF-merge status reads the requested durable job instead of the last-run singleton',
);
assert(
  serviceSource.includes('persistMergeJobSnapshot(job, { required: true })'),
  'PDF-merge requires initial and terminal durable snapshots',
);

assert(
  serviceSource.includes('getLatestQueueSendJobSnapshot'),
  'print queue exposes durable batch-send snapshot reader',
);

assert(
  serviceSource.includes('getLatestMergeJobSnapshot'),
  'print queue exposes durable PDF-merge snapshot reader',
);

assert(
  routeSource.includes('getLatestQueueSendJobSnapshot'),
  'print queue route imports durable batch-send snapshot reader',
);
assert(
  routeSource.includes('getQueueSendJobSnapshot') &&
    routeSource.includes('await startQueueSendJob') &&
    routeSource.includes('getQueueSendJobSnapshot(jobId)'),
  'print queue route awaits job snapshot before polling and reads status by job id',
);
assert(
  routeSource.includes('isPrintQueueDurableStatusError') &&
    serviceSource.includes('PRINT_QUEUE_STATUS_UNAVAILABLE'),
  'print queue route returns readable status-unavailable errors',
);

assert(
  routeSource.includes('getLatestMergeJobSnapshot'),
  'print queue route imports latest durable PDF-merge reader for refresh recovery',
);

assert(
  routeSource.includes('durableJob: durableJob?.jobId === job.jobId ? durableJob : null'),
  'print queue status responses scope durable snapshots to the requested job',
);

assert(
  routeSource.includes('DURABLE_STATUS_TIMEOUT_MS') &&
    routeSource.includes('withDurableStatusTimeout') &&
    routeSource.includes('Promise.race'),
  'print queue status routes must bound durable snapshot reads so polling cannot hang',
);

assert(
  routeSource.includes('durableJob?.jobId === jobId') &&
    routeSource.includes('deriveQueueSendSnapshotStatus') &&
    routeSource.includes('status: durableStatus.status') &&
    routeSource.includes('stale_reason: durableStatus.staleReason') &&
    routeSource.includes('const durableResults = queueSendSnapshotResults(durableJob)') &&
    routeSource.includes('results: durableResults') &&
    routeSource.includes('result_samples: durableJob.resultSamples'),
  'batch-send status route must derive safe durable status and return full durable results when the in-memory job is gone',
);

assert(
  packageJson.scripts?.['test:print-queue-durable'] ===
    'node scripts/print-queue-durable-guard.mjs',
  'package exposes print queue durable guard',
);
assert(
  packageJson.scripts?.['test:ps-346-print-queue-durable-full-results'] ===
    'tsx scripts/ps-346-print-queue-durable-full-results-guard.ts',
  'package exposes PS-346 full durable queue result guard',
);
