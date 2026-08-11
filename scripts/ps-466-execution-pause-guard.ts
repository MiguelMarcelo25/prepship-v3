// PS-466 — the cutover pause control, executed.
//
// The fenced runtime protects new-binary workers from one another. It cannot fence a process
// still on the OLD binary: an old finish() updates by run id with no token predicate, and an
// old claimEffect() has no parent-run fence. During a rolling deploy an old process can
// therefore overwrite a run the new code has already reclaimed, and can still enter a handler.
//
// Stopping the worker is NOT a drain — stopAutomationOutboxWorker() clears its interval and
// returns without awaiting the pump already in flight. This control is what makes the cutover
// safe: new binaries refuse to start any automation while old ones roll away.

import { strict as assert } from 'node:assert';

process.env.DATABASE_URL ??= 'postgres://postgres:test@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const pause = await import('../src/services/automations/execution-pause.js');
const orchestrator = await import('../src/services/automations/orchestrator.js');

const ENV = pause.AUTOMATION_EXECUTION_PAUSED_ENV;

// ── the control only engages on an explicit affirmative ──────────────────────
// Default OFF matters as much as the pause itself: a typo must not silently halt production
// automation. Only the exact string turns it on.
check('absent means ACTIVE', () => {
  assert.equal(pause.isAutomationExecutionPaused(undefined), false);
});
for (const notPaused of ['', '   ', 'false', 'FALSE', '0', 'no', 'yes', 'paused', '1', 'True ']) {
  check(`"${notPaused}" does not pause`, () => {
    assert.equal(pause.isAutomationExecutionPaused(notPaused), notPaused.trim().toLowerCase() === 'true');
  });
}
check('"true" pauses', () => assert.equal(pause.isAutomationExecutionPaused('true'), true));
check('"TRUE" and " true " pause (case and whitespace tolerant)', () => {
  assert.equal(pause.isAutomationExecutionPaused('TRUE'), true);
  assert.equal(pause.isAutomationExecutionPaused(' true '), true);
});

// ── the shared boundary refuses before ANY side effect ───────────────────────
const facts = {
  revision: 'pause-facts',
  order: { id: 900, status: 'awaiting_shipment' },
} as never;

await acheck('a paused process starts NO automation run, and touches no store', async () => {
  process.env[ENV] = 'true';
  const store = orchestrator.createInMemoryAutomationExecutionStore();
  let storeTouched = 0;
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && prop !== 'effects' && prop !== 'states') {
        return (...args: unknown[]) => { storeTouched += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      }
      return value;
    },
  });
  let handlerCalls = 0;
  await assert.rejects(
    orchestrator.executeAutomationEvaluation({
      facts, trigger: 'before_rate', sourceEventId: 'pause-event', rules: [],
      store: spy as never,
      handlers: { 'tag.add': async () => { handlerCalls += 1; return {}; } } as never,
      scope: { clientId: 1, storeId: 1 } as never,
    }),
    (error: unknown) => error instanceof pause.AutomationExecutionPausedError,
    'the shared boundary must refuse while paused',
  );
  assert.equal(storeTouched, 0, 'no store call at all — not even findCompleted');
  assert.equal(handlerCalls, 0, 'and no handler may run');
  assert.equal(store.effects.length, 0);
  delete process.env[ENV];
});

await acheck('the same call succeeds once the pause is lifted', async () => {
  delete process.env[ENV];
  const store = orchestrator.createInMemoryAutomationExecutionStore();
  const result = await orchestrator.executeAutomationEvaluation({
    facts, trigger: 'before_rate', sourceEventId: 'pause-event-2', rules: [],
    store, handlers: {} as never, scope: { clientId: 1, storeId: 1 } as never,
  });
  assert.equal(result.status, 'completed', 'lifting the pause restores normal execution');
});

// ── it fails BEFORE provider work, which is the point ────────────────────────
await acheck('rate and label preflight are refused before any carrier work', async () => {
  process.env[ENV] = 'true';
  // reconcileOrderAutomationsForShipping routes both before_rate and before_label_purchase
  // through executeAutomationEvaluation, so a refusal here happens before carrier selection,
  // label purchase or postage spend.
  for (const stage of ['before_rate', 'before_label_purchase']) {
    await assert.rejects(
      orchestrator.executeAutomationEvaluation({
        facts, trigger: stage, sourceEventId: `pause-${stage}`, rules: [],
        store: orchestrator.createInMemoryAutomationExecutionStore(),
        handlers: {} as never, scope: { clientId: 1, storeId: 1 } as never,
      }),
      (error: unknown) => error instanceof pause.AutomationExecutionPausedError,
      `${stage} must fail closed while paused`,
    );
  }
  delete process.env[ENV];
});

// ── the outbox must refuse to CLAIM, not merely to evaluate ──────────────────
// Checking only inside evaluation would let each pass claim a row, fail, increment attempts,
// and eventually dead-letter genuine events for the duration of the cutover.
{
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/services/automations/outbox-worker.ts', 'utf8'));
  check('the pump checks the pause BEFORE claiming outbox work', () => {
    const pumpStart = src.indexOf('running = true;');
    const claimPoint = src.indexOf('processAutomationOutboxOnce()', pumpStart);
    const pauseCheck = src.indexOf('isAutomationExecutionPaused()', pumpStart);
    assert.ok(pauseCheck > -1, 'the pump must consult the pause');
    assert.ok(
      pauseCheck < claimPoint,
      'the check must precede the claim, or a long pause burns attempts and dead-letters events',
    );
  });
  check('the pump also skips the reaper while paused', () => {
    const pauseCheck = src.indexOf('isAutomationExecutionPaused()');
    const reap = src.indexOf('reapExpiredAutomationRuns()');
    assert.ok(pauseCheck < reap, 'a paused process must not recover runs either');
  });
}

if (failures > 0) {
  console.error(`\nPS-466 execution pause guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-466 execution pause guard');
console.log('No database, no network, no provider call, no postage.');
