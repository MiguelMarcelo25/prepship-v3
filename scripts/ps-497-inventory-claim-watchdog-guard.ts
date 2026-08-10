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
import { hasRestartEligibleFailure, summarizeHealth } from './production-watchdog.mjs';

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
// These run the REAL exported predicate. They used to run a copy, and review defeated that
// by adding `|| check.name === 'Inventory claim backlog'` to the production function: every
// assertion stayed green because the copy was untouched. A copied safety predicate proves
// nothing about the code that runs.
check('a run failing ONLY on the claim alarm is not restart-eligible', () => {
  assert.equal(hasRestartEligibleFailure([healthy, claimAlarm(false)]), false,
    'restarting the API cannot move a stranded claim');
});
check('a real service failure IS still restart-eligible', () => {
  assert.equal(hasRestartEligibleFailure([{ name: 'Render /health/ready', ok: false }]), true,
    'the existing restart behaviour must be unchanged');
});
check('a service failure alongside the alarm is still restart-eligible', () => {
  assert.equal(
    hasRestartEligibleFailure([{ name: 'Render /health/ready', ok: false }, claimAlarm(false)]),
    true,
    'the alarm must not suppress a restart that something else earned',
  );
});
check('checks with no restartEligible flag stay eligible, so nothing pre-existing changed', () => {
  assert.equal(hasRestartEligibleFailure([{ name: 'Shipment sync freshness', ok: false }]), true);
});
check('a /health/deep failure alone is not restart-eligible', () => {
  assert.equal(hasRestartEligibleFailure([healthy, { name: 'Render /health/deep', ok: false }]), false);
});
check('the alarm failing on config-missing or transport error still never restarts', () => {
  assert.equal(hasRestartEligibleFailure([
    healthy,
    { name: 'Inventory claim backlog', ok: false, status: 'config-missing', restartEligible: false },
  ]), false);
  assert.equal(hasRestartEligibleFailure([
    healthy,
    { name: 'Inventory claim backlog', ok: false, status: 'error', restartEligible: false },
  ]), false);
});
check('everything healthy is not restart-eligible', () => {
  assert.equal(hasRestartEligibleFailure([healthy, claimAlarm(true)]), false);
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
  // The predicate's TERMS are no longer pinned by regex — the imported behavioural tests
  // above prove them by execution. These two assert only that main() still delegates, so an
  // inline copy cannot quietly reappear beside the export.
  check('main() gates restarts on the exported predicate', () => {
    assert.match(src, /const restartEligibleFailure = hasRestartEligibleFailure\(checks\)/);
    assert.match(src, /restartEligibleFailure\s*\r?\n?\s*\?\s*canRestart\(state, now\)/);
  });
  check('main() no longer carries its own inline restart predicate', () => {
    assert.doesNotMatch(src, /const restartEligibleFailure = checks\.some\(/,
      'an inline copy beside the export is how the two drift apart again');
  });
}

if (failures > 0) {
  console.error(`\nPS-497 inventory claim watchdog guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 inventory claim watchdog guard');
console.log('No network, no production, no restart triggered.');
