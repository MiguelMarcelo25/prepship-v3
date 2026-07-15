/**
 * PS-431 offline boundary guard. No DB connection, provider call, webhook,
 * label/postage action, marketplace notification, or production mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  shipmentSyncWatchdogAlertCandidate,
  shouldSendShipmentSyncWatchdogAlert,
} = await import('../src/services/shipment-sync-watchdog-alert');
const { createWorkerFailureBreaker } = await import('../src/services/worker-failure-breaker');
const {
  buildAlertPayload,
  shouldSendAlert,
  summarizeHealth,
} = await import('./production-watchdog.mjs');

const now = Date.parse('2026-07-15T08:00:00Z');
const alertOnly = shipmentSyncWatchdogAlertCandidate({
  state: 'worker_stale',
  verdictReason: 'worker heartbeat is stale',
  recovery: {
    action: 'alert_only',
    status: 'completed',
    at: new Date(now).toISOString(),
    reason: 'worker heartbeat is stale',
  },
});
assert.ok(alertOnly);
assert.equal(alertOnly.kind, 'alert_only');

const capExhausted = shipmentSyncWatchdogAlertCandidate({
  state: 'worker_stale',
  verdictReason: 'worker heartbeat is stale',
  recovery: {
    action: 'restart_worker',
    status: 'skipped',
    at: new Date(now).toISOString(),
    reason: 'max restarts per hour reached',
  },
});
assert.ok(capExhausted);
assert.equal(capExhausted.kind, 'restart_cap_exhausted');

const inAppState = { sentAtByKey: { [capExhausted.key]: now } };
assert.equal(
  shouldSendShipmentSyncWatchdogAlert(inAppState, capExhausted, now + 29 * 60_000, 30 * 60_000),
  false,
  'same in-app state is suppressed inside 30 minutes',
);
assert.equal(
  shouldSendShipmentSyncWatchdogAlert(inAppState, capExhausted, now + 30 * 60_000, 30 * 60_000),
  true,
  'same in-app state may alert again after 30 minutes',
);
assert.notEqual(alertOnly.key, capExhausted.key, 'alert-only and cap exhaustion are distinct states');

const checks = [
  { name: 'Render /health/ready', ok: false },
  { name: 'Render /health/deep', ok: true },
  { name: 'Shipment sync freshness', ok: true },
];
const health = summarizeHealth(checks);
assert.equal(health.ok, false, '/health/deep must not mask failed /health/ready');
assert.deepEqual(health.failingChecks, ['Render /health/ready']);

const externalState = { lastAlertsByState: {} };
const firstExternal = shouldSendAlert(
  externalState,
  health,
  now,
  30 * 60_000,
  'alert',
  'max restarts per hour reached',
);
assert.equal(firstExternal.send, true);
externalState.lastAlertsByState[firstExternal.key] = now;
assert.equal(
  shouldSendAlert(
    externalState,
    health,
    now + 29 * 60_000,
    30 * 60_000,
    'alert',
    'max restarts per hour reached',
  ).send,
  false,
  'same external state is suppressed inside 30 minutes',
);

const payload = buildAlertPayload({
  checks: [{
    name: 'Shipment sync freshness',
    ok: false,
    status: 'error',
    ms: 1,
    target: 'https://example.com/cron/shipment-sync-watchdog/status',
    error: 'Bearer abc token=secret https://private.example/path?key=secret',
  }],
  health: { ok: false, failingChecks: ['Shipment sync freshness'] },
  state: { consecutiveFailures: 1 },
  mode: 'alert-only',
  action: 'alert',
  reason: 'token=secret',
});
const serializedPayload = JSON.stringify(payload);
assert.doesNotMatch(serializedPayload, /Bearer abc|token=secret|private\.example/);
assert.match(serializedPayload, /manualAction/);

const exitCodes: number[] = [];
const recordFailure = createWorkerFailureBreaker(3, (code) => exitCodes.push(code));
assert.equal(recordFailure('unhandled_rejection').exitRequested, false);
assert.equal(recordFailure('uncaught_exception').exitRequested, false);
assert.equal(recordFailure('unhandled_rejection').exitRequested, true);
recordFailure('uncaught_exception');
assert.deepEqual(exitCodes, [1], 'repeated escaped failures request one unhealthy exit');

const read = (path: string): string => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-watchdog.yml');
const cronRoute = read('src/routes/cron.ts');
const watchdog = read('src/services/shipment-sync-watchdog.ts');
const runbook = read('docs/runbooks/ps-431-production-self-healing.md');
const ticket = read('docs/ps-tickets/ps-431-production-self-healing.md');

assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
assert.match(workflow, /actions\/cache\/restore@v4[\s\S]*actions\/cache\/save@v4/);
assert.match(workflow, /WATCHDOG_ALERT_WEBHOOK_URL[\s\S]*WATCHDOG_CRON_SECRET/);
assert.match(workflow, /WATCHDOG_ALLOW_RESTARTS:.*false/);
assert.match(cronRoute, /shipment-sync-watchdog\/status[\s\S]*readShipmentSyncWatchdogStatus/);
assert.match(watchdog, /notifyShipmentSyncWatchdogEscalation/);
assert.match(watchdog, /unlock shipped data on 2026-07-15/);
assert.match(runbook, /Render dashboard restart/);
assert.match(runbook, /workflow_dispatch/);
assert.match(runbook, /fullResync/);
assert.match(ticket, /Canonical owner/);
assert.match(ticket, /Live acceptance still required/);

console.log('PASS PS-431 production self-healing guard');
