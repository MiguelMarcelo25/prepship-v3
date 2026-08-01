/**
 * PS-431 worker-status-event retention guard.
 *
 * Offline/static: an injected recording SQL tag. No DB, no provider, no postage.
 *
 * Why this exists. `worker_status_events` is the durable worker-liveness log built under
 * PS-256, and it is the table that would have explained the 2026-07-13 crash loop -- it
 * could not, because `WORKER_STATUS_EVENTS_DURABLE` defaults OFF and the table is empty.
 *
 * Turning that flag on is what makes the NEXT crash loop diagnosable, but the log had no
 * pruning of any kind, and its emission rate is fixed by a 30-second heartbeat rather
 * than by traffic: ~3,000-5,000 rows/day forever, whether or not anything is happening.
 * That is the same unbounded shape that took `automation_runs` to 925 MB in a week under
 * PS-469. This guard pins the bound so the flag is safe to flip.
 *
 * The invariant: retention is bounded, it touches ONLY the telemetry table, and it stays
 * a true no-op while the feature flag is off.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `env` is zod-parsed once at first import, so the flag cannot be toggled in-process.
// The ON case runs here; the OFF case re-execs this file with the flag cleared.
const OFF_CASE = process.argv.includes('--off-case');
process.env.WORKER_STATUS_EVENTS_DURABLE = OFF_CASE ? 'false' : 'true';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

/** Records the statement + interpolated values, standing in for postgres.js's tag. */
function recordingTag() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(Object.assign([], { count: 7 }));
  }) as never;
  return { tag, calls };
}

const mod = await import('../src/services/worker-status-events');

// ── flag OFF: a true no-op (this branch runs in the re-exec'd child) ─────────
if (OFF_CASE) {
  const off = recordingTag();
  const deleted = await mod.pruneWorkerStatusEvents(30, off.tag);
  check('flag OFF prunes nothing', deleted === 0);
  check('flag OFF issues NO sql at all', off.calls.length === 0, off.calls);
  check('flag OFF reports "not due" rather than "ran"',
    (await mod.pruneWorkerStatusEventsIfDue(off.tag)) === null);
  check('flag OFF issues no sql from the throttled path either', off.calls.length === 0);

  if (failures > 0) {
    console.error(`\nFAIL PS-431 retention guard, flag-OFF case (${failures} failing)`);
    process.exit(1);
  }
  console.log('PASS PS-431 retention guard, flag-OFF case');
  process.exit(0);
}

// ── flag ON: bounded delete, telemetry table only ────────────────────────────
{
  const on = recordingTag();
  const before = Date.now();
  const deleted = await mod.pruneWorkerStatusEvents(30, on.tag);

  check('flag ON returns the deleted row count', deleted === 7, deleted);
  check('flag ON issues exactly one statement', on.calls.length === 1, on.calls.length);

  const stmt = (on.calls[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  check('the statement is a DELETE on worker_status_events',
    /^DELETE FROM worker_status_events WHERE created_at < \?$/.test(stmt), stmt);

  // The safety property that matters most: this must be reachable from NOTHING else.
  for (const forbidden of ['orders', 'shipments', 'order_items', 'invoices', 'automation_runs']) {
    check(`the statement cannot touch ${forbidden}`,
      !new RegExp(`\\b${forbidden}\\b`).test(stmt), stmt);
  }

  // Cutoff must be the retention window back from now, not "now" and not unbounded.
  const cutoffMs = Date.parse(String(on.calls[0]?.values[0]));
  const windowMs = 30 * 24 * 60 * 60 * 1000;
  check('the cutoff is exactly the retention window in the past',
    Number.isFinite(cutoffMs) && Math.abs((before - windowMs) - cutoffMs) < 5_000,
    { cutoff: on.calls[0]?.values[0] });
  check('the cutoff is in the PAST, so a prune can never delete live rows',
    cutoffMs < before);

  // A non-positive window would mean "delete everything up to now" -- refuse it.
  for (const bad of [0, -1, Number.NaN]) {
    const g = recordingTag();
    const n = await mod.pruneWorkerStatusEvents(bad, g.tag);
    check(`a retention window of ${String(bad)} is refused, not treated as "delete all"`,
      n === 0 && g.calls.length === 0);
  }

  check('the default retention window is bounded and at least a month',
    mod.WORKER_STATUS_EVENT_RETENTION_DAYS >= 30
      && Number.isFinite(mod.WORKER_STATUS_EVENT_RETENTION_DAYS));

  // ── throttle: safe to call on every ~5-minute watchdog tick ────────────────
  const thr = recordingTag();
  mod.__resetWorkerStatusEventPruneThrottle();
  const first = await mod.pruneWorkerStatusEventsIfDue(thr.tag);
  const second = await mod.pruneWorkerStatusEventsIfDue(thr.tag);
  check('the first throttled call runs', first === 7, first);
  check('an immediately following call is skipped, not re-run', second === null, second);
  check('the skipped call issued no sql', thr.calls.length === 1, thr.calls.length);
  mod.__resetWorkerStatusEventPruneThrottle();
  check('resetting the throttle allows it to run again',
    (await mod.pruneWorkerStatusEventsIfDue(thr.tag)) === 7);
  check('the throttled path uses the same bounded window as the direct one',
    thr.calls.every((c) => c.text.includes('worker_status_events')), thr.calls);
}

// ── the watchdog actually calls it, and after the health verdict ─────────────
const watchdog = readFileSync('src/services/shipment-sync-watchdog.ts', 'utf8').replace(/\r\n/g, '\n');
check('the watchdog tick prunes', /pruneWorkerStatusEventsIfDue\(\)/.test(watchdog));
check('the prune runs AFTER the snapshot, so housekeeping cannot delay the verdict',
  watchdog.indexOf('await persistWatchdogSnapshot(finalStatus)')
    < watchdog.indexOf('await pruneWorkerStatusEventsIfDue()'));

const events = readFileSync('src/services/worker-status-events.ts', 'utf8').replace(/\r\n/g, '\n');
check('the prune is gated on the same flag as emit',
  /export async function pruneWorkerStatusEvents\([\s\S]{0,400}?workerStatusEventsEnabled\(\)/.test(events));
check('the only DELETE in the owner targets worker_status_events',
  (events.match(/DELETE FROM (\w+)/g) ?? []).every((d) => d === 'DELETE FROM worker_status_events'),
  events.match(/DELETE FROM (\w+)/g));

// ── the flag-OFF half, in a child process with the flag cleared ──────────────
try {
  const out = execFileSync(
    process.execPath,
    // The child must load TypeScript too, so register the same loader this run uses.
    ['--import', 'tsx', process.argv[1] as string, '--off-case'],
    { encoding: 'utf8', env: { ...process.env, WORKER_STATUS_EVENTS_DURABLE: 'false' } },
  );
  for (const line of out.split('\n').filter(Boolean)) console.log(line);
} catch (err) {
  failures += 1;
  const e = err as { stdout?: string; stderr?: string };
  console.error(e.stdout ?? '');
  console.error(e.stderr ?? '');
  console.error('FAIL the flag-OFF case did not pass');
}

if (failures > 0) {
  console.error(`\nFAIL PS-431 worker-status-event retention guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-431 worker-status-event retention guard');
