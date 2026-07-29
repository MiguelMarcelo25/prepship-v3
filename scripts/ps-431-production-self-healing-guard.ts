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
  buildShipmentSyncWatchdogAlertPayload,
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

const inAppPayload = buildShipmentSyncWatchdogAlertPayload({
  state: 'worker_stale',
  verdictReason: 'worker heartbeat is stale',
  recovery: {
    action: 'alert_only',
    status: 'completed',
    at: new Date(now).toISOString(),
    reason: 'worker heartbeat is stale',
  },
  checkedAt: new Date(now).toISOString(),
  nowMs: now,
  source: 'timer',
}, alertOnly);
assert.equal(inAppPayload.content, inAppPayload.text, 'in-app alert supports Discord and Slack payloads');
assert.ok(inAppPayload.content.length <= 2_000, 'Discord alert content stays within its message limit');

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
assert.equal(payload.content, payload.text, 'external alert supports Discord and Slack payloads');
assert.ok(payload.content.length <= 2_000, 'Discord alert content stays within its message limit');

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

// 2026-07-29: repointed from the exact `*/5` cadence to "runs on SOME schedule".
//
// Stated plainly, this is a deliberate RELAXATION of frequency, not a rewording.
// PS-431's invariant is that the watchdog runs automatically, escalates to a
// phone-reachable webhook, keeps cooldown state, and never auto-restarts -- all
// still pinned below. The five-minute cadence was a choice layered on top, and
// it turned out to be actively harmful: at */5 this workflow plus sync-cron
// consumed essentially the whole GitHub Actions allowance, which blocked the
// deploy gate, so a health CHECK stopped health FIXES from shipping.
//
// The fast first-line alarm now lives in an external uptime monitor on
// /health/ready (stood up 2026-07-29), which is genuinely off-infrastructure --
// strictly better than a GitHub cron for detecting that production is down.
// This workflow stays as the deeper hourly check for the two things that
// monitor cannot see: the Vercel shell and the authenticated sync-freshness
// probe.
//
// What is still enforced: the workflow must be SCHEDULED, not manual-only. A
// watchdog nobody runs is the failure this guard exists to prevent.
assert.match(workflow, /schedule:\s*\n\s*- cron: '[^']+'/);
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
