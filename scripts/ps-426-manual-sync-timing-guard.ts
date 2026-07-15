/**
 * PS-426 provider-free foreground timing proof.
 *
 * Exercises the exact route response owner with injected queue admission. It
 * never connects to a database, enqueues a pg-boss job, or calls a provider.
 * This is deterministic integration evidence, not a staging/live artifact.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { ManualOrderSyncEnqueueResult } from '../src/services/sync-job-queue';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { runManualOrderSyncRoute } = await import('../src/routes/sync');

const SAMPLE_COUNT = 100;
const TARGET_MS = 500;
let admissionCalls = 0;

function result(
  overrides: Partial<ManualOrderSyncEnqueueResult> = {},
): ManualOrderSyncEnqueueResult {
  return {
    queued: true,
    jobId: 'job-1',
    queueState: 'queued',
    blockerJobId: null,
    queueStarted: true,
    jobName: 'prepship.sync.orders',
    mode: 'incremental',
    requestedAt: '2026-07-16T00:00:00.000Z',
    error: null,
    ...overrides,
  };
}

const latencies: number[] = [];
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
  const startedAt = performance.now();
  const response = await runManualOrderSyncRoute({}, async () => {
    admissionCalls += 1;
    return result();
  });
  latencies.push(performance.now() - startedAt);
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'queued');
  assert.equal(response.body.message, 'Order sync queued');
}

const alreadyRunning = await runManualOrderSyncRoute({}, async () => result({
  queued: false,
  jobId: 'active-1',
  queueState: 'running',
  blockerJobId: 'active-1',
}));
assert.equal(alreadyRunning.status, 202);
assert.equal(alreadyRunning.body.message, 'Order sync is already running');

const failed = await runManualOrderSyncRoute({}, async () => result({
  queued: false,
  jobId: null,
  queueState: 'error',
  queueStarted: false,
  error: 'queue unavailable',
}));
assert.equal(failed.status, 503);
assert.equal(failed.body.message, 'queue unavailable');

const sorted = [...latencies].sort((a, b) => a - b);
const percentile = (ratio: number) => sorted[Math.min(
  sorted.length - 1,
  Math.ceil(sorted.length * ratio) - 1,
)]!;
const maxMs = sorted.at(-1)!;

assert.equal(admissionCalls, SAMPLE_COUNT, 'each request delegates exactly once to queue admission');
assert.ok(maxMs < TARGET_MS, `foreground route exceeded ${TARGET_MS}ms: ${maxMs.toFixed(3)}ms`);

console.log(JSON.stringify({
  taskId: 'PS-426',
  evidenceClass: 'integration',
  environment: 'offline-injected-admission',
  samples: SAMPLE_COUNT,
  targetMs: TARGET_MS,
  p50Ms: Number(percentile(0.5).toFixed(3)),
  p95Ms: Number(percentile(0.95).toFixed(3)),
  maxMs: Number(maxMs.toFixed(3)),
  queueAdmissionCalls: admissionCalls,
  databaseConnections: 0,
  providerCalls: 0,
  status: 'pass',
}));
