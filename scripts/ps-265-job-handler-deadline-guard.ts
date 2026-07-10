/**
 * PS-265 guard — a hung job handler can't deadlock the worker.
 *
 * Root cause: registerWorker held a single in-process mutex; if a
 * handler's promise never settled (a hung ShipStation call), the finally that
 * clears the mutex never ran → every later job skipped forever until a restart.
 * Fix: every handler is bounded by withDeadline, so a hang REJECTS → the existing
 * catch/finally runs → the mutex releases → the next tick proceeds (the sync is
 * watermark-based + idempotent, so the missed window is re-pulled, no data loss).
 *
 * This guard unit-tests withDeadline and statically proves the handler is bounded
 * and the mutex is always released.
 *
 *   npx tsx scripts/ps-265-job-handler-deadline-guard.ts
 */
import { readFileSync } from 'node:fs';
import { withDeadline, DeadlineExceededError } from '../src/lib/with-deadline';

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

  // ── Static contract: the worker bounds the handler + always releases the mutex ──
  const q = read('src/services/sync-job-queue.ts');
  check('sync-job-queue imports withDeadline', /import \{ withDeadline \} from '\.\.\/lib\/with-deadline'/.test(q));
  check('handler is wrapped in withDeadline',
    /await withDeadline\(\s*\(\) => handler\(job\?\.data\),\s*JOB_HANDLER_TIMEOUT_MS,\s*name,?\s*\)/.test(q));
  check('active lane is cleared in finally (always released on timeout)',
    /finally \{\s*if \(activeJobsByLane\.get\(lane\) === name\) activeJobsByLane\.delete\(lane\);\s*\}/.test(q));
  check('deadline is clamped BELOW the pg-boss expiry (25min < 30min)',
    /25 \* 60_000/.test(q) && /expireInMinutes:\s*30/.test(q));

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
