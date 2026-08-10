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
import { readInventoryClaimAlarm } from '../src/services/inventory-claim-alarm-read-model.js';

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

  await mk('shipment_sync', 'shipped', 10, 2, 0);
  await mk('order_sync_status', 'shipped', 10, 3, 8);
  await mk('external_shipped_classifier', 'external_shipped', 4, 4, 4);
  await mk('shipment_sync', 'cancelled', 5, 2, 0);
  // Baseline window (older than 24h, inside 7 days): order_sync_status 20 shipped, 8 stranded
  await mk('order_sync_status', 'shipped', 20, 72, 8);

  const reading = await readInventoryClaimAlarm(query, { windowHours: 24, baselineHours: 24 * 7 });
  const bySource = Object.fromEntries(reading.windows.map((w) => [w.source, w]));

  // ── decision 1: cancelled events are not deduction work ─────────────────────
  assert.equal(
    bySource.shipment_sync.shippedEvents, 10,
    `denominator must exclude cancelled events, got ${bySource.shipment_sync?.shippedEvents}`,
  );
  console.log('ok   the denominator counts deduction work only — 5 cancelled events excluded');

  // ── decision 2: stranded EVENTS, not claims ────────────────────────────────
  assert.equal(
    bySource.order_sync_status.reviewClaims, 8,
    `numerator must count stranded events, got ${bySource.order_sync_status?.reviewClaims}`,
  );
  console.log('ok   the numerator counts stranded events, so one order is one failure');

  assert.equal(bySource.order_sync_status.shippedEvents, 10);
  assert.equal(bySource.external_shipped_classifier.shippedEvents, 4);
  assert.equal(bySource.external_shipped_classifier.reviewClaims, 4);
  console.log('ok   external_shipped counts as deduction work alongside shipped');

  // ── the baseline excludes the current window ───────────────────────────────
  // Baseline window holds 20 events / 8 stranded = 0.4. If it wrongly included the current
  // window it would be 28/16 = 0.571 and this fails.
  assert.ok(
    Math.abs(reading.baselines.order_sync_status - 0.4) < 1e-9,
    `baseline must exclude the current window, got ${reading.baselines.order_sync_status}`,
  );
  console.log('ok   the baseline excludes the current window, so a rising leak cannot lift its own threshold');

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

  // ── the weekend: no deduction work at all ──────────────────────────────────
  {
    await client.exec(`delete from fulfillment_line_claims; delete from order_lifecycle_events;`);
    const quiet = await readInventoryClaimAlarm(query, { windowHours: 24, baselineHours: 24 * 7 });
    assert.equal(quiet.verdict.alert, false, 'a quiet window must not page');
    assert.equal(quiet.verdict.state, 'ok', 'no sources reported at all is ok, not a crash');
    assert.deepEqual(quiet.windows, [], 'and reports no windows rather than inventing zeros');
    console.log('ok   a window with no lifecycle events at all is handled without paging');
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
