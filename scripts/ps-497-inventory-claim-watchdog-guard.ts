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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The watchdog reads its config from the environment at MODULE LOAD, so the secret must exist
// before the module is evaluated. Static imports are hoisted above statements, so this uses a
// dynamic import — otherwise every behavioural case below would take the `config-missing`
// branch and pass without ever reaching the code under test.
process.env.WATCHDOG_CRON_SECRET ||= 'guard-only-not-a-real-secret';
const {
  checkInventoryClaimAlarm,
  hasRestartEligibleFailure,
  readState,
  summarizeHealth,
  writeState,
} = await import('./production-watchdog.mjs');

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

// ── the check itself, EXECUTED against a stubbed endpoint ────────────────────
//
// This block replaces two source-text assertions that pinned the previous placement: that the
// check read `body?.verdict` and never mentioned `reviewCount`. The placement rule they stood
// for — the watchdog must not own the alarm rule — has NOT been relaxed. What changed is how
// it is satisfied: the rule now lives in the pure detector, which the watchdog imports and
// runs, because the detector is stateful across runs and this process owns the state file
// while the route is stateless. Reading source text could never have proven that delegation,
// so these cases run the real function instead.

const NOW = 1_760_000_000_000;
const POLICIES = {
  shipment_sync: { class: 'fixed' },
  order_sync_status: { class: 'open_incident', baselineRatio: 1, saturated: true },
};
const detectorInputs = (over: Record<string, unknown> = {}) => ({
  completedWindows: [],
  severity: { reviewCount: 100, oldestAgeDays: 1, acknowledgedNewEvents24h: 10 },
  immediateReasons: [],
  policies: POLICIES,
  ...over,
});

/** Stub the network. No production endpoint is contacted by this guard. */
function withStubbedFetch<T>(status: number, body: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
  return run().finally(() => { globalThis.fetch = original; });
}

const URL_UNDER_TEST = 'https://example.invalid/cron/inventory-claim-watchdog/status';

async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await acheck('a quiet backlog leaves the check green', async () => {
  const result = await withStubbedFetch(200, { detector: detectorInputs() }, () =>
    checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(result.check.ok, true);
  assert.equal(result.check.restartEligible, false);
});

await acheck('an immediate regression on a repaired path makes the check red', async () => {
  const result = await withStubbedFetch(200, {
    detector: detectorInputs({
      immediateReasons: [{ code: 'inventory_claim.fixed_regression.shipment_sync', message: 'x' }],
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(result.check.ok, false, 'one stranded event on a repaired path is the alarm');
  assert.equal(result.check.restartEligible, false, 'and still must never restart');
});

await acheck('a saturated path crossing an absolute threshold makes the check red', async () => {
  // The exact case the old 1.5x rule could not reach: baseline already 1.0, so only absolute
  // severity can see this. If the watchdog were still trusting the legacy rollup verdict,
  // this would come back green.
  const result = await withStubbedFetch(200, {
    detector: detectorInputs({
      severity: { reviewCount: 5000, oldestAgeDays: 40, acknowledgedNewEvents24h: 500 },
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(result.check.ok, false);
  assert.match(result.check.details.reasons, /open_volume_24h/);
});

await acheck('the check returns advanced detector state for the caller to persist', async () => {
  const result = await withStubbedFetch(200, {
    detector: detectorInputs({
      severity: { reviewCount: 3200, oldestAgeDays: 2, acknowledgedNewEvents24h: 10 },
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(result.nextState.lastCountMilestone, 3000,
    'without a returned state the same milestone pages on every run, forever');
  assert.equal(result.nextState.lastReviewCount, 3200);
});

await acheck('a milestone already recorded in state does not page again', async () => {
  const first = await withStubbedFetch(200, {
    detector: detectorInputs({
      severity: { reviewCount: 3200, oldestAgeDays: 2, acknowledgedNewEvents24h: 10 },
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(first.check.ok, false, 'the first crossing pages');
  const second = await withStubbedFetch(200, {
    detector: detectorInputs({
      severity: { reviewCount: 3200, oldestAgeDays: 2, acknowledgedNewEvents24h: 10 },
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, first.nextState, NOW + 3_600_000));
  assert.equal(second.check.ok, true, 'the state carried forward suppresses the repeat');
});

await acheck('a malformed payload fails the check instead of passing quietly', async () => {
  for (const body of [null, {}, { detector: {} }, { detector: { completedWindows: [] } }]) {
    const result = await withStubbedFetch(200, body, () =>
      checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
    assert.equal(result.check.ok, false, `"could not measure" must never read as "nothing wrong": ${JSON.stringify(body)}`);
    assert.equal(result.check.restartEligible, false);
    assert.equal(result.nextState, null, 'and must not advance state from a payload it could not read');
  }
});

await acheck('a non-2xx response fails the check', async () => {
  const result = await withStubbedFetch(500, { detector: detectorInputs() }, () =>
    checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.equal(result.check.ok, false);
  assert.equal(result.check.restartEligible, false);
});

await acheck('a transport failure fails the check and never restarts', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
  try {
    const result = await checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.restartEligible, false);
    assert.equal(result.nextState, null);
  } finally {
    globalThis.fetch = original;
  }
});

await acheck('reported details carry stable reason codes and no free prose', async () => {
  const result = await withStubbedFetch(200, {
    detector: detectorInputs({
      severity: { reviewCount: 5000, oldestAgeDays: 40, acknowledgedNewEvents24h: 500 },
    }),
  }, () => checkInventoryClaimAlarm(URL_UNDER_TEST, null, NOW));
  assert.ok(!/\s/.test(result.check.details.reasons),
    'prose in the details churns the alert dedupe key and defeats the cooldown');
});

// ── the wiring, which execution cannot reach ─────────────────────────────────
{
  const src = readFileSync('scripts/production-watchdog.mjs', 'utf8');
  check('the watchdog actually calls the claim alarm check', () => {
    assert.match(src, /const result = await checkInventoryClaimAlarm\(/);
    assert.match(src, /checks\.push\(result\.check\)/);
  });
  check('the alarm rule is imported, not re-implemented here', () => {
    assert.match(src, /import \{[\s\S]*?evaluateClaimAlarm[\s\S]*?\} from '\.\.\/src\/services\/inventory-claim-alarm-detector\.mjs'/,
      'the decision must come from the pure detector');
    const start = src.indexOf('export async function checkInventoryClaimAlarm');
    const body = src.slice(start, src.indexOf('async function runChecks'));
    assert.match(body, /evaluateClaimAlarm\(\{/, 'and the check must actually call it');
    // No threshold of its own. HTTP status bounds are the only numeric comparison allowed.
    const comparisons = body.match(/[<>]=?\s*\d+(\.\d+)?/g) || [];
    assert.deepEqual(
      comparisons.filter((c) => !/(200|300)$/.test(c)), [],
      `the watchdog must own no alarm threshold, found: ${comparisons.join(' ')}`,
    );
  });
  check('main() persists the advanced detector state', () => {
    assert.match(src, /state\.inventoryClaimAlarm = claimAlarm\.nextState/,
      'an advance that is never written back replays the same days forever');
    assert.match(src, /inventoryClaimAlarm:\s*\r?\n?\s*parsed\.inventoryClaimAlarm/,
      'readState rebuilds a fixed shape, so an unlisted key is silently dropped on every run');
  });
  // PS-497: the assertion above reads SOURCE, and this repo has already been bitten once by a
  // guard that could be satisfied without the behaviour holding. The immediate-finding ledger
  // is nested inside `inventoryClaimAlarm`, so it survives only because that key is passed
  // through wholesale. Prove it by actually writing and re-reading a state file: if someone
  // later rebuilds the alarm state field-by-field, the ledger dies and the watchdog silently
  // returns to paging every hour — green tests, dead alarm.
  check('the immediate-finding ledger survives a real state-file round trip', () => {
    const statePath = join(
      mkdtempSync(join(tmpdir(), 'ps505-watchdog-state-')),
      'production-watchdog-state.json',
    );
    const advanced = {
      version: 1,
      perSource: { shipment_sync: { ewma: 0.25, lastProcessedWindowKey: '2026-08-11' } },
      immediate: {
        'inventory_claim.fixed_regression.shipment_sync': {
          firstSeenMs: 1_760_000_000_000,
          lastPagedMs: 1_760_000_000_000,
          occurrences: 7,
        },
      },
      lastCountMilestone: 3000,
    };

    writeState(statePath, { consecutiveFailures: 4, inventoryClaimAlarm: advanced });
    const reloaded = readState(statePath);

    assert.deepEqual(
      reloaded.inventoryClaimAlarm, advanced,
      'the detector state must survive the file verbatim, ledger and all',
    );
    assert.equal(
      reloaded.inventoryClaimAlarm.immediate[
        'inventory_claim.fixed_regression.shipment_sync'
      ].occurrences,
      7,
      'a dropped ledger re-pages every known finding on every hourly run',
    );
  });
  check('the check declares itself restart-ineligible on every return path', () => {
    const start = src.indexOf('export async function checkInventoryClaimAlarm');
    const body = src.slice(start, src.indexOf('async function runChecks'));
    const returns = (body.match(/restartEligible/g) || []).length;
    const flags = (body.match(/restartEligible: false/g) || []).length;
    assert.equal(flags, returns,
      `every restartEligible must be false: ${flags} of ${returns}`);
    assert.equal(flags, 4, 'four return paths: config-missing, invalid payload, verdict, error');
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
