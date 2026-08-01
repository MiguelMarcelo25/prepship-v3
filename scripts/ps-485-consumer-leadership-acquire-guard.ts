/**
 * PS-485 ShipStation consumer leadership acquire guard.
 *
 * Offline/static: the real ShipStationConsumerLeadershipController driven through
 * injected dependencies. No DB, no pg-boss, no provider, no postage.
 *
 * The incident this pins (2026-08-01). A deploy restarted the service; the outgoing
 * instance's leadership session left its advisory lock alive; the incoming instance
 * called tryAcquire() every 5s for 29 MINUTES and never acquired it. Because the three
 * stately queues (orders, shipments, fulfillment-outbox) only get consumers once
 * leadership is held, ALL THREE had no consumer for that window -- verified in
 * pgboss.job: each started exactly one job, all within the same 45ms after the manual
 * restart, while every non-leadership queue ran normally throughout (rate-backfill 27
 * starts, shopify-orders 10, carrier-account-snapshots 26).
 *
 * Order sync froze at 03:02:04 for 40 minutes and `/health/deep` sat at 503. Nothing
 * detected it: the watchdog saw the symptom and queued a recovery job INTO THE
 * UNCONSUMED QUEUE, then reported "recovery job already queued" as though it had acted.
 *
 * The remedy already existed for the sibling case -- restartAfterLostConnection()
 * requests a supervisor restart precisely because a lost session can strand its
 * server-side lock. Losing the lock and never acquiring it have the same cause and the
 * same fix; only the first was wired up.
 *
 * The invariant: failing to acquire is normal briefly (a deploy handoff) and
 * pathological if it persists, and the two are distinguishable ONLY by duration.
 */
process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

import { readFileSync } from 'node:fs';

const { ShipStationConsumerLeadershipController } =
  await import('../src/services/sync-job-queue');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

/**
 * Drives the controller with a fake clock and a lock that can be held by "someone
 * else". Timers fire synchronously on demand so a 29-minute stall runs instantly.
 */
function harness(opts: { lockAvailable: () => boolean }) {
  let nowMs = 1_000_000;
  const pending: Array<{ fn: () => void; at: number }> = [];
  const restarts: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  let registerCount = 0;

  const controller = new ShipStationConsumerLeadershipController({
    reserveConnection: async () => ({
      ping: async () => {},
      tryAcquire: async () => opts.lockAvailable(),
      unlock: async () => {},
      release: () => {},
    }),
    recoverActiveJobs: async () => {},
    readActiveJobs: async () => [],
    registerConsumers: async () => { registerCount += 1; },
    unregisterConsumers: async () => {},
    requestRestart: (reason) => { restarts.push(reason); },
    now: () => nowMs,
    setTimer: (fn, delayMs) => { const h = { fn, at: nowMs + delayMs }; pending.push(h); return h; },
    clearTimer: (handle) => {
      const i = pending.indexOf(handle as { fn: () => void; at: number });
      if (i >= 0) pending.splice(i, 1);
    },
    info: () => {},
    warn: (message) => { warns.push(message); },
    error: (message) => { errors.push(message); },
  });

  /** Advance the clock and run every timer that has come due. */
  const tick = async (advanceMs: number) => {
    nowMs += advanceMs;
    const due = pending.splice(0, pending.length).filter((t) => t.at <= nowMs);
    for (const t of due) t.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { controller, tick, restarts, warns, errors,
    registerCount: () => registerCount, snapshot: () => controller.snapshot() };
}

// ── the lock is free: normal boot ────────────────────────────────────────────
{
  const h = harness({ lockAvailable: () => true });
  await h.controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  check('with the lock free, leadership is acquired and consumers register',
    h.snapshot().ownsLock && h.snapshot().consumersRegistered, h.snapshot());
  check('a healthy leader reports no acquire failure',
    h.snapshot().acquireFailingForMs === null, h.snapshot());
  check('a healthy leader does NOT request a restart', h.restarts.length === 0, h.restarts);
}

// ── the lock is held by a stale session: the incident ────────────────────────
{
  const h = harness({ lockAvailable: () => false });
  await h.controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  check('while the lock is held, consumers are NOT registered',
    !h.snapshot().consumersRegistered && !h.snapshot().ownsLock);
  check('registerConsumers is never called without leadership', h.registerCount() === 0);

  // A short failure is a normal deploy handoff and must NOT escalate.
  for (let i = 0; i < 5; i += 1) await h.tick(5_000);
  check('a 25s failure does not escalate (this is a normal deploy handoff)',
    h.restarts.length === 0, h.restarts);

  // ...but it must become VISIBLE well before it becomes an outage.
  for (let i = 0; i < 10; i += 1) await h.tick(5_000);
  check('a failure past a minute is logged, so the silent stretch is observable',
    h.warns.some((m) => /leadership not acquired/i.test(m)), h.warns);
  check('the snapshot exposes how long acquisition has been failing',
    (h.snapshot().acquireFailingForMs ?? 0) >= 60_000, h.snapshot());

  // ...and past the escalation window it must ask for the restart that actually
  // frees a stranded server-side lock. 29 minutes of silence is the bug.
  for (let i = 0; i < 60; i += 1) await h.tick(5_000);
  check('a sustained failure escalates to a supervisor restart',
    h.restarts.includes('shipstation_consumer_leadership_acquire_timeout'), h.restarts);
  check('the escalation is also logged as an error',
    h.errors.some((m) => /leadership unreachable/i.test(m)), h.errors);
  check('escalation still never registers consumers it does not own',
    h.registerCount() === 0);
}

// ── recovery: the lock frees up ──────────────────────────────────────────────
{
  let held = true;
  const h = harness({ lockAvailable: () => !held });
  await h.controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 3; i += 1) await h.tick(5_000);
  check('still blocked while the lock is held', !h.snapshot().consumersRegistered);

  held = false;
  await h.tick(5_000);
  check('once the lock frees, leadership is acquired and consumers register',
    h.snapshot().ownsLock && h.snapshot().consumersRegistered, h.snapshot());
  check('the acquire-failure clock resets after a successful acquire',
    h.snapshot().acquireFailingForMs === null, h.snapshot());
  check('recovery does not request a restart', h.restarts.length === 0, h.restarts);
}

// ── source pins ─────────────────────────────────────────────────────────────
const src = readFileSync('src/services/sync-job-queue.ts', 'utf8').replace(/\r\n/g, '\n');
check('the escalation window is bounded and finite',
  /SHIPSTATION_CONSUMER_LEADER_ACQUIRE_ESCALATE_MS = [0-9*_ ]+;/.test(src));
check('the escalate window is longer than the warn window, so warning comes first',
  /ACQUIRE_WARN_MS = 60_000/.test(src) && /ACQUIRE_ESCALATE_MS = 5 \* 60_000/.test(src));
check('a failed acquire still schedules a retry rather than giving up',
  /this\.noteAcquireFailure\(\);\n\s*this\.schedule\(this\.retryMs\);/.test(src));
check('a successful acquire clears the failure clock',
  /this\.acquireFailingSinceMs = null;\n\s*this\.acquireWarnLogged = false;\n\s*this\.connection = reserved;/.test(src));

// ── the watchdog must not call an unconsumed enqueue a success ───────────────
/**
 * The second half of the same incident. The watchdog saw order sync was stale, enqueued
 * a recovery job, found one already pending, and reported:
 *
 *   status: "completed", reason: "order sync recovery job already queued"
 *
 * every cycle for 29 minutes -- into a queue whose consumer had never registered. Self-
 * healing was feeding work into a void and reporting success, which is why nobody was
 * alerted while order sync sat frozen.
 *
 * "Already queued" is only good news if something is going to run it.
 */
const { decideSyncEnqueueRecovery, WATCHDOG_UNCONSUMED_QUEUE_SECONDS } =
  await import('../src/services/shipment-sync-watchdog');

const recovery = (over: Partial<Parameters<typeof decideSyncEnqueueRecovery>[0]>) =>
  decideSyncEnqueueRecovery({
    action: 'enqueue_order_sync',
    enqueued: { queued: false, error: null },
    unconsumedForSeconds: null,
    nowMs: Date.parse('2026-08-01T03:26:00Z'),
    ...over,
  });

check('a fresh enqueue on a consumed queue is a success',
  recovery({ enqueued: { queued: true, error: null }, unconsumedForSeconds: 2 }).status === 'completed');
check('"already queued" is a success while the queue is being consumed',
  recovery({ unconsumedForSeconds: 30 }).status === 'completed');
check('nothing waiting at all is a success (healthy or idle are the same thing)',
  recovery({ unconsumedForSeconds: null }).status === 'completed');

// The incident: a job eligible and unstarted well past the cadence.
const stalled = recovery({ unconsumedForSeconds: 1_740 });
check('a queue nothing has consumed for 29 minutes is NOT reported as completed',
  stalled.status === 'failed', stalled);
check('the reason names the real problem rather than "already queued"',
  /not being consumed/i.test(stalled.reason) && !/already queued/i.test(stalled.reason),
  stalled.reason);
check('the reason says enqueuing more cannot help',
  /cannot help/i.test(stalled.reason), stalled.reason);
check('the reason points at the consumer, which is where the fault actually is',
  /consumer/i.test(stalled.reason), stalled.reason);

check('a real enqueue error still fails, and reports the error',
  recovery({ enqueued: { queued: false, error: 'boom' } }).status === 'failed'
    && /boom/.test(recovery({ enqueued: { queued: false, error: 'boom' } }).reason));
check('an enqueue error outranks the unconsumed check',
  /enqueue failed/i.test(recovery({
    enqueued: { queued: false, error: 'boom' }, unconsumedForSeconds: 9_999,
  }).reason));

// Boundary: a brief wait is normal scheduling, not a missing consumer.
check('just under the threshold is still a success (normal scheduling latency)',
  recovery({ unconsumedForSeconds: WATCHDOG_UNCONSUMED_QUEUE_SECONDS - 1 }).status === 'completed');
check('at the threshold it fails',
  recovery({ unconsumedForSeconds: WATCHDOG_UNCONSUMED_QUEUE_SECONDS }).status === 'failed');
check('the threshold is bounded and no tighter than the sync cadence',
  WATCHDOG_UNCONSUMED_QUEUE_SECONDS >= 180 && Number.isFinite(WATCHDOG_UNCONSUMED_QUEUE_SECONDS));

// Both lanes, same rule -- shipments had no consumer either.
const shipStalled = recovery({ action: 'enqueue_shipment_sync', unconsumedForSeconds: 1_740 });
check('the shipment lane gets the same treatment',
  shipStalled.status === 'failed' && /shipment sync/.test(shipStalled.reason), shipStalled);

const wd = readFileSync('src/services/shipment-sync-watchdog.ts', 'utf8').replace(/\r\n/g, '\n');
check('the watchdog actually consults the unconsumed-queue age',
  /readEligibleUnstartedQueueAgeSeconds\(ORDER_SYNC_JOB_NAME\)/.test(wd)
  && /readEligibleUnstartedQueueAgeSeconds\(SHIPMENT_SYNC_JOB_NAME\)/.test(wd));
check('the unconsumed age is recorded on the action for operators',
  /details: \{ \.\.\.enqueued, unconsumedForSeconds \}/.test(wd));
check('a failure reading the queue age cannot break recovery',
  /readEligibleUnstartedQueueAgeSeconds\([A-Z_]+\)\n\s*\.catch\(\(\) => null\)/.test(wd));
check('the queue-age query counts only ELIGIBLE, never-started jobs',
  /state = 'created'/.test(src) && /started_on IS NULL/.test(src) && /start_after <= now\(\)/.test(src));

if (failures > 0) {
  console.error(`\nFAIL PS-485 consumer leadership acquire guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-485 consumer leadership acquire guard');
