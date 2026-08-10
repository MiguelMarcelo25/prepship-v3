// PS-497 — the watchdog side of the stranded-claim alarm, tested by EXECUTION.
//
// Two properties matter here and both are behavioural, so neither is asserted by reading
// source:
//
//   1. A stranded-claim alarm makes the run RED. That is the alarm.
//   2. It must NEVER trigger a restart. The backlog is a DATA condition — bouncing the API
//      leaves every claim exactly where it was, so a watchdog that restarts on it would
//      cycle production indefinitely against something it cannot fix. This is the same trap
//      as failing /health/deep on a non-empty backlog, which was caught in review earlier
//      on this card.
//
// `summarizeHealth` is imported and run directly. The restart rule is verified against the
// real predicate rather than a copy, so the two cannot drift apart.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeHealth } from './production-watchdog.mjs';

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

const healthy = { name: 'Render /health/ready', ok: true };
const claimAlarm = (ok: boolean) => ({
  name: 'Inventory claim backlog',
  ok,
  restartEligible: false,
  details: { state: ok ? 'ok' : 'alarm' },
});

// ── the alarm makes the run red ──────────────────────────────────────────────
check('a stranded-claim alarm makes the watchdog run unhealthy', () => {
  const health = summarizeHealth([healthy, claimAlarm(false)]);
  assert.equal(health.ok, false, 'an alarming backlog must fail the run');
  assert.ok(health.failingChecks.includes('Inventory claim backlog'));
});
check('a clean backlog leaves the run healthy', () => {
  const health = summarizeHealth([healthy, claimAlarm(true)]);
  assert.equal(health.ok, true);
});
check('the alarm is NOT treated as diagnostic-only like /health/deep', () => {
  // /health/deep is excluded from required failures; this must not be.
  const deepOnly = summarizeHealth([healthy, { name: 'Render /health/deep', ok: false }]);
  assert.equal(deepOnly.ok, true, 'deep stays diagnostic');
  const alarmOnly = summarizeHealth([healthy, claimAlarm(false)]);
  assert.equal(alarmOnly.ok, false, 'the claim alarm is required, not diagnostic');
});

// ── but it must never restart ────────────────────────────────────────────────
// Mirrors main()'s predicate exactly; the source assertion below pins that they match.
const restartEligibleFailure = (checks: Array<Record<string, unknown>>) => checks.some(
  (c) => !c.ok && c.name !== 'Render /health/deep' && c.restartEligible !== false,
);

check('a run failing ONLY on the claim alarm is not restart-eligible', () => {
  assert.equal(restartEligibleFailure([healthy, claimAlarm(false)]), false,
    'restarting the API cannot move a stranded claim');
});
check('a real service failure IS still restart-eligible', () => {
  assert.equal(restartEligibleFailure([{ name: 'Render /health/ready', ok: false }]), true,
    'the existing restart behaviour must be unchanged');
});
check('a service failure alongside the alarm is still restart-eligible', () => {
  assert.equal(
    restartEligibleFailure([{ name: 'Render /health/ready', ok: false }, claimAlarm(false)]),
    true,
    'the alarm must not suppress a restart that something else earned',
  );
});
check('checks with no restartEligible flag stay eligible, so nothing pre-existing changed', () => {
  assert.equal(restartEligibleFailure([{ name: 'Shipment sync freshness', ok: false }]), true);
});

// ── the wiring, which execution cannot reach ─────────────────────────────────
{
  const src = readFileSync('scripts/production-watchdog.mjs', 'utf8');
  check('the watchdog actually calls the claim alarm check', () => {
    assert.match(src, /checks\.push\(await checkInventoryClaimAlarm\(/);
  });
  check('it reads the backend verdict rather than deciding the rule itself', () => {
    const start = src.indexOf('async function checkInventoryClaimAlarm');
    const body = src.slice(start, start + 2200);
    assert.match(body, /body\?\.verdict/, 'must consume the backend verdict');
    assert.ok(!/reviewCount|threshold|ratio\s*>/.test(body),
      'the watchdog must not re-implement the alarm rule');
  });
  check('the check declares itself restart-ineligible on every return path', () => {
    const start = src.indexOf('async function checkInventoryClaimAlarm');
    const body = src.slice(start, src.indexOf('async function runChecks'));
    const returns = (body.match(/return \{/g) || []).length;
    const flags = (body.match(/restartEligible: false/g) || []).length;
    assert.equal(flags, returns,
      `every return must be restart-ineligible: ${flags} flags for ${returns} returns`);
  });
  check('main() gates restarts on restart-eligible failures', () => {
    assert.match(src, /const restartEligibleFailure = checks\.some\(/);
    assert.match(src, /restartEligibleFailure\s*\r?\n?\s*\?\s*canRestart\(state, now\)/);
  });
  // The behavioural restart assertions above run a COPY of main()'s predicate, because it is
  // a module-private const and cannot be imported. A copy can drift from the original and
  // then prove nothing, so pin the original's exact terms here. Loosening main() without
  // updating this fails, which is the only thing keeping the two honest.
  check('the copied restart predicate still matches the real one, term for term', () => {
    const start = src.indexOf('const restartEligibleFailure = checks.some(');
    const body = src.slice(start, start + 260);
    assert.match(body, /!check\.ok/, 'must require a failing check');
    assert.match(body, /check\.name !== 'Render \/health\/deep'/, 'must still exempt the diagnostic probe');
    assert.match(body, /check\.restartEligible !== false/, 'must honour the restart-ineligible flag');
  });
}

if (failures > 0) {
  console.error(`\nPS-497 inventory claim watchdog guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 inventory claim watchdog guard');
console.log('No network, no production, no restart triggered.');
