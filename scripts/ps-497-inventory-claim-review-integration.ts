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
  const query = (async (strings: TemplateStringsArray) => {
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
  // 7 review rows: 2 fresh (inside 24h), 5 old. Plus 3 rows in other states that must NOT
  // be counted — the probe reports the STRANDED backlog, not every claim.
  await client.exec(`
    insert into fulfillment_line_claims (status, created_at) values
      ('review',     now() - interval '2 hours'),
      ('review',     now() - interval '10 hours'),
      ('review',     now() - interval '3 days'),
      ('review',     now() - interval '9 days'),
      ('review',     now() - interval '20 days'),
      ('review',     now() - interval '25 days'),
      ('review',     now() - interval '30 days'),
      ('pending',    now() - interval '1 hour'),
      ('applied',    now() - interval '1 hour'),
      ('superseded', now() - interval '40 days');
  `);

  {
    const health = await readInventoryClaimReviewHealth(query);
    // THE assertion. `and false` on the predicate makes this 0 and fails here.
    assert.equal(health.reviewCount, 7, `counts every review row, got ${health.reviewCount}`);
    console.log('ok   the backlog count is the number of review rows, measured not asserted');

    assert.equal(health.reviewLast24h, 2, `counts only the last 24h, got ${health.reviewLast24h}`);
    console.log('ok   recent inflow counts only the last 24 hours');

    assert.equal(health.oldestAgeDays, 30, `oldest age in days, got ${health.oldestAgeDays}`);
    console.log('ok   the oldest age is the age of the oldest review row');
  }

  // ── other states are excluded, proven by changing them ─────────────────────
  // If the predicate were dropped entirely the count would jump to 10; if it were inverted
  // it would fall. Both are caught here.
  {
    await client.exec(`update fulfillment_line_claims set status = 'review' where status = 'pending'`);
    const health = await readInventoryClaimReviewHealth(query);
    assert.equal(health.reviewCount, 8, 'a pending row promoted to review is now counted');
    assert.equal(health.reviewLast24h, 3, 'and it counts toward recent inflow');
    console.log('ok   the count tracks real state changes, so the predicate is live');

    await client.exec(`update fulfillment_line_claims set status = 'applied' where created_at > now() - interval '24 hours'`);
    const drained = await readInventoryClaimReviewHealth(query);
    assert.equal(drained.reviewLast24h, 0, 'draining the fresh rows drops recent inflow to zero');
    assert.equal(drained.reviewCount, 5, 'and the remaining backlog is the older rows');
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
