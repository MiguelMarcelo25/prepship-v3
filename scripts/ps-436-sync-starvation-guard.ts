/**
 * PS-436 offline guard: rate backfill must yield the shared lane in durable,
 * resumable chunks and fail closed when cancellation is ignored.
 *
 * No database connection, provider call, label, marketplace notification, or
 * production order/shipment mutation is performed here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeadlineExceededError, withDeadline } from '../src/lib/with-deadline';
import { awaitCancellationAcknowledgement } from '../src/lib/sync-job-cancellation';
import { withAbortableCarrierQuoteTimeout } from '../src/services/rates-combined';
import {
  buildCadenceRateBackfillJobPayload,
  rateBackfillPriority,
} from '../src/services/rate-backfill-job-types';
import {
  getSyncJobLaneBlocker,
  syncJobLaneFor,
} from '../src/services/sync-job-lanes';
import {
  resolveSyncJobAdmission,
  SHIPSTATION_SYNC_JOBS,
} from '../src/services/sync-job-admission';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  buildRateBackfillContinuation,
  deterministicRateBackfillChunkJobId,
  shouldCoalesceCadenceGeneration,
  RATE_BACKFILL_DURABLE_CHUNK_SIZE,
} = await import('../src/services/rates-backfill');
const {
  evaluateShipmentSyncWatchdog,
  SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
} = await import('../src/services/shipment-sync-watchdog');
const { workerActiveLaneStatus } = await import('../src/services/worker-status');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// Never-settling work cannot hold the test (or production queue) forever.
const neverSettles = new Promise<void>(() => undefined);
await assert.rejects(
  withDeadline(() => neverSettles, 30, 'never-settling-rate-provider'),
  DeadlineExceededError,
);
const graceStartedAt = Date.now();
const cancellation = await awaitCancellationAcknowledgement(neverSettles, 30);
assert.equal(cancellation.acknowledged, false);
assert.ok(Date.now() - graceStartedAt < 1_000, 'cancellation grace must be bounded');

// The canonical lane owner blocks a successor until the fail-closed decision;
// a promise that ignored cancellation can never overlap order/shipment work.
const activeLanes = new Map([
  [syncJobLaneFor('prepship.sync.rate-backfill'), 'prepship.sync.rate-backfill'],
]);
let recoveryRequested = false;
if (!cancellation.acknowledged) recoveryRequested = true;
assert.equal(
  getSyncJobLaneBlocker(activeLanes, SHIPSTATION_SYNC_JOBS.orders),
  'prepship.sync.rate-backfill',
);
assert.equal(
  getSyncJobLaneBlocker(activeLanes, SHIPSTATION_SYNC_JOBS.shipments),
  'prepship.sync.rate-backfill',
);
assert.equal(recoveryRequested, true);

// Parent AbortSignal reaches the injected provider operation, not just the
// outer queue promise.
const parent = new AbortController();
let providerObservedAbort = false;
const provider = withAbortableCarrierQuoteTimeout(
  (signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      providerObservedAbort = true;
      reject(signal.reason);
    }, { once: true });
  }),
  'injected-provider',
  5_000,
  parent.signal,
);
parent.abort(new Error('queue deadline'));
await assert.rejects(provider, /queue deadline/);
assert.equal(providerObservedAbort, true);

// One logical cadence request resumes through deterministic two-order chunks.
const first = buildCadenceRateBackfillJobPayload('11111111-1111-4111-8111-111111111111');
assert.equal(RATE_BACKFILL_DURABLE_CHUNK_SIZE, 2);
const second = buildRateBackfillContinuation(first, {
  hasMore: true,
  nextCursor: {
    beforeOrderDate: '2026-07-17T00:00:00.000Z',
    beforeOrderId: 900,
  },
  advanced: 2,
});
assert.ok(second);
assert.equal(second.generationId, first.generationId);
assert.equal(second.chunkIndex, 1);
assert.equal(second.remainingLimit, 4_998);
assert.deepEqual(second.cursor, {
  beforeOrderDate: '2026-07-17T00:00:00.000Z',
  beforeOrderId: 900,
});
assert.equal(
  second.jobId,
  deterministicRateBackfillChunkJobId(first.generationId!, 1),
  'retrying a completed chunk must deduplicate the same durable continuation',
);
assert.equal(
  buildRateBackfillContinuation(first, {
    hasMore: true,
    nextCursor: second.cursor ?? null,
    advanced: 2,
  })?.jobId,
  second.jobId,
);
assert.equal(
  buildRateBackfillContinuation(second, {
    hasMore: false,
    nextCursor: null,
    advanced: 2,
  }),
  null,
);

// A later cron/deferral wake-up joins the persisted active generation.
const activeGeneration = {
  version: 1 as const,
  generationId: first.generationId!,
  requestedBy: 'cadence' as const,
  status: 'active' as const,
  currentChunkIndex: 0,
  currentJobId: first.jobId,
  nextPayload: second,
  lastError: null,
  updatedAt: '2026-07-17T00:00:00.000Z',
};
const laterCadence = buildCadenceRateBackfillJobPayload('22222222-2222-4222-8222-222222222222');
assert.equal(shouldCoalesceCadenceGeneration(activeGeneration, laterCadence), true);
assert.equal(shouldCoalesceCadenceGeneration(null, laterCadence), false);

// Sustained rate pressure cannot starve operational cadence: this deterministic
// queue simulation uses the real admission priorities and keeps another rate
// chunk ready for the entire hour. Both three-minute cadence jobs finish well
// inside the documented 13-minute end-to-end freshness budget.
const orderPriority = resolveSyncJobAdmission(
  SHIPSTATION_SYNC_JOBS.orders,
  { kind: 'cadence' },
).priority;
const shipmentPriority = resolveSyncJobAdmission(
  SHIPSTATION_SYNC_JOBS.shipments,
  { kind: 'cadence' },
).priority;
const continuationPriority = rateBackfillPriority(second);
assert.ok(orderPriority > continuationPriority);
assert.ok(shipmentPriority > continuationPriority);

type SimulatedJob = {
  kind: 'orders' | 'shipments' | 'rate';
  arrivalAtSeconds: number;
  durationSeconds: number;
  priority: number;
  sequence: number;
};
const simulatedQueue: SimulatedJob[] = [];
let sequence = 0;
const simulationSeconds = 60 * 60;
for (let arrivalAtSeconds = 0; arrivalAtSeconds < simulationSeconds; arrivalAtSeconds += 3 * 60) {
  simulatedQueue.push({
    kind: 'orders',
    arrivalAtSeconds,
    durationSeconds: 10,
    priority: orderPriority,
    sequence: sequence++,
  });
  simulatedQueue.push({
    kind: 'shipments',
    arrivalAtSeconds,
    durationSeconds: 10,
    priority: shipmentPriority,
    sequence: sequence++,
  });
}
const expectedOperationalJobs = simulatedQueue.length;
const operationalCompletionAges: number[] = [];
let completedOperationalJobs = 0;
let clockSeconds = 0;
while (completedOperationalJobs < expectedOperationalJobs) {
  if (!simulatedQueue.some((job) => job.kind === 'rate')) {
    simulatedQueue.push({
      kind: 'rate',
      arrivalAtSeconds: clockSeconds,
      durationSeconds: 45,
      priority: continuationPriority,
      sequence: sequence++,
    });
  }
  const ready = simulatedQueue
    .filter((job) => job.arrivalAtSeconds <= clockSeconds)
    .sort((left, right) =>
      right.priority - left.priority
      || left.arrivalAtSeconds - right.arrivalAtSeconds
      || left.sequence - right.sequence
    );
  if (!ready.length) {
    clockSeconds = Math.min(...simulatedQueue.map((job) => job.arrivalAtSeconds));
    continue;
  }
  const next = ready[0]!;
  simulatedQueue.splice(simulatedQueue.indexOf(next), 1);
  clockSeconds += next.durationSeconds;
  if (next.kind !== 'rate') {
    completedOperationalJobs++;
    operationalCompletionAges.push(clockSeconds - next.arrivalAtSeconds);
  }
}
assert.equal(completedOperationalJobs, expectedOperationalJobs);
assert.ok(
  Math.max(...operationalCompletionAges) <= 13 * 60,
  'order and shipment cadence must complete within the documented freshness budget',
);

// Fresh watermarks are still unhealthy when the shared lane is over age; a
// young lane plus fresh watermarks is healthy.
const nowMs = Date.parse('2026-07-17T12:00:00.000Z');
const thresholds = SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS;
const freshBase = {
  nowMs,
  orderLastSyncedAt: '2026-07-17T11:59:00.000Z',
  shipmentLastSyncedAt: '2026-07-17T11:58:00.000Z',
  workerHeartbeatAgeSeconds: 30,
  workerCurrentLane: 'shipstation-sync',
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
};
const overAge = evaluateShipmentSyncWatchdog({
  ...freshBase,
  workerCurrentJobAgeSeconds: thresholds.activeJobStuckSeconds + 1,
});
assert.equal(overAge.state, 'sync_lane_stuck');
assert.equal(overAge.alert, true);
const healthy = evaluateShipmentSyncWatchdog({
  ...freshBase,
  workerCurrentJobAgeSeconds: 30,
});
assert.equal(healthy.state, 'ok');
assert.equal(healthy.alert, false);

const lane = workerActiveLaneStatus({
  version: 1,
  service: 'worker',
  mode: 'worker-scheduler',
  schedulerEnabled: true,
  placeholder: false,
  pid: 123,
  startedAt: '2026-07-17T11:00:00.000Z',
  heartbeatAt: '2026-07-17T11:59:30.000Z',
  currentJob: 'prepship.reporting.refresh',
  activeLanes: {
    'shipstation-sync': {
      jobName: 'prepship.sync.rate-backfill',
      jobId: second.jobId,
      generationId: second.generationId,
      lane: 'shipstation-sync',
      startedAt: '2026-07-17T11:59:00.000Z',
      deadlineAt: '2026-07-17T12:09:00.000Z',
      timeoutMs: 600_000,
    },
  },
  syncWatermarks: {
    ordersCompletedAt: '2026-07-17T11:59:00.000Z',
    shipmentsCompletedAt: '2026-07-17T11:58:00.000Z',
  },
  jobs: {
    'prepship.sync.rate-backfill': {
      name: 'prepship.sync.rate-backfill',
      jobId: second.jobId,
      generationId: second.generationId,
      lane: 'shipstation-sync',
      status: 'running',
      startedAt: '2026-07-17T11:59:00.000Z',
      deadlineAt: '2026-07-17T12:09:00.000Z',
      timeoutMs: 600_000,
      finishedAt: null,
      durationMs: null,
      summary: null,
      error: null,
    },
  },
}, nowMs);
assert.equal(lane?.jobId, second.jobId);
assert.equal(lane?.generationId, first.generationId);
assert.equal(lane?.ageSeconds, 60);
assert.equal(lane?.deadlineAt, '2026-07-17T12:09:00.000Z');

// Static boundary proof: the production paths use the tested owners.
const queue = read('src/services/sync-job-queue.ts');
const backfill = read('src/services/rates-backfill.ts');
const rates = read('src/services/rates.ts');
const health = read('src/routes/health.ts');
const scheduler = read('src/services/sync-scheduler.ts');
assert.match(queue, /awaitCancellationAcknowledgement\([\s\S]*SYNC_JOB_CANCELLATION_GRACE_MS/);
assert.match(queue, /terminateWorkerForUnacknowledgedCancellation/);
assert.match(queue, /runDurableRateBackfillJob\(explicitRequest, signal\)/);
assert.match(queue, /runBackfillTick\(identity\.queueJobId, signal\)/);
assert.match(queue, /priority: rateBackfillPriority\(ratePayload\)/);
assert.match(backfill, /RATE_BACKFILL_DURABLE_CHUNK_SIZE = 2/);
assert.match(backfill, /currentJobId: payload\.jobId,[\s\S]{0,300}nextPayload: payload/);
assert.match(backfill, /persistRateBackfillGenerationState[\s\S]*enqueueDurableRateBackfillJob\(nextPayload\)/);
assert.match(backfill, /assertBackfillCanContinue\(jobId, context\.signal, `best-rate persistence/);
assert.match(backfill, /signal: context\.signal/);
assert.match(rates, /withAbortableCarrierQuoteTimeout\([\s\S]{0,1200}input\.signal/);
assert.match(scheduler, /buildCadenceRateBackfillJobPayload[\s\S]*runDurableRateBackfillJob\(payload, signal\)/);
assert.match(health, /checkSyncFreshness[\s\S]*health\.verdict\.alert \? 'fail' : 'ok'/);
assert.match(
  read('src/services/shipment-sync-watchdog.ts'),
  /currentJob: worker\.activeLane\?\.jobName \?\? worker\.status\?\.currentJob/,
);

console.log('PASS PS-436 sync starvation guard');
