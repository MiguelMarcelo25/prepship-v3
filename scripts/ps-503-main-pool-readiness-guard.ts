#!/usr/bin/env tsx
/**
 * PS-503 — readiness must observe the pool that serves traffic.
 *
 * On 2026-08-11 the Supavisor pooler closed the MAIN pool's connections twice
 * (`write CONNECTION_CLOSED …pooler.supabase.com:6543`). Both times the API was
 * totally down and `/health/ready` answered 200 in ~0.7s, because every probe
 * ran on `healthSql` — a separate max:3 pool whose sockets were fine. No
 * monitor could have paged; both outages were found by a human looking at a
 * screen.
 *
 * Hermetic: imports one dependency-free module and reads two files as text.
 * No DB, no network, no provider calls.
 *
 * The behavioural half is the point. A guard that only asserted "the string
 * mainSql appears in health.ts" would pass on a build where the probe never
 * fails, which is precisely the bug being fixed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyMainPoolFailure,
  createMainPoolHealthTracker,
} from '../src/services/main-pool-health';

let checks = 0;
const check = (label: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

console.log('PS-503 main-pool readiness guard');

// ── 1. Classification: a closed socket is never mistaken for a busy pool ─────
// These are the exact shapes postgres.js and Node raise. If this classifier
// regresses to "everything is saturated", the outage signature gets swallowed
// by the tolerance window and readiness stays green again.
check('CONNECTION_CLOSED classifies as unreachable', () => {
  const error = Object.assign(new Error('write CONNECTION_CLOSED 1.2.3.4:6543'), {
    code: 'CONNECTION_CLOSED',
  });
  assert.equal(classifyMainPoolFailure(error), 'unreachable');
});

check('the live outage message classifies as unreachable', () => {
  assert.equal(
    classifyMainPoolFailure(
      new Error('write CONNECTION_CLOSED aws-1-us-west-1.pooler.supabase.com:6543')
    ),
    'unreachable'
  );
});

check('socket-level errors classify as unreachable', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND']) {
    assert.equal(
      classifyMainPoolFailure(Object.assign(new Error('boom'), { code })),
      'unreachable',
      `${code} must be unreachable`
    );
  }
});

check('a probe timeout classifies as saturated, not unreachable', () => {
  // withTimeout's own message. A busy pool is alive; treating it as dead would
  // restart the service under load.
  assert.equal(
    classifyMainPoolFailure(new Error('DB health check timed out after 3000ms')),
    'saturated'
  );
});

check('unknown errors default to the tolerant path', () => {
  assert.equal(classifyMainPoolFailure(new Error('something odd')), 'saturated');
  assert.equal(classifyMainPoolFailure(undefined), 'saturated');
});

// ── 2. Tolerance policy ─────────────────────────────────────────────────────
check('an unreachable pool fails readiness on the FIRST probe', () => {
  const tracker = createMainPoolHealthTracker(3);
  const verdict = tracker.recordFailure(
    Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })
  );
  assert.equal(verdict.healthy, false, 'a closed socket must not be tolerated');
  assert.equal(verdict.failure, 'unreachable');
});

check('saturation is tolerated up to the limit, then fails', () => {
  const tracker = createMainPoolHealthTracker(3);
  const busy = () => new Error('DB health check timed out after 3000ms');
  assert.equal(tracker.recordFailure(busy()).healthy, true, 'first busy probe stays green');
  assert.equal(tracker.recordFailure(busy()).healthy, true, 'second busy probe stays green');
  const third = tracker.recordFailure(busy());
  assert.equal(third.healthy, false, 'sustained saturation must fail readiness');
  assert.equal(third.consecutiveSaturated, 3);
});

check('a success resets the saturation streak', () => {
  const tracker = createMainPoolHealthTracker(3);
  tracker.recordFailure(new Error('DB health check timed out after 3000ms'));
  tracker.recordFailure(new Error('DB health check timed out after 3000ms'));
  assert.equal(tracker.recordSuccess().consecutiveSaturated, 0);
  // Without the reset, two unrelated busy moments hours apart would eventually
  // trip a restart.
  assert.equal(
    tracker.recordFailure(new Error('DB health check timed out after 3000ms')).healthy,
    true
  );
});

check('unreachable is not absorbed by an in-progress saturation streak', () => {
  const tracker = createMainPoolHealthTracker(5);
  tracker.recordFailure(new Error('DB health check timed out after 3000ms'));
  const dead = tracker.recordFailure(
    Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })
  );
  assert.equal(dead.healthy, false);
});

check('tolerance below 1 cannot disable the check', () => {
  // A misconfigured 0 must not mean "tolerate forever".
  assert.equal(
    createMainPoolHealthTracker(0).recordFailure(new Error('timed out')).healthy,
    false
  );
});

// ── 3. Wiring: /ready must actually run the probe, on the MAIN pool ─────────
const healthSource = readFileSync('src/routes/health.ts', 'utf8');

check('health.ts imports the main pool', () => {
  assert.match(
    healthSource,
    /import\s*\{\s*sql as mainSql\s*\}\s*from\s*'\.\.\/db\/client'/,
    'health.ts must import the main pool from db/client'
  );
});

check('the probe queries mainSql, not healthSql', () => {
  const start = healthSource.indexOf('async function checkMainPool');
  assert.notEqual(start, -1, 'checkMainPool must exist');
  const body = healthSource.slice(start, healthSource.indexOf('\n}', start));
  assert.match(body, /mainSql`/, 'checkMainPool must query the main pool');
  assert(
    !body.includes('healthSql'),
    'checkMainPool must NOT fall back to healthSql — that is the bug being fixed'
  );
});

check('/ready runs checkMainPool', () => {
  const start = healthSource.indexOf('async function checkReadyReadiness');
  assert.notEqual(start, -1);
  const body = healthSource.slice(start, healthSource.indexOf('\n}', start));
  assert.match(
    body,
    /checkMainPool\(\)/,
    'checkReadyReadiness must probe the main pool — Render rotates on /ready'
  );
});

check('/deep also reports the main pool', () => {
  const start = healthSource.indexOf('async function checkDeepReadiness');
  assert.notEqual(start, -1);
  const body = healthSource.slice(start, healthSource.indexOf('\n  return {', start));
  assert.match(body, /checkMainPool\(\)/);
  assert.match(body, /\bmainPool,/, 'mainPool must be in the reported component list');
});

check('mainPool is a declared readiness component', () => {
  assert.match(healthSource, /\|\s*'mainPool'/);
});

// ── 4. The knobs exist and default safely ───────────────────────────────────
const envSource = readFileSync('src/lib/env.ts', 'utf8');

check('probe timeout is far below DB_HEALTH_TIMEOUT_MS', () => {
  const match = envSource.match(
    /DB_MAIN_POOL_HEALTH_TIMEOUT_MS:[^\n]*default\((\d[\d_]*)\)/
  );
  assert(match, 'DB_MAIN_POOL_HEALTH_TIMEOUT_MS must be declared');
  const value = Number(match[1].replace(/_/g, ''));
  assert(
    value <= 5_000,
    `probe must fail fast (got ${value}ms); a slow probe holds the whole readiness response`
  );
});

check('saturation tolerance is declared and finite', () => {
  const match = envSource.match(
    /DB_MAIN_POOL_SATURATION_TOLERANCE:[^\n]*default\((\d+)\)/
  );
  assert(match, 'DB_MAIN_POOL_SATURATION_TOLERANCE must be declared');
  const value = Number(match[1]);
  assert(value >= 1 && value <= 10, `tolerance must be 1-10 (got ${value})`);
});

console.log(`\nPS-503 guard passed — ${checks} checks.`);
