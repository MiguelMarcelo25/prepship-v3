// PS-497 — the alarm READ MODEL, tested by execution against real PostgreSQL (PGlite).
//
// The pure policy is covered by ps-497-inventory-claim-alarm-guard.ts. This covers the part
// a pure test cannot: that the SQL measures the right thing. Two measurement decisions carry
// the whole alarm, and both are invisible to a source-reading guard:
//
//   1. The denominator counts DEDUCTION work only (`shipped`, `external_shipped`). Counting
//      `cancelled` events too would inflate it and shrink every ratio, so a worsening leak
//      would look stable.
//   2. The numerator counts stranded EVENTS, not claims. One event can mint several claims,
//      so counting claims would make one multi-line order look like several failures.
//
// Both are proven here by seeding data where a wrong choice produces a different number.

import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  readClaimAlarmDetectionInputs,
  readCompletedClaimWindows,
  readInventoryClaimAlarm,
} from '../src/services/inventory-claim-alarm-read-model.js';

async function main(): Promise<void> {
  const client = new PGlite();
  await client.exec(`
    create table order_lifecycle_events (
      id serial primary key,
      source text not null,
      transition text not null,
      created_at timestamptz not null default now()
    );
    create table fulfillment_line_claims (
      id serial primary key,
      lifecycle_event_id integer not null references order_lifecycle_events(id),
      status text not null,
      created_at timestamptz not null default now()
    );
  `);

  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // postgres.js interpolates as $1..$n; PGlite takes the same positional form.
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
    const { rows } = await client.query(text, values as unknown[]);
    return rows as Array<Record<string, unknown>>;
  }) as Parameters<typeof readInventoryClaimAlarm>[0];

  // ── seed ────────────────────────────────────────────────────────────────────
  // Inside the 24h window:
  //   shipment_sync            10 shipped, 0 stranded              -> a repaired path, clean
  //   order_sync_status        10 shipped, 8 stranded              -> known incident
  //   external_shipped_classifier 4 external_shipped, 4 stranded   -> known incident
  //   shipment_sync            5 CANCELLED, 0 stranded             -> must NOT count as work
  //   order_sync_status        1 shipped, 1 event with THREE claims -> must count once
  const mk = async (source: string, transition: string, n: number, agoHours: number, strand: number, claimsPerEvent = 1) => {
    for (let i = 0; i < n; i += 1) {
      const { rows } = await client.query(
        `insert into order_lifecycle_events (source, transition, created_at)
         values ($1, $2, now() - make_interval(hours => $3)) returning id`,
        [source, transition, agoHours],
      );
      const eventId = (rows[0] as { id: number }).id;
      if (i < strand) {
        for (let k = 0; k < claimsPerEvent; k += 1) {
          await client.query(
            `insert into fulfillment_line_claims (lifecycle_event_id, status, created_at)
             values ($1, 'review', now() - make_interval(hours => $2))`,
            [eventId, agoHours],
          );
        }
      }
    }
  };

  /**
   * Seed one event carrying an explicit set of claim statuses.
   *
   * Needed because `mk` only creates review claims, and a fixture made only of review rows
   * cannot tell `status = 'review'` apart from a widened predicate. Review defeated the
   * earlier version by changing it to `status in ('review','pending')` — every assertion
   * stayed green because no pending claim existed to be wrongly counted.
   */
  const mkEvent = async (source: string, transition: string, agoHours: number, statuses: string[]) => {
    const { rows } = await client.query(
      `insert into order_lifecycle_events (source, transition, created_at)
       values ($1, $2, now() - make_interval(hours => $3)) returning id`,
      [source, transition, agoHours],
    );
    const eventId = (rows[0] as { id: number }).id;
    for (const status of statuses) {
      await client.query(
        `insert into fulfillment_line_claims (lifecycle_event_id, status, created_at)
         values ($1, $2, now() - make_interval(hours => $3))`,
        [eventId, status, agoHours],
      );
    }
  };

  // Every non-review status the column carries today, plus a sentinel. The column is
  // unconstrained text, so the sentinel proves a negative predicate like `status <> 'applied'`
  // cannot silently promote an unknown future state into the stranded count.
  const COMPETING = ['pending', 'applied', 'superseded', 'reversed', 'unexpected_state'];

  await mk('shipment_sync', 'shipped', 10, 2, 0);
  await mk('order_sync_status', 'shipped', 10, 3, 8);
  await mk('external_shipped_classifier', 'external_shipped', 4, 4, 4);
  await mk('shipment_sync', 'cancelled', 5, 2, 0);
  // Baseline window (older than 24h, inside 7 days): order_sync_status 20 shipped, 8 stranded
  await mk('order_sync_status', 'shipped', 20, 72, 8);

  // ── competing claim states, in BOTH windows ────────────────────────────────
  // The baseline uses a SEPARATE SQL statement from the current window, so it can drift
  // independently. Both get the same treatment.
  for (const agoHours of [3, 72]) {
    // One event per competing status, alone: raises deduction_events, must never strand.
    for (const status of COMPETING) {
      await mkEvent('order_sync_status', 'shipped', agoHours, [status]);
    }
    // One mixed event: two review claims plus every competing status. Must count as exactly
    // ONE stranded event — proving per-event dedupe via EXISTS, and that unrelated statuses
    // on the same event cannot change the answer.
    await mkEvent('order_sync_status', 'shipped', agoHours, ['review', 'review', ...COMPETING]);
  }

  const reading = await readInventoryClaimAlarm(query, { windowHours: 24, baselineHours: 24 * 7 });
  const bySource = Object.fromEntries(reading.windows.map((w) => [w.source, w]));

  // ── decision 1: cancelled events are not deduction work ─────────────────────
  assert.equal(
    bySource.shipment_sync.shippedEvents, 10,
    `denominator must exclude cancelled events, got ${bySource.shipment_sync?.shippedEvents}`,
  );
  console.log('ok   the denominator counts deduction work only — 5 cancelled events excluded');

  // ── decision 2: only `review` is stranded, and it counts EVENTS ────────────
  // 10 original + 5 single-status + 1 mixed = 16 deduction events.
  // 8 original stranded + 1 from the mixed event = 9. The five competing-status events must
  // contribute ZERO. A widened predicate (`in ('review','pending')`, `<> 'applied'`,
  // `in ('review','superseded')`) raises this; counting claim rows instead of events makes
  // the mixed event contribute 2 and also raises it.
  assert.equal(
    bySource.order_sync_status.shippedEvents, 16,
    `competing-status events still count as work, got ${bySource.order_sync_status?.shippedEvents}`,
  );
  assert.equal(
    bySource.order_sync_status.reviewClaims, 9,
    `only review strands, counted once per event, got ${bySource.order_sync_status?.reviewClaims}`,
  );
  console.log('ok   pending/applied/superseded/reversed/unexpected_state never count as stranded');
  console.log('ok   an event with two review claims counts once, so one order is one failure');
  assert.equal(bySource.external_shipped_classifier.shippedEvents, 4);
  assert.equal(bySource.external_shipped_classifier.reviewClaims, 4);
  console.log('ok   external_shipped counts as deduction work alongside shipped');

  // ── the baseline excludes the current window ───────────────────────────────
  // Baseline window holds 20 events / 8 stranded = 0.4. If it wrongly included the current
  // window it would be 28/16 = 0.571 and this fails.
  // Baseline window: 20 original + 5 single-status + 1 mixed = 26 events, 8 + 1 = 9 stranded.
  // If it wrongly included the current window it would be 42/18 and this fails.
  assert.ok(
    Math.abs(reading.baselines.order_sync_status - 9 / 26) < 1e-9,
    `baseline must exclude the current window, got ${reading.baselines.order_sync_status}`,
  );
  console.log('ok   the baseline excludes the current window, so a rising leak cannot lift its own threshold');
  console.log('ok   the baseline query applies the same review-only rule as the current window');

  // ── the verdict rolls up correctly ─────────────────────────────────────────
  // order_sync_status is 0.8 now against a 0.4 baseline -> 2x, over the 1.5 factor -> alert.
  assert.equal(reading.verdict.alert, true, 'a doubled ratio on a known incident must alert');
  const osv = reading.verdict.sources.find((s) => s.source === 'order_sync_status');
  assert.equal(osv?.state, 'worsening');
  console.log('ok   a known incident that doubles against its own baseline alerts');

  const ssv = reading.verdict.sources.find((s) => s.source === 'shipment_sync');
  assert.equal(ssv?.alert, false, 'a clean repaired path must not alert');
  assert.equal(ssv?.state, 'ok');
  console.log('ok   a repaired path with zero stranded events stays quiet');

  // ── a repaired path stranding ONE event alerts ─────────────────────────────
  await mk('shipment_sync', 'shipped', 1, 1, 1);
  {
    const after = await readInventoryClaimAlarm(query, { windowHours: 24, baselineHours: 24 * 7 });
    const s = after.verdict.sources.find((x) => x.source === 'shipment_sync');
    assert.equal(s?.alert, true, 'one stranded event on a repaired path is a regression');
    assert.equal(s?.state, 'regression');
    console.log('ok   ONE stranded event on a repaired path alerts — the 22-day outage on day one');
  }

  // ── the seven-day baseline boundary, on the DEFAULT ────────────────────────
  // Review defeated the earlier version by changing the default 7 days to 14: no fixture
  // lived between those boundaries, so the wrong window was invisible. These two events
  // straddle it, and this call deliberately does NOT pass baselineHours — passing it would
  // bypass the very default under test.
  {
    await client.exec(`delete from fulfillment_line_claims; delete from order_lifecycle_events;`);
    await mkEvent('order_sync_status', 'shipped', 167, ['review']); // inside 7 days
    await mkEvent('order_sync_status', 'shipped', 169, ['review']); // outside 7 days
    // One event in the current window so the source is reported at all.
    await mkEvent('order_sync_status', 'shipped', 2, ['review']);

    const dflt = await readInventoryClaimAlarm(query);
    assert.equal(dflt.windowHours, 24, 'the default window is 24 hours');
    assert.equal(dflt.baselineHours, 168, 'the default baseline is seven days');
    console.log('ok   the exported defaults are 24h window and 168h baseline');

    // Baseline sees ONLY the 167h event: 1 event, 1 stranded. Widening to 14 days admits the
    // 169h event and makes it 2/2; narrowing to 3 days admits neither and drops the source.
    assert.ok(
      Math.abs(dflt.baselines.order_sync_status - 1) < 1e-9,
      `baseline must include 167h and exclude 169h, got ${dflt.baselines.order_sync_status}`,
    );
    console.log('ok   the 167h event is inside the baseline and the 169h event is outside it');
  }

  // ── the weekend: no deduction work at all ──────────────────────────────────
  {
    await client.exec(`delete from fulfillment_line_claims; delete from order_lifecycle_events;`);
    const quiet = await readInventoryClaimAlarm(query, { windowHours: 24, baselineHours: 24 * 7 });
    assert.equal(quiet.verdict.alert, false, 'a quiet window must not page');
    assert.equal(quiet.verdict.state, 'ok', 'no sources reported at all is ok, not a crash');
    assert.deepEqual(quiet.windows, [], 'and reports no windows rather than inventing zeros');
    console.log('ok   a window with no lifecycle events at all is handled without paging');
  }

  // ── detector inputs: completed UTC days, severity, immediate findings ───────
  //
  // The detector's whole premise is COMPLETED days rather than rolling windows: an hourly
  // watchdog re-reading an overlapping 24h window counts nearly the same events repeatedly
  // and gives the estimator an unpredictable weight. That premise lives in SQL, so it is
  // proven here by execution rather than by reading the query.
  {
    await client.exec(`delete from fulfillment_line_claims; delete from order_lifecycle_events;`);

    // Anchored to the UTC day boundary, not "N hours ago", so the fixture means the same
    // thing whatever time this guard runs.
    const dayAt = async (source: string, transition: string, daysAgo: number, n: number, strand: number) => {
      for (let i = 0; i < n; i += 1) {
        const { rows } = await client.query(
          `insert into order_lifecycle_events (source, transition, created_at)
           values ($1, $2, (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
                            - make_interval(days => $3) + interval '12 hours')
           returning id`,
          [source, transition, daysAgo],
        );
        if (i < strand) {
          await client.query(
            `insert into fulfillment_line_claims (lifecycle_event_id, status) values ($1, 'review')`,
            [(rows[0] as { id: number }).id],
          );
        }
      }
    };

    // Two and three days back, not one: a completed day anchored to yesterday MIDDAY still
    // falls inside the rolling 24h window when this runs in the morning, which would make the
    // severity assertion below depend on the clock.
    await dayAt('order_sync_status', 'shipped', 2, 30, 12);
    await dayAt('order_sync_status', 'shipped', 3, 25, 5);
    // TODAY, still filling. A partial day must never reach the estimator: a leak that starts
    // at 09:00 would otherwise be averaged against an hour of work and read as catastrophic,
    // and a quiet morning would read as a fix.
    await mk('order_sync_status', 'shipped', 8, 0, 8);

    const completed = await readCompletedClaimWindows(query, 14);
    assert.equal(completed.length, 2, `today must be excluded, got ${JSON.stringify(completed)}`);
    console.log('ok   the incomplete current day is excluded from the completed windows');

    assert.ok(
      completed[0].windowKey < completed[1].windowKey,
      'windows must be ascending — the EWMA is order-dependent, so replaying days out of order changes the answer',
    );
    console.log('ok   completed windows are ordered oldest-first');

    assert.deepEqual(
      completed.map((w) => [w.shippedEvents, w.reviewClaims]),
      [[25, 5], [30, 12]],
      `per-day counts wrong: ${JSON.stringify(completed)}`,
    );
    console.log('ok   each completed day is measured separately, not merged into one window');
    assert.match(completed[0].windowKey, /^\d{4}-\d{2}-\d{2}$/, 'windowKey must be a UTC date');
    console.log('ok   windowKey is a UTC date, so the same day cannot advance the estimator twice');

    // ── severity ─────────────────────────────────────────────────────────────
    // A 40-day-old claim, which must drive the age milestone.
    const { rows: oldEvent } = await client.query(
      `insert into order_lifecycle_events (source, transition, created_at)
       values ('order_sync_status', 'shipped', now() - interval '40 days') returning id`,
    );
    await client.query(
      `insert into fulfillment_line_claims (lifecycle_event_id, status, created_at)
       values ($1, 'review', now() - interval '40 days')`,
      [(oldEvent[0] as { id: number }).id],
    );
    // An unclassified path stranding inside the current window.
    await mk('brand_new_path', 'shipped', 3, 2, 3);

    const inputs = await readClaimAlarmDetectionInputs(query, { completedDays: 14 });

    // 12 + 5 + 8 (today) + 1 (40-day) + 3 (unknown) = 29 claims in review.
    assert.equal(inputs.severity.reviewCount, 29, `reviewCount wrong: ${inputs.severity.reviewCount}`);
    console.log('ok   reviewCount counts every stranded claim regardless of window or source');
    assert.ok(
      inputs.severity.oldestAgeDays >= 39.9 && inputs.severity.oldestAgeDays < 41,
      `oldestAgeDays wrong: ${inputs.severity.oldestAgeDays}`,
    );
    console.log('ok   oldestAgeDays measures the oldest stranded claim, which drives age milestones');

    // Only acknowledged sources count toward the volume threshold. The 3 unknown-source
    // strandings must NOT inflate it — they page immediately on their own.
    assert.equal(
      inputs.severity.acknowledgedNewEvents24h, 8,
      `only open-incident sources feed the volume threshold: ${inputs.severity.acknowledgedNewEvents24h}`,
    );
    console.log('ok   the 24h volume counts acknowledged sources only, per CLAIM_SOURCE_POLICIES');

    // ── immediate findings ───────────────────────────────────────────────────
    const codes = inputs.immediateReasons.map((r) => r.code);
    assert.deepEqual(codes, ['inventory_claim.unclassified.brand_new_path'],
      `unexpected immediate reasons: ${JSON.stringify(codes)}`);
    console.log('ok   an unclassified source pages immediately, without waiting for a day to complete');
    assert.ok(
      !codes.some((c) => c.includes('order_sync_status')),
      'an acknowledged source must NOT page through the legacy 1.5x rollup — that rule is unreachable against its 1.0 baseline, and re-importing it restores the defect the detector replaces',
    );
    console.log('ok   acknowledged sources are excluded from immediate findings, so the old rule cannot leak back in');

    assert.equal(inputs.policies.order_sync_status.saturated, true);
    assert.equal(inputs.policies.shipment_sync.class, 'fixed');
    console.log('ok   the policy table ships with the measurements, so the watchdog needs no copy of it');
  }

  await client.close();
  console.log('\nPASS PS-497 inventory claim alarm integration');
  console.log('Real PostgreSQL (PGlite, in-process). No production access, no writes outside the throwaway database.');
}

main().catch((err) => {
  console.error('\nFAIL PS-497 inventory claim alarm integration');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
