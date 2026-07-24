import assert from 'node:assert/strict';
import {
  API_TIMING_MIN_CONFIDENT_SAMPLES,
  API_TIMING_WINDOW_MS,
  getApiTimingSnapshot,
  normalizeApiMetricPath,
  observeApiTiming,
  resetApiTimingMetricsForTest,
} from '../src/lib/http/api-metrics';

const baseNow = Date.now();

assert.equal(
  normalizeApiMetricPath('/orders/:id{[0-9]+}/full'),
  '/orders/:id/full',
  'Hono route constraints should not create separate metric identities',
);
assert.equal(
  normalizeApiMetricPath('/orders/1726450/full?view=compact'),
  '/orders/:id/full',
  'literal numeric IDs should fall back to the canonical route identity',
);
assert.equal(
  normalizeApiMetricPath('/rates/carriers-for-store'),
  '/rates/carriers-for-store',
  'static route identities should remain unchanged',
);

resetApiTimingMetricsForTest();
for (let index = 0; index < API_TIMING_MIN_CONFIDENT_SAMPLES - 1; index += 1) {
  observeApiTiming({
    method: 'GET',
    path: `/orders/${1726450 + index}/full`,
    status: 200,
    durationMs: 1_200,
    observedAtMs: baseNow,
  });
}

let snapshot = getApiTimingSnapshot({ nowMs: baseNow });
assert.equal(snapshot.routeCount, 1, 'dynamic order IDs should aggregate into one route');
assert.equal(snapshot.routes[0]?.path, '/orders/:id/full');
assert.equal(snapshot.routes[0]?.confidence, 'learning');
assert.equal(snapshot.routes[0]?.health, 'learning');
assert.equal(snapshot.summary.state, 'learning');

observeApiTiming({
  method: 'GET',
  path: '/orders/:id{[0-9]+}/full',
  status: 200,
  durationMs: 1_200,
  observedAtMs: baseNow,
});
snapshot = getApiTimingSnapshot({ nowMs: baseNow });
assert.equal(snapshot.routes[0]?.count, API_TIMING_MIN_CONFIDENT_SAMPLES);
assert.equal(snapshot.routes[0]?.confidence, 'ready');
assert.equal(snapshot.routes[0]?.health, 'slow');
assert.equal(snapshot.summary.slowRouteCount, 1);
assert.equal(snapshot.summary.state, 'slow');

observeApiTiming({
  method: 'GET',
  path: '/orders/1726450/full',
  status: 503,
  durationMs: 100,
  observedAtMs: baseNow,
});
snapshot = getApiTimingSnapshot({ nowMs: baseNow });
assert.equal(snapshot.routes[0]?.health, 'error');
assert.equal(snapshot.routes[0]?.errorCount, 1);
assert.equal(snapshot.summary.errorRouteCount, 1);
assert.equal(snapshot.summary.state, 'error');

resetApiTimingMetricsForTest();
observeApiTiming({
  method: 'GET',
  path: '/sync/status',
  status: 200,
  durationMs: 900,
  observedAtMs: baseNow - API_TIMING_WINDOW_MS - 1,
});
observeApiTiming({
  method: 'GET',
  path: '/sync/status',
  status: 200,
  durationMs: 100,
  observedAtMs: baseNow,
});
snapshot = getApiTimingSnapshot({ nowMs: baseNow });
assert.equal(snapshot.routes[0]?.count, 1, 'expired samples must leave the rolling window');
assert.equal(snapshot.routes[0]?.p95Ms, 100, 'percentiles must use only in-window samples');
assert.equal(snapshot.summary.windowSampleCount, 1);

resetApiTimingMetricsForTest();
console.log('API observability metrics behavior test passed.');
