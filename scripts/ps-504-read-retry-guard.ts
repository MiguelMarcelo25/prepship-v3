#!/usr/bin/env tsx
/**
 * PS-504 — survive a dropped connection without failing the request.
 *
 * postgres.js already reconnects (connection.js `closed()` -> `reconnect()`,
 * backoff capped at 20s, counter reset on success). What it cannot do is rescue
 * the query that was in flight when the socket died: that one rejects with
 * CONNECTION_CLOSED and the caller sees a 500 even though the next request would
 * have worked. During the 2026-08-11 pooler incidents the Orders list failed on
 * exactly that.
 *
 * The retry is only safe because it is restricted to reads. CONNECTION_CLOSED is
 * ambiguous for a write — the statement may have committed and only the reply
 * was lost — so retrying one duplicates the effect: a second charge, a second
 * label, a second ledger movement. The most important assertion in this file is
 * the one that keeps writes out.
 *
 * Hermetic: one dependency-free module plus file reads. No DB, no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withDbReadRetry } from '../src/db/read-retry';
import { createMainPoolHealthTracker } from '../src/services/main-pool-health';

let checks = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

const closed = () =>
  Object.assign(new Error('write CONNECTION_CLOSED 1.2.3.4:6543'), {
    code: 'CONNECTION_CLOSED',
  });
const busy = () => new Error('DB health check timed out after 3000ms');

console.log('PS-504 read-retry guard');

// ── Retry behaviour ─────────────────────────────────────────────────────────
await check('a dropped socket is retried and the read succeeds', async () => {
  let calls = 0;
  const result = await withDbReadRetry(async () => {
    calls += 1;
    if (calls === 1) throw closed();
    return 'rows';
  }, { delayMs: 0 });
  assert.equal(result, 'rows');
  assert.equal(calls, 2, 'must have retried exactly once');
});

await check('a healthy read is not called twice', async () => {
  let calls = 0;
  await withDbReadRetry(async () => { calls += 1; return 1; }, { delayMs: 0 });
  assert.equal(calls, 1);
});

await check('a SATURATED pool is NOT retried', async () => {
  // Piling retries onto a pool with no free connection makes contention worse;
  // the caller's timeout is the correct backpressure.
  let calls = 0;
  await assert.rejects(
    withDbReadRetry(async () => { calls += 1; throw busy(); }, { delayMs: 0 })
  );
  assert.equal(calls, 1, 'saturation must fail on the first attempt');
});

await check('an ordinary query error is NOT retried', async () => {
  let calls = 0;
  await assert.rejects(
    withDbReadRetry(async () => {
      calls += 1;
      throw new Error('syntax error at or near "slect"');
    }, { delayMs: 0 }),
    /syntax error/
  );
  assert.equal(calls, 1, 'a real query bug must surface immediately');
});

await check('attempts are bounded and the last error propagates', async () => {
  let calls = 0;
  await assert.rejects(
    withDbReadRetry(async () => { calls += 1; throw closed(); }, { attempts: 3, delayMs: 0 }),
    /CONNECTION_CLOSED/
  );
  assert.equal(calls, 3, 'must stop at the configured attempt count');
});

await check('attempts below 1 cannot disable the read', async () => {
  let calls = 0;
  await withDbReadRetry(async () => { calls += 1; return 'ok'; }, { attempts: 0, delayMs: 0 });
  assert.equal(calls, 1, 'the read must still run once');
});

await check('a throwing onRetry hook cannot break a recoverable read', async () => {
  let calls = 0;
  const result = await withDbReadRetry(async () => {
    calls += 1;
    if (calls === 1) throw closed();
    return 'rows';
  }, { delayMs: 0, onRetry: () => { throw new Error('telemetry exploded'); } });
  assert.equal(result, 'rows');
});

// ── Lifetime counters ───────────────────────────────────────────────────────
await check('lifetime counters record both failure kinds', () => {
  const tracker = createMainPoolHealthTracker(3);
  tracker.recordFailure(closed());
  tracker.recordFailure(busy());
  tracker.recordFailure(busy());
  const snap = tracker.snapshot();
  assert.equal(snap.unreachableCount, 1);
  assert.equal(snap.saturatedCount, 2);
  assert.equal(snap.lastFailure, 'saturated');
});

await check('a success does NOT erase lifetime evidence', () => {
  // A pool that dropped sockets an hour ago and recovered is still evidence.
  const tracker = createMainPoolHealthTracker(3);
  tracker.recordFailure(closed());
  tracker.recordSuccess();
  const snap = tracker.snapshot();
  assert.equal(snap.unreachableCount, 1, 'history must survive recovery');
  assert.equal(snap.consecutiveSaturated, 0, 'but the streak resets');
});

await check('a clean tracker reports nothing', () => {
  const snap = createMainPoolHealthTracker(3).snapshot();
  assert.equal(snap.unreachableCount, 0);
  assert.equal(snap.saturatedCount, 0);
  assert.equal(snap.lastFailure, null);
});

// ── Wiring + the safety property ────────────────────────────────────────────
const ordersSource = readFileSync('src/routes/orders.ts', 'utf8');
const healthSource = readFileSync('src/routes/health.ts', 'utf8');

await check('the Orders list read is retried', () => {
  assert.match(
    ordersSource,
    /withDbReadRetry\(\(\) => ordersListResponse\(c, c\.req\.valid\('query'\)\)\)/,
    'GET /orders must retry across a dropped socket'
  );
});

await check('the read-only bulk-snapshot is retried', () => {
  assert.match(ordersSource, /withDbReadRetry\(\(\) => ordersListResponse\(c, \{/);
});

await check('health surfaces lifetime pool evidence', () => {
  assert.match(healthSource, /unreachableCount/);
  assert.match(healthSource, /saturatedCount/);
});

// THE safety assertion. If this ever fails, a write is being retried across an
// ambiguous connection error and can be applied twice.
await check('withDbReadRetry never wraps a write', () => {
  const FORBIDDEN =
    /\b(db\.insert|db\.update|db\.delete|INSERT INTO|UPDATE \w+ SET|DELETE FROM|purchaseLabel|createLabel|\.begin\()/i;
  const sources: Array<[string, string]> = [
    ['src/routes/orders.ts', ordersSource],
  ];
  let callSites = 0;
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/withDbReadRetry\(/g)) {
      callSites += 1;
      // Read a generous window after the call site; a write anywhere in the
      // wrapped expression is disqualifying.
      const window = source.slice(match.index ?? 0, (match.index ?? 0) + 400);
      assert(
        !FORBIDDEN.test(window),
        `${file}: withDbReadRetry appears to wrap a write. CONNECTION_CLOSED is ` +
          `ambiguous for writes — retrying can duplicate a charge, a label, or a ` +
          `ledger movement.`
      );
    }
  }
  assert(callSites >= 2, `expected the known read call sites, found ${callSites}`);
});

await check('the helper documents the reads-only restriction', () => {
  const retrySource = readFileSync('src/db/read-retry.ts', 'utf8');
  assert.match(retrySource, /READS ONLY/, 'the restriction must be stated at the source');
  assert.match(
    retrySource,
    /classifyMainPoolFailure\(error\) !== 'unreachable'/,
    'only a dropped socket may retry'
  );
});

console.log(`\nPS-504 guard passed — ${checks} checks.`);
