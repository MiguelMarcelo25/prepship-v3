import assert from 'node:assert/strict';
import { resolveRateBackfillConcurrency } from '../src/services/rate-backfill-execution-policy';

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
    dbPoolMax: 3,
  }),
  3,
  'cache-friendly work may use the pool without exceeding its capacity',
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

console.log('rate backfill DB-pool concurrency guard passed');
