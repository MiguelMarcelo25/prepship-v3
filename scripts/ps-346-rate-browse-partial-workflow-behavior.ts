import assert from 'node:assert/strict';
import { buildRateBrowseResultSnapshot } from '../src/services/rate-browse-workflow-snapshots';
import type { RateBrowseWorkflowSnapshot } from '../src/services/rate-browse-workflow-types';

const running: RateBrowseWorkflowSnapshot = {
  jobId: 'job-1',
  phase: 'running',
  requestKey: null,
  orderId: 1979,
  totalCarriers: 0,
  completedCarriers: 0,
  successfulCarriers: 0,
  failedCarriers: 0,
  ratesCount: 0,
  startedAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z',
  finishedAt: null,
  message: 'Rate browse workflow running',
  result: null,
  diagnostics: { source: 'rate-browse-workflow' },
  error: null,
};

const cachedResult = {
  requestKey: 'cache-key-1',
  rates: [
    { carrier_id: 'se-1', amount: 7.69 },
    { carrier_id: 'se-2', amount: 8.41 },
  ],
  carrierStatuses: [
    { carrierId: 'se-1', status: 'cached' },
    { carrierId: 'se-2', status: 'cached' },
    { carrierId: 'se-3', status: 'queued' },
  ],
};

const partial = buildRateBrowseResultSnapshot({
  base: running,
  result: cachedResult,
  phase: 'partial',
  message: 'Cached rates available while live carriers continue',
  finishedAt: null,
  diagnostics: { partialSource: 'cache-first' },
});

assert.equal(partial.phase, 'partial', 'cached preview must be persisted as a partial workflow snapshot');
assert.equal(partial.finishedAt, null, 'partial snapshots must not mark the workflow final');
assert.equal(partial.requestKey, 'cache-key-1', 'partial snapshot should expose backend request key');
assert.equal(partial.ratesCount, 2, 'partial snapshot should count visible backend rates');
assert.equal(partial.totalCarriers, 3, 'partial snapshot should preserve carrier coverage count');
assert.equal(partial.completedCarriers, 2, 'queued carriers are not complete yet');
assert.equal(partial.successfulCarriers, 2, 'cached carriers count as successful partial coverage');
assert.equal(partial.failedCarriers, 0, 'queued carriers are not failed');
assert.equal(partial.result, cachedResult, 'partial snapshot should pass through the backend result DTO');
assert.deepEqual(
  partial.diagnostics,
  { source: 'rate-browse-workflow', partialSource: 'cache-first' },
  'partial diagnostics should explain the source without replacing existing diagnostics',
);

const complete = buildRateBrowseResultSnapshot({
  base: partial,
  result: {
    cacheKey: 'live-key-1',
    rates: [{ carrier_id: 'se-1', amount: 7.55 }],
    carrierStatuses: [{ carrierId: 'se-1', status: 'live' }],
  },
  phase: 'complete',
  message: 'Rate browse workflow complete',
  finishedAt: '2026-06-30T00:00:01.000Z',
  diagnostics: { rateBrowseTiming: { durationMs: 1000 } },
});

assert.equal(complete.phase, 'complete', 'final snapshot must still be complete');
assert.equal(complete.requestKey, 'live-key-1', 'final live result replaces the partial request key');
assert.equal(complete.finishedAt, '2026-06-30T00:00:01.000Z', 'complete snapshot records finish time');

console.log('PASS PS-346 rate browse partial workflow behavior');
