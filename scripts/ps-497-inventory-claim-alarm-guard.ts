// PS-497 — the stranded-claim alarm policy, tested by EXECUTION.
//
// Hermes defeated two previous guards on this card. The first asserted the SQL's source
// shape and died to `and false`. The second executed the query but its fixture jumped 10h to
// 3 days, so widening the window `24h -> 48h` was invisible. Both lessons apply here:
//
//   1. Assert what the code RETURNS, never what it looks like.
//   2. Put cases on BOTH SIDES of every threshold, or the threshold is untested.
//
// So each numeric boundary below is probed just under, exactly at, and just over. The policy
// is pure, so this needs no database and no clock.

import assert from 'node:assert/strict';
import {
  classifyClaimSource,
  evaluateClaimSource,
  evaluateInventoryClaimReviewAlarm,
  FIXED_CLAIM_SOURCES,
  OPEN_INCIDENT_CLAIM_SOURCES,
  OPEN_INCIDENT_WORSENING_FACTOR,
} from '../src/services/inventory-claim-review-alarm.js';

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

// ── classification ────────────────────────────────────────────────────────────
check('the repaired paths are classified fixed', () => {
  assert.equal(classifyClaimSource('shipment_sync'), 'fixed');
  assert.equal(classifyClaimSource('prepship_v2'), 'fixed');
});
check('the two still-bleeding paths are classified as an acknowledged incident', () => {
  assert.equal(classifyClaimSource('order_sync_status'), 'open_incident');
  assert.equal(classifyClaimSource('external_shipped_classifier'), 'open_incident');
});
check('an unlisted source is unknown, not silently tolerated', () => {
  assert.equal(classifyClaimSource('some_new_path'), 'unknown');
});

// ── a REPAIRED path: threshold is zero, so 0 vs 1 is the boundary ─────────────
check('a fixed path with zero review claims is ok', () => {
  const v = evaluateClaimSource({ source: 'shipment_sync', reviewClaims: 0, shippedEvents: 40 }, null);
  assert.equal(v.alert, false);
  assert.equal(v.state, 'ok');
});
check('a fixed path with ONE review claim alerts as a regression', () => {
  const v = evaluateClaimSource({ source: 'shipment_sync', reviewClaims: 1, shippedEvents: 40 }, null);
  assert.equal(v.alert, true, 'one stranded claim on a repaired path must page');
  assert.equal(v.state, 'regression');
  assert.match(v.reason, /regressed/);
});

// ── the weekend case: no work processed ──────────────────────────────────────
check('no shipped work reports no_activity, NOT ok — silence is not health', () => {
  const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 0, shippedEvents: 0 }, 0.5);
  assert.equal(v.alert, false, 'a quiet weekend must not page');
  assert.equal(v.state, 'no_activity', 'and must not be reported as ok either');
  assert.equal(v.ratio, null, 'no denominator means no ratio, not a divide-by-zero');
});
check('claims WITHOUT shipped work always alert, whatever the source', () => {
  const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 3, shippedEvents: 0 }, 0.5);
  assert.equal(v.alert, true, 'claims with no work behind them is never expected');
  assert.equal(v.state, 'regression');
});

// ── an ACKNOWLEDGED path: the worsening boundary ─────────────────────────────
// baseline 0.5, factor 1.5 => threshold 0.75. Probe under / at / over.
{
  const baseline = 0.5;
  const threshold = baseline * OPEN_INCIDENT_WORSENING_FACTOR; // 0.75
  check('an acknowledged path at its expected rate does NOT page', () => {
    const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 50, shippedEvents: 100 }, baseline);
    assert.equal(v.ratio, 0.5);
    assert.equal(v.alert, false, 'paging on ~90-110 expected claims a day trains everyone to ignore it');
    assert.equal(v.state, 'ok');
  });
  check('JUST BELOW the worsening threshold does not page', () => {
    const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 74, shippedEvents: 100 }, baseline);
    assert.ok(v.ratio! < threshold, `0.74 must be under ${threshold}`);
    assert.equal(v.alert, false);
  });
  check('EXACTLY AT the threshold does not page (strictly greater is the rule)', () => {
    const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 75, shippedEvents: 100 }, baseline);
    assert.equal(v.ratio, threshold);
    assert.equal(v.alert, false, 'the boundary itself is not yet worsening');
  });
  check('JUST OVER the threshold pages as worsening', () => {
    const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 76, shippedEvents: 100 }, baseline);
    assert.ok(v.ratio! > threshold);
    assert.equal(v.alert, true, 'material worsening is the thing worth waking someone for');
    assert.equal(v.state, 'worsening');
  });
  check('doubling the rate pages', () => {
    const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 100, shippedEvents: 100 }, baseline);
    assert.equal(v.alert, true);
  });
}
check('an acknowledged path with no baseline yet records the ratio and does not page', () => {
  const v = evaluateClaimSource({ source: 'order_sync_status', reviewClaims: 40, shippedEvents: 100 }, null);
  assert.equal(v.alert, false);
  assert.equal(v.ratio, 0.4);
});

// ── an UNKNOWN source: any inflow is a leak nobody is watching ───────────────
check('an unknown source with claims alerts even at a tiny ratio', () => {
  const v = evaluateClaimSource({ source: 'brand_new_path', reviewClaims: 1, shippedEvents: 10_000 }, null);
  assert.equal(v.alert, true, 'an unwatched leaking path is the most dangerous case');
  assert.equal(v.state, 'unclassified_source');
});
check('an unknown source with no claims does not page', () => {
  const v = evaluateClaimSource({ source: 'brand_new_path', reviewClaims: 0, shippedEvents: 10 }, null);
  assert.equal(v.alert, false);
});

// ── the rolled-up verdict ────────────────────────────────────────────────────
check('one regression among healthy sources raises the overall alarm', () => {
  const v = evaluateInventoryClaimReviewAlarm(
    [
      { source: 'shipment_sync', reviewClaims: 2, shippedEvents: 30 },
      { source: 'prepship_v2', reviewClaims: 0, shippedEvents: 10 },
      { source: 'order_sync_status', reviewClaims: 20, shippedEvents: 50 },
    ],
    { order_sync_status: 0.5 },
  );
  assert.equal(v.alert, true);
  assert.equal(v.state, 'alarm');
  assert.match(v.reason, /shipment_sync/);
});
check('a whole quiet window reports no_activity, so a weekend is never read as a fix', () => {
  const v = evaluateInventoryClaimReviewAlarm([
    { source: 'shipment_sync', reviewClaims: 0, shippedEvents: 0 },
    { source: 'order_sync_status', reviewClaims: 0, shippedEvents: 0 },
  ], {});
  assert.equal(v.alert, false);
  assert.equal(v.state, 'no_activity', 'THE weekend case — must not be ok');
});
check('real working-day behaviour with the leak acknowledged stays quiet', () => {
  // Roughly today: order_sync_status 35 claims, external 14, fixed paths clean.
  const v = evaluateInventoryClaimReviewAlarm(
    [
      { source: 'shipment_sync', reviewClaims: 0, shippedEvents: 44 },
      { source: 'prepship_v2', reviewClaims: 0, shippedEvents: 12 },
      { source: 'order_sync_status', reviewClaims: 35, shippedEvents: 44 },
      { source: 'external_shipped_classifier', reviewClaims: 14, shippedEvents: 20 },
    ],
    { order_sync_status: 0.8, external_shipped_classifier: 0.7 },
  );
  assert.equal(v.alert, false, 'the known incident at its known rate must not page');
  assert.equal(v.state, 'ok');
});
check('but the SAME day with a fixed path regressing does page', () => {
  const v = evaluateInventoryClaimReviewAlarm(
    [
      { source: 'shipment_sync', reviewClaims: 1, shippedEvents: 44 },
      { source: 'order_sync_status', reviewClaims: 35, shippedEvents: 44 },
    ],
    { order_sync_status: 0.8 },
  );
  assert.equal(v.alert, true, 'a single regressed claim is exactly what went unseen for 22 days');
});
check('no sources reported is ok, not a crash', () => {
  const v = evaluateInventoryClaimReviewAlarm([], {});
  assert.equal(v.alert, false);
  assert.equal(v.state, 'ok');
});

// ── the source lists are load-bearing, so pin them ──────────────────────────
check('the fixed list holds exactly the two paths repaired on 2026-08-07', () => {
  assert.deepEqual([...FIXED_CLAIM_SOURCES].sort(), ['prepship_v2', 'shipment_sync']);
});
check('the open-incident list holds exactly the two still awaiting DJ', () => {
  assert.deepEqual([...OPEN_INCIDENT_CLAIM_SOURCES].sort(),
    ['external_shipped_classifier', 'order_sync_status']);
});

if (failures > 0) {
  console.error(`\nPS-497 inventory claim alarm guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 inventory claim alarm guard');
console.log('Pure policy executed directly. No database, no clock, no network.');
