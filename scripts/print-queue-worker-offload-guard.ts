/**
 * Print Queue worker offload guard.
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
const env = read('src/lib/env.ts');
const printQueue = read('src/services/print-queue.ts');
const printWorkerPath = 'src/services/print-queue-worker.ts';
const printWorker = read(printWorkerPath);
const worker = read('src/worker.ts');

check('package wires the print queue worker offload guard',
  packageJson.includes('"test:print-queue-worker-offload": "tsx scripts/print-queue-worker-offload-guard.ts"'));

check('env enables API enqueue by default and keeps worker consume flag explicit',
  /PRINT_QUEUE_WORKER_ENABLED:\s*booleanFlag\(true\)/.test(env) &&
    /RUN_PRINT_QUEUE_WORKER:\s*booleanFlag\(false\)/.test(env));

check('dedicated print queue worker module exists',
  existsSync(printWorkerPath));

check('worker module owns a pg-boss print queue name and enqueue API',
  /PRINT_QUEUE_SEND_JOB_NAME\s*=\s*'prepship\.print-queue\.batch-send'/.test(printWorker) &&
    /export async function enqueueQueueSendWorkerJob/.test(printWorker) &&
    /export async function startPrintQueueWorker/.test(printWorker) &&
    /export async function stopPrintQueueWorker/.test(printWorker));

check('worker module creates and consumes only the print queue job',
  /createQueue\(PRINT_QUEUE_SEND_JOB_NAME/.test(printWorker) &&
    /boss\.work\(\s*PRINT_QUEUE_SEND_JOB_NAME/.test(printWorker) &&
    /runQueueSendJobFromWorker/.test(printWorker));

check('print queue service delegates queue-send runs to the worker enqueue owner',
  /from '\.\/print-queue-worker'/.test(printQueue) &&
    /env\.PRINT_QUEUE_WORKER_ENABLED/.test(printQueue) &&
    /await enqueueQueueSendWorkerJob/.test(printQueue) &&
    /job will not run in the API process/.test(printQueue) &&
    !/void runQueueSendJob/.test(printQueue));

check('print queue service exports a durable rehydrating worker runner',
  /export async function runQueueSendJobFromWorker/.test(printQueue) &&
    /getQueueSendJobRecord\(payload\.jobId\)/.test(printQueue) &&
    /queueSendJobFromSnapshot/.test(printQueue));

check('worker startup re-enqueues stale active durable jobs with stored payloads',
  /getRecoverableQueueSendJobRecords/.test(printWorker) &&
    /recoverStaleQueueSendJobs/.test(printWorker) &&
    /snapshot\.workerOrders/.test(printWorker) &&
    /Queue job interrupted before a durable worker payload was available/.test(printWorker));

check('unsafe per-order timeout race stays out of label purchase path',
  !/Promise\.race\(\[\s*processQueueSendOrder/.test(printQueue) &&
    !/function timeoutAfter/.test(printQueue));

check('render worker starts print queue worker independently of sync scheduler',
  /startPrintQueueWorker/.test(worker) &&
    /stopPrintQueueWorker/.test(worker) &&
    /env\.RUN_PRINT_QUEUE_WORKER/.test(worker) &&
    /worker is idle/.test(worker));

if (failures > 0) {
  console.error(`\nFAIL print queue worker offload guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS print queue worker offload guard');
