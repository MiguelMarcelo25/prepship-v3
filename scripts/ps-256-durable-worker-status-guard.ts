/**
 * PS-256 (durable runtime state) guard — DURABLE WORKER-STATUS EVENTS.
 *
 * A durable, append-only worker_status_events log so worker liveness / staleness survives a
 * restart (operators can answer "was the worker stuck 14:32-15:17?"). ENV-GATED, default OFF
 * (WORKER_STATUS_EVENTS_DURABLE); the OFF path is a TRUE no-op — no DB, no schema ensure.
 *
 * BEHAVIORAL: with the flag OFF, recordWorkerStatusEvent resolves (no throw) WITHOUT touching
 * the DB, and readWorkerStatusEvents returns []. We point DATABASE_URL at a bogus host first,
 * so if the OFF path wrongly issued a query it would error/hang — a clean resolve + [] proves
 * the no-op without needing a live DB.
 * STATIC: the module runtime-ensures the table (additive, 500-safe) + has the env gate; the
 * worker-status hot paths emit on heartbeat + job start/complete/failed; the watchdog emits a
 * staleness_alert; env.ts declares the flag; the route exposes the admin-gated history endpoint.
 *
 *   npx tsx scripts/ps-256-durable-worker-status-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: flag OFF => true no-op (no DB), resolves + returns [] ──────────────────────────
// Force the flag off and make any accidental DB use fail loudly before importing the module.
process.env.WORKER_STATUS_EVENTS_DURABLE = 'false';
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/ps256_guard_should_not_connect';

const mod = await import('../src/services/worker-status-events.js');

check('flag defaults OFF (workerStatusEventsEnabled() === false)', mod.workerStatusEventsEnabled() === false);

let emitThrew = false;
const emitStart = Date.now();
try {
  await mod.recordWorkerStatusEvent({
    service: 'worker',
    pid: 1234,
    eventType: 'heartbeat',
    details: { from: 'ps-256-guard' },
  });
} catch {
  emitThrew = true;
}
check('recordWorkerStatusEvent resolves without throwing when OFF', !emitThrew);
check('recordWorkerStatusEvent is a fast no-op when OFF (no DB connect)', Date.now() - emitStart < 500);

let readThrew = false;
let readResult: unknown = 'unset';
const readStart = Date.now();
try {
  readResult = await mod.readWorkerStatusEvents({ limit: 10 });
} catch {
  readThrew = true;
}
check('readWorkerStatusEvents resolves without throwing when OFF', !readThrew);
check('readWorkerStatusEvents returns [] when OFF (no DB touched)',
  Array.isArray(readResult) && (readResult as unknown[]).length === 0);
check('readWorkerStatusEvents is a fast no-op when OFF (no DB connect)', Date.now() - readStart < 500);

// ── static: durable module — runtime DDL + env gate + best-effort emit ─────────────────────────
const events = readFileSync('src/services/worker-status-events.ts', 'utf8');
const runtimeSchemaMigration = readFileSync('drizzle/0062_runtime_schema_ownership.sql', 'utf8');
check('migration owns worker_status_events and runtime verifies readiness',
  /CREATE TABLE IF NOT EXISTS worker_status_events/.test(runtimeSchemaMigration) &&
    /ensureWorkerStatusEventsSchema/.test(events) && /assertRuntimeSchemaReady/.test(events));
check('indexes created_at DESC for recent-first reads',
  /CREATE INDEX IF NOT EXISTS worker_status_events_created_at_idx[\s\S]*created_at DESC/.test(runtimeSchemaMigration));
check('env-gated via workerStatusEventsEnabled() + WORKER_STATUS_EVENTS_DURABLE',
  /workerStatusEventsEnabled/.test(events) && /WORKER_STATUS_EVENTS_DURABLE/.test(events));
check('recordWorkerStatusEvent returns early (no-op) when the flag is OFF',
  /if \(!workerStatusEventsEnabled\(\)\) return/.test(events));
check('emit is best-effort (try/catch, never throws into the hot path)',
  /try \{[\s\S]*INSERT INTO worker_status_events[\s\S]*\} catch/.test(events));

// ── static: worker-status.ts emits on heartbeat + all job transitions ──────────────────────────
const workerStatus = readFileSync('src/services/worker-status.ts', 'utf8');
check('worker-status imports recordWorkerStatusEvent',
  /import \{ recordWorkerStatusEvent \} from '\.\/worker-status-events'/.test(workerStatus));
check("emits 'heartbeat' on recordWorkerHeartbeat",
  /recordWorkerStatusEvent\(\{[\s\S]*eventType: 'heartbeat'/.test(workerStatus));
check("emits 'job_start' on recordWorkerJobStart",
  /recordWorkerStatusEvent\(\{[\s\S]*eventType: 'job_start'/.test(workerStatus));
check("emits 'job_complete' on recordWorkerJobSuccess",
  /recordWorkerStatusEvent\(\{[\s\S]*eventType: 'job_complete'/.test(workerStatus));
check("emits 'job_failed' on recordWorkerJobFailure",
  /recordWorkerStatusEvent\(\{[\s\S]*eventType: 'job_failed'/.test(workerStatus));

// ── static: watchdog emits a staleness_alert ───────────────────────────────────────────────────
check('worker-status imports withDeadline for bounded snapshot persistence',
  /import \{ withDeadline \} from '\.\.\/lib\/with-deadline'/.test(workerStatus));
check('worker-status snapshot persist has a short deadline',
  /WORKER_STATUS_PERSIST_TIMEOUT_MS/.test(workerStatus) &&
  /Math\.min\(5_000/.test(workerStatus) &&
  /await withDeadline\([\s\S]*'worker-status persist'/.test(workerStatus));
check('worker-status persist is single-flight so hung writes cannot pile up',
  /let persistSnapshotInFlight: Promise<void> \| null = null;/.test(workerStatus) &&
  /if \(persistSnapshotInFlight\)/.test(workerStatus) &&
  /persistSnapshotInFlight = tracked/.test(workerStatus));
check('worker-status abandons stale in-flight persists so heartbeats can recover',
  /WORKER_STATUS_PERSIST_ABANDON_MS/.test(workerStatus) &&
  /let persistSnapshotStartedAtMs = 0;/.test(workerStatus) &&
  /ageMs < WORKER_STATUS_PERSIST_ABANDON_MS/.test(workerStatus) &&
  /abandoning stale status persist/.test(workerStatus));
// cdf066f5 ("Keep print worker status separate") split the snapshot into a per-mode key
// plus a scheduler-gated legacy WORKER_STATUS_KEY write, both inside the deferred
// single-flight IIFE where `await` is syntactically required — so the old naive negative
// substring can no longer distinguish hot-path blocking from the bounded persist lane.
check('worker-status writes the legacy WORKER_STATUS_KEY exactly once, only inside the bounded scheduler-gated persist lane (never a direct sync-hot-path await)',
  (workerStatus.match(/await setSetting\(WORKER_STATUS_KEY/g) ?? []).length === 1 &&
  /tracked = \(async \(\) => \{[\s\S]*?if \(snapshot\.schedulerEnabled\) \{\s*await setSetting\(WORKER_STATUS_KEY, serialized\);\s*\}[\s\S]*?\}\)\(\)/.test(workerStatus) &&
  /persistSnapshotInFlight = tracked;/.test(workerStatus) &&
  /await withDeadline\(\s*\(\) => tracked,\s*WORKER_STATUS_PERSIST_TIMEOUT_MS/.test(workerStatus));
check('worker-status documents observability must not hold sync lanes',
  /Worker status is observability\. A slow settings write must not hold sync lanes\./.test(workerStatus));

const watchdog = readFileSync('src/services/sync-staleness-watchdog.ts', 'utf8');
check('watchdog emits a staleness_alert when a verdict alerts',
  /recordWorkerStatusEvent\(\{[\s\S]*eventType: 'staleness_alert'/.test(watchdog) &&
  /stalenessLevel: verdict\.level/.test(watchdog));

// ── static: env.ts declares the flag (default OFF) ─────────────────────────────────────────────
const envSrc = readFileSync('src/lib/env.ts', 'utf8');
check('env.ts declares WORKER_STATUS_EVENTS_DURABLE default OFF',
  /WORKER_STATUS_EVENTS_DURABLE: booleanFlag\(false\)/.test(envSrc));

// ── static: route exposes the admin-gated history endpoint ─────────────────────────────────────
const route = readFileSync('src/routes/worker.ts', 'utf8');
check('worker route exposes GET /status-history reading readWorkerStatusEvents',
  /app\.get\('\/status-history'[\s\S]*readWorkerStatusEvents/.test(route));
check('history endpoint is admin-gated (requireAdmin)',
  /app\.get\('\/status-history', requireAdmin/.test(route));

// ── static: package.json wires the guard ───────────────────────────────────────────────────────
check('package.json wires test:ps-256-durable-worker-status',
  /test:ps-256-durable-worker-status/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-256 durable worker-status guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-256 durable worker-status guard');
