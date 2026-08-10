// PS-497 — BEHAVIOURAL proof of the stranded-claim health probe.
//
// Why this exists. The first guard for this probe asserted the SQL's source shape: that it
// contained `status = 'review'`, `fulfillment_line_claims`, and the three field names. All
// ten assertions passed. Hermes then defeated it in one edit — appending `and false` to the
// predicate — which makes the probe report a permanent zero backlog while every string the
// guard looked for is still present.
//
// That is the ps-318 failure class again, in a new shape: the symbol survives, the behaviour
// dies. Reading SQL cannot tell you what SQL returns. So this runs the real query against a
// real PostgreSQL (PGlite, in-process — no service container, no production access) with
// rows whose correct answer is known, and asserts the numbers that come back.
//
// A guard that cannot fail is worse than no guard, because it is believed.

import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readInventoryClaimReviewHealth } from '../src/services/inventory-claim-review-health.js';

async function main(): Promise<void> {
  const client = new PGlite();
  await client.exec(`
    create table fulfillment_line_claims (
      id serial primary key,
      status text not null,
      created_at timestamptz not null default now()
    );
  `);

  // Executor adapter: PGlite speaks .query(sql), the module speaks tagged templates. The
  // query carries no parameters, so joining the strings is the whole translation.
  //
  // The length assertion is not decoration. Joining the strings SILENTLY DISCARDS any
  // interpolated value, so if the query ever gains a parameter this adapter would execute
  // different SQL than production while still passing. The executor type forbids
  // interpolation today (adding one fails typecheck with TS2554), but this cast could hide
  // a later widening — so enforce it at runtime too.
  const query = (async (strings: TemplateStringsArray) => {
    assert.equal(strings.length, 1, 'health query must not interpolate values');
    const { rows } = await client.query(strings.join(''));
    return rows as Array<Record<string, unknown>>;
  }) as Parameters<typeof readInventoryClaimReviewHealth>[0];

  // ── empty table ────────────────────────────────────────────────────────────
  {
    const health = await readInventoryClaimReviewHealth(query);
    assert.equal(health.reviewCount, 0, 'empty table reports a zero backlog');
    assert.equal(health.reviewLast24h, 0, 'empty table reports no recent inflow');
    assert.equal(health.oldestAgeDays, 0, 'empty table reports no age');
    console.log('ok   an empty table reports zeros');
  }

  // ── a known population ─────────────────────────────────────────────────────
  // 9 review rows. Plus 3 rows in other states that must NOT be counted — the probe reports
  // the STRANDED backlog, not every claim.
  //
  // The 23h and 25h rows STRADDLE the 24-hour boundary deliberately. An earlier fixture
  // jumped from 10h straight to 3 days, and Hermes defeated it by widening the production
  // window from `interval '24 hours'` to `'48 hours'`: with nothing living in the gap, the
  // wrong window was invisible and every assertion stayed green. A boundary is only tested
  // by rows on BOTH sides of it.
  //
  // The 45-day row is there so a hidden age or retention cutoff cannot silently drop part of
  // the backlog from the total while the count still looks plausible.
  await client.exec(`
    insert into fulfillment_line_claims (status, created_at) values
      ('review',     now() - interval '2 hours'),
      ('review',     now() - interval '10 hours'),
      ('review',     now() - interval '23 hours'),   -- inside the window, must count as recent
      ('review',     now() - interval '25 hours'),   -- outside it, must NOT count as recent
      ('review',     now() - interval '3 days'),
      ('review',     now() - interval '9 days'),
      ('review',     now() - interval '20 days'),
      ('review',     now() - interval '30 days'),
      ('review',     now() - interval '45 days'),    -- no retention cutoff may hide this
      ('pending',    now() - interval '1 hour'),
      ('applied',    now() - interval '1 hour'),
      ('superseded', now() - interval '40 days');
  `);

  {
    const health = await readInventoryClaimReviewHealth(query);
    // `and false` on the predicate makes this 0 and fails here.
    assert.equal(health.reviewCount, 9, `counts every review row, got ${health.reviewCount}`);
    console.log('ok   the backlog count is the number of review rows, measured not asserted');

    // THE boundary assertion. 3 rows are inside 24h (2h, 10h, 23h) and the 25h row is not.
    // Widening the production window to 48h pulls the 25h row in and makes this 4 — red.
    // Narrowing it to 12h drops the 23h row and makes this 2 — also red.
    assert.equal(health.reviewLast24h, 3, `counts only the last 24h, got ${health.reviewLast24h}`);
    console.log('ok   recent inflow counts the 23h row and excludes the 25h row (boundary is exact)');

    assert.equal(health.oldestAgeDays, 45, `oldest age in days, got ${health.oldestAgeDays}`);
    console.log('ok   the oldest age reaches the 45-day row, so nothing truncates the backlog');
  }

  // ── other states are excluded, proven by changing them ─────────────────────
  // If the predicate were dropped entirely the count would jump to 10; if it were inverted
  // it would fall. Both are caught here.
  {
    // The pending row is 1h old, so promoting it raises BOTH the total and recent inflow.
    await client.exec(`update fulfillment_line_claims set status = 'review' where status = 'pending'`);
    const health = await readInventoryClaimReviewHealth(query);
    assert.equal(health.reviewCount, 10, `a pending row promoted to review is now counted, got ${health.reviewCount}`);
    assert.equal(health.reviewLast24h, 4, `and it counts toward recent inflow, got ${health.reviewLast24h}`);
    console.log('ok   the count tracks real state changes, so the predicate is live');

    // Drain everything inside 24h: the 2h, 10h, 23h and promoted 1h rows leave review.
    // The 25h row must SURVIVE — if the production window were 48h it would have been
    // treated as recent, and this remaining-count assertion would also move.
    await client.exec(`update fulfillment_line_claims set status = 'applied' where created_at > now() - interval '24 hours'`);
    const drained = await readInventoryClaimReviewHealth(query);
    assert.equal(drained.reviewLast24h, 0, `draining the fresh rows drops recent inflow to zero, got ${drained.reviewLast24h}`);
    assert.equal(drained.reviewCount, 6, `the remaining backlog is the six rows older than 24h, got ${drained.reviewCount}`);
    console.log('ok   draining review rows lowers the backlog — a drain would be visible');
  }

  // ── the empty-result path returns zeros rather than NaN/undefined ──────────
  {
    await client.exec(`delete from fulfillment_line_claims`);
    const health = await readInventoryClaimReviewHealth(query);
    assert.equal(health.reviewCount, 0);
    assert.equal(health.oldestAgeDays, 0, 'coalesce keeps the age numeric when there are no rows');
    assert.ok(Number.isFinite(health.oldestAgeDays), 'age is a finite number, never NaN');
    console.log('ok   an empty result maps to zeros, not NaN or undefined');
  }

  await client.close();
  console.log('\nPASS PS-497 inventory claim review integration');
  console.log('Real PostgreSQL (PGlite, in-process). No production access, no writes outside the throwaway database.');
}

main().catch((err) => {
  console.error('\nFAIL PS-497 inventory claim review integration');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
