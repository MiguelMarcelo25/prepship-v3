// PS-497 — the stateful detector, executed directly.
//
// This exists because the previous ratio policy could not fire on the paths it was built
// for. An event-level stranded ratio cannot exceed 1.0, both acknowledged paths are already
// at 1.0, so a 1.5x threshold against a 1.0 baseline was unreachable — and a trailing
// baseline follows a slow leak upward and never trips. Both defects are covered below.
//
// The detector is pure, so every case here runs the real decision code with no database, no
// clock and no network.

import assert from 'node:assert/strict';
import {
  advanceSourceEwma,
  ageMilestoneFor,
  countMilestoneFor,
  evaluateClaimAlarm,
  evaluateSeverity,
  initialClaimAlarmState,
  initialSourceState,
  CLAIM_ALARM_EWMA_ALPHA,
  CLAIM_ALARM_MIN_EVENTS_PER_WINDOW,
  CLAIM_ALARM_REMINDER_INTERVAL_MS,
} from '../src/services/inventory-claim-alarm-detector.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err?.message ?? String(err)}`);
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

const POLICIES = {
  shipment_sync: { class: 'fixed' },
  prepship_v2: { class: 'fixed' },
  order_sync_status: { class: 'open_incident', baselineRatio: 1, saturated: true, baselineVersion: 'ps-497-2026-08-10' },
  external_shipped_classifier: { class: 'open_incident', baselineRatio: 1, saturated: true, baselineVersion: 'ps-497-2026-08-10' },
  slow_path: { class: 'open_incident', baselineRatio: 0.4, baselineVersion: 'test' },
};

const severity = (over = {}) => ({
  reviewCount: 100,
  oldestAgeDays: 1,
  acknowledgedNewEvents24h: 10,
  ...over,
});

// ── 1-2: immediate regressions still page ────────────────────────────────────
check('1. a fixed source stranding one event pages', () => {
  const v = evaluateClaimAlarm({
    state: initialClaimAlarmState(), policies: POLICIES, nowMs: NOW,
    completedWindows: [], severity: severity(),
    immediateReasons: [{ code: 'inventory_claim.fixed_regression.shipment_sync', message: 'regression' }],
  });
  assert.equal(v.page, true);
  assert.equal(v.state, 'alarm');
});
check('2. an unknown source stranding one event pages', () => {
  const v = evaluateClaimAlarm({
    state: initialClaimAlarmState(), policies: POLICIES, nowMs: NOW,
    completedWindows: [], severity: severity(),
    immediateReasons: [{ code: 'inventory_claim.unclassified.new_path', message: 'unknown source' }],
  });
  assert.equal(v.page, true);
});

// ── 3-7: absolute volume and growth ──────────────────────────────────────────
check('3. the known 90-110/day incident does not page', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ acknowledgedNewEvents24h: 110 }), NOW);
  assert.equal(r.page, false, 'paging on the known rate trains everyone to mute the alarm');
});
check('4. a Monday-like 314 events does not page', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ acknowledgedNewEvents24h: 314 }), NOW);
  assert.equal(r.page, false, 'the weekend catch-up is a known pattern, not a step-up');
});
check('5. 400 events pages', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ acknowledgedNewEvents24h: 400 }), NOW);
  assert.equal(r.page, true);
});
check('6. backlog growth of 399 does not page', () => {
  const state = { ...initialClaimAlarmState(), lastReviewCount: 1000 };
  const r = evaluateSeverity(state, severity({ reviewCount: 1399 }), NOW);
  assert.equal(r.page, false);
});
check('7. backlog growth of 400 pages', () => {
  const state = { ...initialClaimAlarmState(), lastReviewCount: 1000 };
  const r = evaluateSeverity(state, severity({ reviewCount: 1400 }), NOW);
  assert.equal(r.page, true);
});

// ── 8-11: count milestones, once each ────────────────────────────────────────
check('8. 2,999 is below the milestone floor', () => {
  assert.equal(countMilestoneFor(2999), null);
});
check('9. 3,000 pages once', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 3000 }), NOW);
  assert.equal(r.page, true);
  assert.equal(r.state.lastCountMilestone, 3000);
});
check('10. still 3,200 an hour later does not page again', () => {
  const first = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 3000 }), NOW);
  const second = evaluateSeverity(first.state, severity({ reviewCount: 3200 }), NOW + HOUR);
  assert.equal(second.page, false, 'a milestone pages on first crossing only');
});
check('11. crossing 3,500 pages once more', () => {
  const first = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 3000 }), NOW);
  const second = evaluateSeverity(first.state, severity({ reviewCount: 3500 }), NOW + HOUR);
  assert.equal(second.page, true);
  assert.equal(second.state.lastCountMilestone, 3500);
});

// ── 12-14: age milestones ────────────────────────────────────────────────────
check('12. 29 days is below the first age milestone', () => {
  assert.equal(ageMilestoneFor(29), null);
});
check('13. 30 days pages once', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ oldestAgeDays: 30 }), NOW);
  assert.equal(r.page, true);
  assert.equal(r.state.lastAgeMilestone, 30);
});
check('14. still 30 days later does not page again', () => {
  const first = evaluateSeverity(initialClaimAlarmState(), severity({ oldestAgeDays: 30 }), NOW);
  const second = evaluateSeverity(first.state, severity({ oldestAgeDays: 30 }), NOW + HOUR);
  assert.equal(second.page, false);
});

// ── 15-17: daily reminder cadence ────────────────────────────────────────────
check('15. a reminder-active incident produces one reminder', () => {
  const r = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 2800 }), NOW);
  assert.equal(r.reminderDue, true);
  assert.equal(r.state.lastIncidentReminderAt, NOW);
});
check('16. the same incident within 24h produces no second reminder', () => {
  const first = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 2800 }), NOW);
  const second = evaluateSeverity(first.state, severity({ reviewCount: 2810 }), NOW + 12 * HOUR);
  assert.equal(second.reminderDue, false, 'hourly runs must not each remind');
});
check('17. the same incident after 24h reminds again', () => {
  const first = evaluateSeverity(initialClaimAlarmState(), severity({ reviewCount: 2800 }), NOW);
  const second = evaluateSeverity(first.state, severity({ reviewCount: 2810 }), NOW + CLAIM_ALARM_REMINDER_INTERVAL_MS);
  assert.equal(second.reminderDue, true);
});

// ── 18-19: EWMA eligibility and idempotence ──────────────────────────────────
check('18. a day with fewer than 20 events leaves the estimator untouched', () => {
  const s0 = initialSourceState(POLICIES.slow_path);
  const r = advanceSourceEwma(s0, POLICIES.slow_path, {
    source: 'slow_path', windowKey: '2026-08-09',
    shippedEvents: CLAIM_ALARM_MIN_EVENTS_PER_WINDOW - 1, reviewClaims: 19,
  });
  assert.equal(r.ratioState, 'insufficient_activity');
  assert.equal(r.state.ewma, s0.ewma, 'a quiet day is not evidence either way');
  assert.equal(r.state.lastProcessedWindowKey, null);
});
check('19. the same completed day seen twice advances the estimator once', () => {
  const s0 = initialSourceState(POLICIES.slow_path);
  const w = { source: 'slow_path', windowKey: '2026-08-09', shippedEvents: 100, reviewClaims: 60 };
  const first = advanceSourceEwma(s0, POLICIES.slow_path, w);
  const second = advanceSourceEwma(first.state, POLICIES.slow_path, w);
  assert.equal(second.ratioState, 'already_processed');
  assert.equal(second.state.ewma, first.state.ewma, 'an hourly re-read must not double-count a day');
});

// ── 20-21: the two ratio detectors ───────────────────────────────────────────
check('20. an abrupt +0.20 day pages immediately', () => {
  const s0 = initialSourceState(POLICIES.slow_path); // baseline 0.4
  const r = advanceSourceEwma(s0, POLICIES.slow_path, {
    source: 'slow_path', windowKey: '2026-08-09', shippedEvents: 100, reviewClaims: 60, // 0.6
  });
  assert.equal(r.page, true);
  assert.equal(r.ratioState, 'abrupt');
});
check('21. a 5%-per-day slow deterioration from 0.40 pages by day 9', () => {
  // THE case the old policy missed entirely. Baseline is committed at 0.40 and does not move.
  let state = initialSourceState(POLICIES.slow_path);
  let ratio = 0.4;
  let pagedOnDay = null;
  for (let day = 1; day <= 12; day += 1) {
    ratio = Math.min(1, ratio * 1.05);
    const r = advanceSourceEwma(state, POLICIES.slow_path, {
      source: 'slow_path',
      windowKey: `2026-08-${String(day).padStart(2, '0')}`,
      shippedEvents: 100,
      reviewClaims: Math.round(ratio * 100),
    });
    state = r.state;
    if (r.page && pagedOnDay == null) pagedOnDay = day;
  }
  assert.notEqual(pagedOnDay, null, 'the old trailing-baseline policy never fired on this');
  assert.ok(pagedOnDay <= 9, `must page by day 9, paged on day ${pagedOnDay}`);
});

// ── 22-24: saturation, cold start, restart safety ────────────────────────────
check('22. a saturated 1.0 baseline skips the unreachable ratio test but stays visible', () => {
  const s0 = initialSourceState(POLICIES.order_sync_status);
  assert.equal(s0.saturated, true);
  const r = advanceSourceEwma(s0, POLICIES.order_sync_status, {
    source: 'order_sync_status', windowKey: '2026-08-09', shippedEvents: 82, reviewClaims: 82,
  });
  assert.equal(r.ratioState, 'saturated', 'saturation must be reported, never silently ok');
  assert.equal(r.page, false, 'no impossible threshold — severity carries this path');
  // and severity still works for it
  const sev = evaluateSeverity(initialClaimAlarmState(), severity({ acknowledgedNewEvents24h: 400 }), NOW);
  assert.equal(sev.page, true, 'absolute severity subsumes ratio detection when saturated');
});
check('23. missing state initialises deterministically from the committed baseline', () => {
  const s = initialSourceState(POLICIES.slow_path);
  assert.equal(s.ewma, 0.4, 'never learn the baseline from live data — that blesses an outage');
  assert.equal(s.consecutiveDeviationWindows, 0);
  assert.equal(s.lastProcessedWindowKey, null);
  assert.equal(s.baselineVersion, 'test');
});
check('24. every verdict is restart-ineligible', () => {
  for (const sev of [severity(), severity({ reviewCount: 9000 }), severity({ oldestAgeDays: 90 })]) {
    const v = evaluateClaimAlarm({
      state: initialClaimAlarmState(), policies: POLICIES, nowMs: NOW,
      completedWindows: [], severity: sev, immediateReasons: [],
    });
    assert.equal(v.restartEligible, false, 'no claim condition is ever fixed by a restart');
  }
});

// ── 25-28: an immediate finding is EDGE-triggered, like every other signal ───
//
// Production 2026-08-12: `shipment_sync` stranded claims, the finding stayed true, and the
// watchdog paged on all 36 consecutive hourly runs — workflow red every hour, so the alarm
// could no longer signal anything new. Every other detector signal already refuses this:
// the EWMA is idempotent per windowKey, milestones ratchet, the growth anchor is held a day
// and the reminder has a 24h interval. `immediateReasons` was the one level-triggered path.
//
// These cases pin the distinction that matters: a NEW finding must still page within the
// hour (sensitivity is not reduced), while an ALREADY-KNOWN one must stop crying wolf.
const IMMEDIATE_REGRESSION = [
  { code: 'inventory_claim.fixed_regression.shipment_sync', message: 'regression' },
];

/** Run `hours` consecutive hourly ticks with a constant finding; count how many paged. */
function runHourly(hours, immediateReasons, startState = initialClaimAlarmState()) {
  let state = startState;
  let pages = 0;
  for (let hour = 0; hour < hours; hour += 1) {
    const v = evaluateClaimAlarm({
      state, policies: POLICIES, nowMs: NOW + hour * HOUR,
      completedWindows: [], severity: severity(), immediateReasons,
    });
    state = v.nextState;
    if (v.page) pages += 1;
  }
  return { state, pages };
}

check('25. a persisting fixed-path regression does not page on every hourly run', () => {
  const { pages } = runHourly(24, IMMEDIATE_REGRESSION);
  assert.equal(pages > 0, true, 'the first occurrence must still page');
  assert.ok(
    pages <= 2,
    `24 hourly runs of ONE unchanged finding paged ${pages} times — an alarm that fires every ` +
    'hour on a known condition gets muted, and then the next regression goes unseen',
  );
});

check('26. a NEW finding pages immediately even while another persists', () => {
  const { state } = runHourly(6, IMMEDIATE_REGRESSION);
  const v = evaluateClaimAlarm({
    state, policies: POLICIES, nowMs: NOW + 6 * HOUR,
    completedWindows: [], severity: severity(),
    immediateReasons: [
      ...IMMEDIATE_REGRESSION,
      { code: 'inventory_claim.unclassified.new_path', message: 'unknown source' },
    ],
  });
  assert.equal(v.page, true, 'an unwatched path leaking must page on its first sighting');
  assert.ok(
    v.reasons.some((r) => r.code === 'inventory_claim.unclassified.new_path'),
    'and the new code must be carried in the reasons',
  );
});

check('27. a finding that clears and returns pages again', () => {
  const { state: noisy } = runHourly(24, IMMEDIATE_REGRESSION);
  // The path is repaired: the finding disappears for a run.
  const cleared = evaluateClaimAlarm({
    state: noisy, policies: POLICIES, nowMs: NOW + 24 * HOUR,
    completedWindows: [], severity: severity(), immediateReasons: [],
  });
  // ...then regresses again. This is a NEW regression and must page, not be swallowed by a
  // stale ledger entry — otherwise repair→regress cycles are invisible after the first.
  const returned = evaluateClaimAlarm({
    state: cleared.nextState, policies: POLICIES, nowMs: NOW + 25 * HOUR,
    completedWindows: [], severity: severity(), immediateReasons: IMMEDIATE_REGRESSION,
  });
  assert.equal(returned.page, true, 'a regression that returns is new information');
});

check('28. the ledger retains only findings currently present', () => {
  const { state } = runHourly(3, IMMEDIATE_REGRESSION);
  const cleared = evaluateClaimAlarm({
    state, policies: POLICIES, nowMs: NOW + 3 * HOUR,
    completedWindows: [], severity: severity(), immediateReasons: [],
  });
  assert.deepEqual(
    Object.keys(cleared.nextState.immediate ?? {}), [],
    'a resolved finding must not linger in state — that is how a returning one stays silent',
  );
});

// ── the constants are the contract ───────────────────────────────────────────
check('the EWMA alpha keeps 80% of the prior estimate', () => {
  assert.equal(CLAIM_ALARM_EWMA_ALPHA, 0.20);
});
check('reason codes are stable and carry no message text', () => {
  const v = evaluateClaimAlarm({
    state: initialClaimAlarmState(), policies: POLICIES, nowMs: NOW,
    completedWindows: [], severity: severity({ reviewCount: 3000 }), immediateReasons: [],
  });
  const codes = v.reasons.map((r) => r.code);
  assert.ok(codes.includes('inventory_claim.count_milestone.3000'));
  assert.ok(codes.every((c) => !/\s/.test(c)), 'dedupe keys must never be built from prose');
});

// ── the growth anchor is held for a day, so hourly runs cannot shrink the window ──
// The watchdog runs hourly. If each run re-anchored `lastReviewCount`, "growth of 400 in
// 24h" would silently become "growth of 400 in ONE HOUR" — about four times the known daily
// rate, so the check would never fire while looking fully implemented.
check('an hourly run does not move the growth anchor', () => {
  const state = { ...initialClaimAlarmState(), lastReviewCount: 1000, lastSeveritySnapshotAt: NOW - HOUR };
  const r = evaluateSeverity(state, severity({ reviewCount: 1100 }), NOW);
  assert.equal(r.state.lastReviewCount, 1000, 'the anchor must survive an hourly run');
  assert.equal(r.state.lastSeveritySnapshotAt, NOW - HOUR, 'and keep its original timestamp');
});
check('growth is not evaluated against an anchor younger than a day', () => {
  const state = { ...initialClaimAlarmState(), lastReviewCount: 1000, lastSeveritySnapshotAt: NOW - HOUR };
  const r = evaluateSeverity(state, severity({ reviewCount: 1500 }), NOW);
  assert.equal(r.page, false, '500 in one hour is not the 24h growth this threshold describes');
});
check('24 hourly runs still page on a full day of growth', () => {
  // The realistic sequence: the anchor is set, 23 hourly runs pass through, and the 24th
  // measures the whole day. A re-anchoring bug makes each step tiny and this never pages.
  let state = { ...initialClaimAlarmState(), lastReviewCount: 1000, lastSeveritySnapshotAt: NOW };
  let paged = false;
  for (let hour = 1; hour <= 24; hour += 1) {
    const r = evaluateSeverity(state, severity({ reviewCount: 1000 + hour * 25 }), NOW + hour * HOUR);
    state = r.state;
    if (r.page) paged = true;
  }
  assert.equal(paged, true, '600 claims across a day must page even when read hourly');
  assert.equal(state.lastReviewCount, 1600, 'and the anchor re-arms at the measured value');
});
check('a matured anchor below the threshold re-arms without paging', () => {
  const state = { ...initialClaimAlarmState(), lastReviewCount: 1000, lastSeveritySnapshotAt: NOW - 24 * HOUR };
  const r = evaluateSeverity(state, severity({ reviewCount: 1100 }), NOW);
  assert.equal(r.page, false);
  assert.equal(r.state.lastReviewCount, 1100, 'a quiet day still moves the anchor forward');
  assert.equal(r.state.lastSeveritySnapshotAt, NOW);
});

if (failures > 0) {
  console.error(`\nPS-497 inventory claim alarm detector guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 inventory claim alarm detector guard');
console.log('Pure detector executed directly. No database, no clock, no network.');
