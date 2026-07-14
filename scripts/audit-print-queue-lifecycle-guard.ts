/**
 * Audit 2026-07-13 PQ-1/PQ-2/PQ-3 print-queue lifecycle guard.
 *
 * Offline only: no DB connection/write, provider call, label/postage purchase,
 * marketplace notification, or production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planQueueSendWorkerChunks,
  QueueSendJobInterruptedError,
  runQueueSendPool,
  runQueueSendSingleFlight,
} from '../src/services/print-queue/queue-send-execution';

const read = (path: string): string => readFileSync(path, 'utf8');
const execution = read('src/services/print-queue/queue-send-execution.ts');
const service = read('src/services/print-queue.ts');
const store = read('src/services/print-queue/queue-send-job-store.ts');
const worker = read('src/services/print-queue-worker.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

const thousand = Array.from({ length: 1_000 }, (_, index) => index + 1);
const chunks = planQueueSendWorkerChunks(thousand);
assert.equal(chunks.length, 10, '1,000 orders must be split into ten worker chunks');
assert.deepEqual(chunks.map((chunk) => chunk.length), Array(10).fill(100));
assert.deepEqual(
  planQueueSendWorkerChunks(thousand.slice(0, 101)).map((chunk) => chunk.length),
  [100, 1],
  'the final chunk must preserve the remainder',
);
assert.deepEqual(planQueueSendWorkerChunks([]), [], 'an empty payload must create no work');

let releaseFirstWave!: () => void;
const firstWave = new Promise<void>((resolve) => {
  releaseFirstWave = resolve;
});
const abortController = new AbortController();
const admitted: number[] = [];
const poolRun = runQueueSendPool(
  [1, 2, 3, 4, 5],
  async (item) => {
    admitted.push(item);
    await firstWave;
  },
  2,
  abortController.signal,
);
await new Promise<void>((resolve) => setImmediate(resolve));
abortController.abort();
releaseFirstWave();
await assert.rejects(poolRun, QueueSendJobInterruptedError);
assert.deepEqual(admitted, [1, 2], 'timeout cancellation must stop new order admission');

let singleFlightCalls = 0;
let releaseSingleFlight!: () => void;
const singleFlightGate = new Promise<void>((resolve) => {
  releaseSingleFlight = resolve;
});
const firstRun = runQueueSendSingleFlight('same-parent-job', async () => {
  singleFlightCalls += 1;
  await singleFlightGate;
  return 'settled';
});
const joinedRun = runQueueSendSingleFlight('same-parent-job', async () => {
  singleFlightCalls += 1;
  return 'unsafe-reentry';
});
releaseSingleFlight();
assert.deepEqual(await Promise.all([firstRun, joinedRun]), ['settled', 'settled']);
assert.equal(singleFlightCalls, 1, 'same-process retry must join the active parent run');
assert.equal(
  await runQueueSendSingleFlight('same-parent-job', async () => {
    singleFlightCalls += 1;
    return 'new-run';
  }),
  'new-run',
  'single-flight state must be released after settlement',
);
assert.equal(singleFlightCalls, 2);

assert.match(store, /export async function claimRecoverableQueueSendJobRecords/,
  'durable store must own atomic recovery claims');
assert.match(store, /FOR UPDATE SKIP LOCKED/,
  'cross-process reapers must not claim the same parent job');
assert.match(store, /snapshot->>'recoveryAttempts'[\s\S]*?\+ 1/,
  'a recovery claim must durably increment its attempt');
assert.match(store, /END < \$\{maxAttempts\}/,
  'recovery claims must enforce the attempt cap');
assert.match(store, /export async function interruptExhaustedQueueSendJobs/,
  'exhausted jobs must become visibly interrupted');
assert.equal((store.match(/'message', \$\{message\}::text/g) ?? []).length, 2,
  'both recovery messages embedded in JSONB must have an explicit PostgreSQL text type');
assert.equal((store.match(/'errorMessage', \$\{message\}::text/g) ?? []).length, 2,
  'both recovery error messages embedded in JSONB must have an explicit PostgreSQL text type');
assert.doesNotMatch(store, /export async function getRecoverableQueueSendJobRecords/,
  'the old non-claiming recovery reader must not remain as a second owner');

assert.match(worker, /PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS = 60_000/,
  'the worker must run recovery periodically');
assert.match(worker, /setInterval\(\(\) =>[\s\S]*?runRecoveryPass/,
  'the periodic reaper must delegate to the guarded recovery pass');
assert.match(worker, /const recovery = await runRecoveryPass\(boss\)/,
  'worker boot must also recover stale jobs');
assert.match(worker, /PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS = 3/,
  'recovery attempts must be capped');
assert.match(worker, /orders: z\.array\(z\.unknown\(\)\)\.min\(1\)\.max\(PRINT_QUEUE_SEND_CHUNK_SIZE\)/,
  'pg-boss payload admission must enforce the chunk size');
assert.match(worker, /singletonKey: queueSendChunkSingletonKey\(payload\)/,
  'chunk/recovery identity must be explicit in pg-boss singleton admission');
assert.match(worker, /onTimeout: \(\) => abortController\.abort\(\)/,
  'the parent deadline must cooperatively cancel new order admission');
assert.ok(
  worker.indexOf('runQueueSendJobFromWorker(payload, { signal: abortController.signal })') <
    worker.indexOf('await enqueueNextQueueSendChunk(boss!, payload)'),
  'the next chunk may be scheduled only after the current chunk succeeds',
);

assert.match(service, /return runQueueSendSingleFlight\(payload\.jobId/,
  'worker retries must use the parent-job re-entry guard');
assert.match(service, /await runQueueSendPool\([\s\S]*?signal/,
  'per-order admission must receive the parent cancellation signal');
assert.match(service, /job\.status = job\.current >= job\.total \? 'done' : 'pending'/,
  'a successful intermediate chunk must leave the parent pending');
assert.match(service, /err instanceof QueueSendJobInterruptedError/,
  'cancelled parents must persist interruption rather than generic failure');
assert.match(execution, /while \(!signal\?\.aborted && running\.size < maxConcurrent/,
  'the execution owner must check cancellation before every new admission');

assert.ok(packageJson.includes('"test:audit-print-queue-lifecycle"'),
  'package must expose the PQ-1/PQ-2/PQ-3 guard');
assert.ok(guardPack.includes("'test:audit-print-queue-lifecycle'"),
  'the mandatory source-of-truth pack must run the lifecycle guard');

console.log('PASS Audit PQ-1/PQ-2/PQ-3 print-queue lifecycle guard');
