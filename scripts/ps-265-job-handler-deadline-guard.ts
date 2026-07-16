/**
 * PS-265 guard — a hung job handler can't deadlock the worker.
 *
 * Root cause: registerWorker held a single in-process mutex; if a
 * handler's promise never settled (a hung ShipStation call), the finally that
 * clears the mutex never ran → every later job skipped forever until a restart.
 * Fix: every handler is bounded by withDeadline, and the queue keeps lane ownership
 * attached to the original handler promise. A deadline rejects the pg-boss attempt,
 * but the next tick cannot overlap a still-running abandoned handler in the same lane.
 *
 * This guard unit-tests withDeadline and proves the handler is bounded while lane
 * ownership releases only when the original handler actually settles.
 *
 *   npx tsx scripts/ps-265-job-handler-deadline-guard.ts
 */
import { readFileSync } from 'node:fs';
import { withDeadline, DeadlineExceededError } from '../src/lib/with-deadline';
import { awaitCancellationAcknowledgement } from '../src/lib/sync-job-cancellation';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

async function main() {
  // 1. A never-resolving handler rejects with DeadlineExceededError near the deadline.
  const start = Date.now();
  let timedOut = false;
  try {
    await withDeadline(() => new Promise<void>(() => { /* never settles */ }), 80, 'prepship.sync.shipments');
  } catch (err) {
    timedOut = err instanceof DeadlineExceededError;
  }
  const elapsed = Date.now() - start;
  check('hung handler rejects with DeadlineExceededError', timedOut);
  check('rejection fires near the deadline (not hung)', elapsed >= 60 && elapsed < 2000);

  // 2. Fast work resolves with its value, before the deadline.
  const value = await withDeadline(async () => 'done', 1000, 'fast');
  check('fast handler resolves with its value', value === 'done');

  // 3. A handler that throws propagates its own error (not a deadline error).
  let sawRealError = false;
  try {
    await withDeadline(async () => { throw new Error('boom'); }, 1000, 'thrower');
  } catch (err) {
    sawRealError = err instanceof Error && err.message === 'boom';
  }
  check('a throwing handler propagates its real error', sawRealError);

  let timeoutHookCalled = false;
  try {
    await withDeadline(
      () => new Promise<void>(() => { /* never settles */ }),
      80,
      'abortable',
      { onTimeout: () => { timeoutHookCalled = true; } },
    );
  } catch {
    // Expected deadline.
  }
  check('deadline invokes cooperative cancellation hook', timeoutHookCalled);

  let callbackFailureKeptDeadline = false;
  try {
    await withDeadline(
      () => new Promise<void>(() => { /* never settles */ }),
      80,
      'abort-hook-failure',
      { onTimeout: () => { throw new Error('abort hook failed'); } },
    );
  } catch (err) {
    callbackFailureKeptDeadline = err instanceof DeadlineExceededError;
  }
  check('cancellation hook failure still rejects with deadline error', callbackFailureKeptDeadline);

  // 4. A never-settling handler gets only a bounded cancellation grace. The
  // queue owner still holds the advisory lane while this verdict is produced;
  // an unacknowledged verdict therefore triggers fail-closed worker recovery.
  const neverSettles = new Promise<void>(() => undefined);
  const graceStartedAt = Date.now();
  const unacknowledged = await awaitCancellationAcknowledgement(neverSettles, 80);
  check('never-settling handler exhausts bounded cancellation grace', !unacknowledged.acknowledged);
  check('cancellation grace itself is bounded', Date.now() - graceStartedAt < 2_000);

  const cooperative = Promise.resolve();
  const acknowledged = await awaitCancellationAcknowledgement(cooperative, 80);
  check('cooperative handler acknowledges cancellation', acknowledged.acknowledged);

  // ── Static contract: the worker bounds the handler without releasing a zombie ──
  const q = read('src/services/sync-job-queue.ts');
  check(
    'sync-job-queue imports withDeadline',
    /import \{[^}]*\bwithDeadline\b[^}]*\} from '\.\.\/lib\/with-deadline'/.test(q),
  );
  check('handler is wrapped in withDeadline',
    /const handlerPromise = Promise\.resolve\(\)\.then\(\(\) =>\s*handler\(job\?\.data, \{ identity, signal: abortController\.signal \}\),?\s*\)[\s\S]*await withDeadline\(\s*\(\) => handlerPromise,[\s\S]*SYNC_JOB_HANDLER_TIMEOUT_MS[\s\S]*abortController\.abort\(error\)/.test(q));
  check('queue tracks the original handler promise outside the deadline race',
    /const handlerPromise = Promise\.resolve\(\)\.then\(\(\) =>\s*handler\(job\?\.data, \{ identity, signal: abortController\.signal \}\),?\s*\)/.test(q));
  check('active lane remains attached to the original handler promise',
    /void handlerPromise\.then\(clearActiveLane, clearActiveLane\)/.test(q));
  check('deadline waits only for bounded cancellation acknowledgement',
    /awaitCancellationAcknowledgement\([\s\S]*handlerPromise[\s\S]*SYNC_JOB_CANCELLATION_GRACE_MS/.test(q));
  check('unacknowledged cancellation terminates the worker while fenced',
    /terminateWorkerForUnacknowledgedCancellation/.test(q));
  check('deadline path does not unconditionally clear a still-running lane',
    !/finally \{\s*if \(activeJobsByLane\.get\(lane\) === name\) activeJobsByLane\.delete\(lane\);\s*\}/.test(q));
  check('deadline is clamped BELOW the pg-boss expiry (25min < 30min)',
    /25 \* 60_000/.test(read('src/lib/sync-job-deadline.ts')) && /expireInMinutes:\s*30/.test(q));
  check('order timeout closes only matching account attempt metadata',
    /markShipStationSyncRunFailed\(identity, Date\.now\(\), err\)/.test(q));

  const pkg = read('package.json');
  check('package.json wires test:ps-265-job-handler-deadline',
    /test:ps-265-job-handler-deadline/.test(pkg));

  if (failures > 0) {
    console.error(`\nFAIL PS-265 job-handler deadline guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-265 job-handler deadline guard');
}

main().catch((err) => { console.error('guard crashed:', err); process.exit(1); });
