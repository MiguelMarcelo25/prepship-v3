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
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://postgres:test@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';

// The pause is parsed ONCE at startup, so it must be set before the module graph loads.
// Mutating process.env mid-run would silently do nothing — proving only that the test was
// written against a stale mental model. This process runs PAUSED; the active case is proved
// in a child process below, which is the only honest way to test a startup-parsed value.
const PAUSED_MODE = process.env.PS466_PAUSE_CHILD !== 'active';
if (PAUSED_MODE) process.env.AUTOMATION_EXECUTION_PAUSED = 'true';
else delete process.env.AUTOMATION_EXECUTION_PAUSED;

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

// The child half: prove the ACTIVE path in a process that started without the variable, then
// exit. Everything below this block runs only in the paused parent.
if (!PAUSED_MODE) {
  const store = orchestrator.createInMemoryAutomationExecutionStore();
  const result = await orchestrator.executeAutomationEvaluation({
    facts: { revision: 'active-facts', order: { id: 901, status: 'awaiting_shipment' } } as never,
    trigger: 'before_rate', sourceEventId: 'active-child', rules: [],
    store, handlers: {} as never, scope: { clientId: 1, storeId: 1 } as never,
  });
  if (result.status !== 'completed') throw new Error(`active child did not complete: ${result.status}`);
  if (pause.isAutomationExecutionPaused()) throw new Error('active child reported paused');
  console.log('ACTIVE-CHILD-OK');
  process.exit(0);
}

const ENV = pause.AUTOMATION_EXECUTION_PAUSED_ENV;
const { parseAutomationExecutionPaused } = pause;

// ── the control's grammar, from an EXPLICIT table ────────────────────────────
//
// The expected value is written out by hand, never computed with the same normalisation the
// case is meant to be checking. The previous version derived it from
// `raw.trim().toLowerCase() === 'true'`, so a case LABELLED "'True ' does not pause" actually
// asserted that it DOES pause — the printed label contradicted its own assertion and the
// suite still went green. That is the fifth instance of this trap on this card.
const GRAMMAR: Array<{ raw: string | undefined; paused: boolean; note: string }> = [
  { raw: undefined, paused: false, note: 'absent is the normal production state' },
  { raw: 'false', paused: false, note: 'explicit off' },
  { raw: 'FALSE', paused: false, note: 'case tolerant' },
  { raw: ' false ', paused: false, note: 'whitespace tolerant' },
  { raw: 'true', paused: true, note: 'explicit on' },
  { raw: 'TRUE', paused: true, note: 'case tolerant' },
  { raw: ' true ', paused: true, note: 'whitespace tolerant' },
];
for (const { raw, paused, note } of GRAMMAR) {
  check(`${JSON.stringify(raw)} -> ${paused ? 'PAUSED' : 'active'} (${note})`, () => {
    assert.equal(parseAutomationExecutionPaused(raw), paused);
  });
}

// A PRESENT malformed value must fail startup, not read as active. The dangerous failure on a
// safety control is an operator believing automation is paused while it is still executing.
for (const invalid of ['', '   ', 'tru', 'yes', 'no', '1', '0', 'paused', 'on', 'off', 'True!']) {
  check(`${JSON.stringify(invalid)} is rejected as invalid configuration`, () => {
    assert.throws(() => parseAutomationExecutionPaused(invalid), /must be exactly/);
  });
}

// ── the shared boundary refuses before ANY side effect ───────────────────────
const facts = {
  revision: 'pause-facts',
  order: { id: 900, status: 'awaiting_shipment' },
} as never;

await acheck('a paused process starts NO automation run, and touches no store', async () => {
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
});

await acheck('an UNPAUSED process runs the same call normally (child process)', async () => {
  // Startup-parsed means the only honest way to prove the active path is a second process
  // with the variable absent. Asserting it in-process would be asserting against a value
  // this process can no longer change.
  if (!PAUSED_MODE) return;
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--import', 'tsx', process.argv[1]!], {
    env: (() => { const e = { ...process.env, PS466_PAUSE_CHILD: 'active' }; delete e.AUTOMATION_EXECUTION_PAUSED; return e; })(),
    encoding: 'utf8',
  });
  assert.match(out, /ACTIVE-CHILD-OK/, 'an unpaused child must execute automation normally');
});

// ── it fails BEFORE provider work, which is the point ────────────────────────
await acheck('rate and label preflight are refused before any carrier work', async () => {
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
});

// ── the REAL startup authority, proved across process boundaries ────────────
//
// The grammar cases above exercise the canonical parser. These prove that src/lib/env.ts
// actually uses it — that production's authority and the tested authority are the same one.
//
// This matters because there were briefly two implementations: a Zod superRefine in env.ts
// and a hand-written copy beside the runtime check. Production used the Zod one; the tests
// used the other. A mutation loosening only the schema would have left production failing
// open with the suite green. Nothing short of loading the real env module proves that cannot
// happen.
await acheck('the real env module enforces the grammar at STARTUP', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = [
    '--import', 'tsx', '-e',
    "import('./src/lib/env.js').then((m) => { console.log('PAUSED=' + (m.env.AUTOMATION_EXECUTION_PAUSED === true)); }).catch(() => process.exit(3));",
  ];
  const run = (value: string | undefined) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (value === undefined) delete childEnv.AUTOMATION_EXECUTION_PAUSED;
    else childEnv.AUTOMATION_EXECUTION_PAUSED = value;
    try {
      return { ok: true, out: execFileSync(process.execPath, probe, { env: childEnv, encoding: 'utf8', stdio: 'pipe' }) };
    } catch {
      return { ok: false, out: '' };
    }
  };

  const absent = run(undefined);
  assert.ok(absent.ok && /PAUSED=false/.test(absent.out), 'absent must start ACTIVE');

  const off = run('false');
  assert.ok(off.ok && /PAUSED=false/.test(off.out), "'false' must start ACTIVE");

  const on = run('true');
  assert.ok(on.ok && /PAUSED=true/.test(on.out), "'true' must start PAUSED");

  // A present blank is NOT absent. It is a plausible misconfiguration — a cleared dashboard
  // field, an empty deploy-template substitution — and on a safety control it would leave an
  // operator believing automation was paused while it kept running.
  assert.equal(run('').ok, false, 'a blank configured value must FAIL STARTUP, not read as off');
  assert.equal(run('   ').ok, false, 'whitespace-only must fail startup too');
  assert.equal(run('tru').ok, false, 'a typo must fail startup');
  assert.equal(run('yes').ok, false, "'yes' must fail startup");
  assert.equal(run('1').ok, false, "'1' must fail startup");
});

// ── the refusal carries a machine-readable contract ─────────────────────────
//
// Without an explicit code the manual route's errorResponse() falls through to a generic 400
// and the label-route mapper, which keys on AUTOMATION_* codes, cannot recognise it. An
// operator pausing for cutover would then see an indistinguishable "Automation request
// failed" on every ingress.
await acheck('a paused refusal carries a stable code and a deliberate status', async () => {
  const thrown = await orchestrator.executeAutomationEvaluation({
    facts, trigger: 'before_rate', sourceEventId: 'pause-contract', rules: [],
    store: orchestrator.createInMemoryAutomationExecutionStore(),
    handlers: {} as never, scope: { clientId: 1, storeId: 1 } as never,
  }).then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof pause.AutomationExecutionPausedError);
  assert.equal(thrown.code, 'AUTOMATION_EXECUTION_PAUSED', 'route mappers key on this exact code');
  assert.equal(thrown.code, pause.AUTOMATION_EXECUTION_PAUSED_CODE);
  assert.equal(thrown.status, 409, 'deliberate, retryable refusal — not a generic 400');
  assert.equal(thrown.retryable, true);
  assert.match(thrown.code, /^AUTOMATION_/, 'the label-route mapper matches on the AUTOMATION_ prefix');
});

check('the manual route maps the paused error before its generic fallback', () => {
  const src = readFileSync('src/routes/automations.ts', 'utf8');
  const mapper = src.indexOf('function errorResponse');
  const paused = src.indexOf('AutomationExecutionPausedError', mapper);
  const fallback = src.indexOf("'Automation request failed'", mapper);
  assert.ok(paused > -1, 'the mapper must recognise the paused error');
  assert.ok(paused < fallback, 'and must do so before the generic 400 fallback');
});

// ── every synchronous ingress returns the SAME contract ─────────────────────
//
// Review found that before_rate did not. src/routes/rates.ts handled only ShopifyRatesError
// and fell through to reportError('rate.shopify.failed') + HTTP 500 — so a deliberate pause
// looked like a broken rating integration, and the "stable contract across ingresses" claim
// held on the manual and label routes but silently not here.
//
// These execute each route's real mapping logic against the real error object. The mapping is
// the authority under test; the surrounding HTTP plumbing is not.
{
  const paused = new pause.AutomationExecutionPausedError();

  check('the LABEL route maps any AUTOMATION_ code to a deliberate 409', () => {
    const src = readFileSync('src/routes/labels.ts', 'utf8');
    assert.match(src, /e\.code\.startsWith\('AUTOMATION_'\)/,
      'the label mapper keys on the AUTOMATION_ prefix');
    // The contract only holds if the error actually carries such a code.
    assert.ok(paused.code.startsWith('AUTOMATION_'),
      'the paused error must satisfy the prefix the label route already matches on');
    assert.equal(paused.status, 409, 'and agree with the 409 that mapper returns');
  });

  check('the RATE route maps the paused code before its generic 500', () => {
    const src = readFileSync('src/routes/rates.ts', 'utf8');
    const mapper = src.indexOf('rate.shopify.rejected');
    const automation = src.indexOf("startsWith('AUTOMATION_')", mapper);
    const genericFail = src.indexOf("reportError('rate.shopify.failed'", mapper);
    assert.ok(automation > -1, 'the rate route must recognise an automation code');
    assert.ok(
      automation < genericFail,
      'and must do so BEFORE the generic 500, or a deliberate pause is reported as a rate failure',
    );
  });

  check('a deliberate pause is never logged as a rate failure', () => {
    const src = readFileSync('src/routes/rates.ts', 'utf8');
    const automation = src.indexOf("startsWith('AUTOMATION_')");
    const block = src.slice(automation, src.indexOf("reportError('rate.shopify.failed'", automation));
    assert.ok(!block.includes("reportError('rate.shopify.failed'"),
      'the paused branch must return before the failure report');
    assert.match(block, /rate\.shopify\.automation_paused/,
      'and should record the pause distinctly from a failure');
  });

  check('all three ingresses agree on one code and one status', () => {
    assert.equal(paused.code, 'AUTOMATION_EXECUTION_PAUSED');
    assert.equal(paused.status, 409);
    assert.equal(paused.retryable, true);
  });
}

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
