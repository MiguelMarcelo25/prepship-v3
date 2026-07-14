import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveRateBackfillConcurrency,
  resolveRateBackfillDbWriteConcurrency,
} from '../src/services/rate-backfill-execution-policy';

assert.equal(
  resolveRateBackfillConcurrency({
    liveRateBudget: true,
    rateFetchConcurrency: 8,
    dbPoolMax: 1,
  }),
  1,
  'a one-connection application pool must run one background rate workflow at a time',
);

assert.equal(
  resolveRateBackfillConcurrency({
    liveRateBudget: true,
    rateFetchConcurrency: 8,
    dbPoolMax: 4,
  }),
  2,
  'live rate backfill remains capped at its two-order budget',
);

assert.equal(
  resolveRateBackfillConcurrency({
    liveRateBudget: false,
    rateFetchConcurrency: 8,
    dbPoolMax: 4,
  }),
  3,
  'cache-friendly work reserves one connection for worker control and other lanes',
);

assert.equal(
  resolveRateBackfillConcurrency({
    liveRateBudget: false,
    rateFetchConcurrency: 2,
    dbPoolMax: 8,
  }),
  2,
  'the carrier limiter remains an independent upper bound',
);

assert.equal(
  resolveRateBackfillDbWriteConcurrency(1),
  1,
  'one database connection serializes backfill status writes',
);

assert.equal(
  resolveRateBackfillDbWriteConcurrency(4),
  3,
  'status-write fan-out also reserves one connection from a four-connection worker pool',
);

assert.equal(
  resolveRateBackfillDbWriteConcurrency(20),
  4,
  'large pools still cap backfill status-write fan-out at four',
);

const schedulerSource = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const queueSource = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const backfillSource = readFileSync('src/services/rates-backfill.ts', 'utf8');

assert.match(
  schedulerSource,
  /export async function runBackfillTick\(\): Promise<void>[\s\S]*await waitForBackfillJob\(job\.jobId\)/,
  'the scheduler must await the canonical backfill service lifetime',
);
assert.match(
  queueSource,
  /registerWorker\(JOBS\.rateBackfill, \(\) => runBackfillTick\(\)\)/,
  'the durable rate worker must return the awaited scheduler promise',
);
assert.doesNotMatch(
  queueSource,
  /result\.synced > 0[\s\S]{0,200}runBackfillTick\(\)/,
  'order ingestion must not launch detached rate work outside the rate-backfill lane',
);
assert.match(
  backfillSource,
  /const backfillExecutionPromises = new Map<string, Promise<void>>\(\)[\s\S]*export async function waitForBackfillJob/,
  'the backfill service must expose its real execution lifetime to queue callers',
);

console.log('rate backfill DB-pool concurrency guard passed');
