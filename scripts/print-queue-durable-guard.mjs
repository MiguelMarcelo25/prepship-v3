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
const packageJson = JSON.parse(read('package.json'));

assert(
  serviceSource.includes("import { settings } from '../db/schema/settings'"),
  'print queue imports settings table',
);

assert(
  serviceSource.includes("PRINT_QUEUE_SEND_STATUS_KEY = 'print_queue.batch_send.last_run'"),
  'print queue batch-send uses durable settings key',
);

assert(
  serviceSource.includes("PRINT_QUEUE_MERGE_STATUS_KEY = 'print_queue.pdf_merge.last_run'"),
  'print queue PDF-merge uses durable settings key',
);

assert(
  serviceSource.includes('persistQueueSendJobSnapshot'),
  'print queue persists batch-send job snapshots',
);
assert(
  serviceSource.includes("PRINT_QUEUE_SEND_JOB_STATUS_PREFIX = 'print_queue.batch_send.job.'") &&
    serviceSource.includes('queueSendJobStatusKey(jobId)') &&
    serviceSource.includes('getQueueSendJobSnapshot'),
  'print queue persists readable per-job batch-send snapshots',
);

assert(
  serviceSource.includes('persistMergeJobSnapshot'),
  'print queue persists PDF-merge job snapshots',
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
  routeSource.includes('getLatestMergeJobSnapshot'),
  'print queue route imports durable PDF-merge snapshot reader',
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
    routeSource.includes("status: durableJob.status") &&
    routeSource.includes('results: durableJob.resultSamples'),
  'batch-send status route must fall back to the durable snapshot when the in-memory job is gone',
);

assert(
  packageJson.scripts?.['test:print-queue-durable'] ===
    'node scripts/print-queue-durable-guard.mjs',
  'package exposes print queue durable guard',
);
