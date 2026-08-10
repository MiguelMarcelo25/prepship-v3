// PS-497 — migration 0090, EXECUTED against real PostgreSQL (PGlite, in-process).
//
// The application rule is only half the fix. `quantity integer NOT NULL CHECK (quantity > 0)`
// is what FORCED the old normalizer to invent a 1: there was no legal way to record "unknown".
// Widening it without a replacement rule would let an unknown quantity reach a pending claim
// and, from there, a real stock movement.
//
// So this runs the actual migration file — not a paraphrase of it — and proves the resulting
// constraint permits exactly one thing: a null quantity on a review claim.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const client = new PGlite();

// The table as production has it TODAY, verified read-only against the live database:
// quantity is `integer NOT NULL`, and `fulfillment_line_claims_quantity_check` is
// `CHECK ((quantity > 0))`.
await client.exec(`
  create table fulfillment_line_claims (
    id serial primary key,
    lifecycle_event_id integer not null,
    order_id integer not null,
    line_key text not null,
    sku text,
    quantity integer not null constraint fulfillment_line_claims_quantity_check check (quantity > 0),
    direction text not null
      constraint fulfillment_line_claims_direction_check check (direction in ('deduct','reverse')),
    status text not null default 'pending'
      constraint fulfillment_line_claims_status_check
      check (status in ('pending','applied','superseded','reversed','review')),
    last_error text,
    idempotency_key text not null unique
  );
`);

let seq = 0;
const insert = (status: string, quantity: number | null) => {
  seq += 1;
  return client.query(
    `insert into fulfillment_line_claims
       (lifecycle_event_id, order_id, line_key, sku, quantity, direction, status, idempotency_key)
     values (1, 1, $1, 'SKU-1', $2, 'deduct', $3, $1)`,
    [`line-${seq}`, quantity, status],
  );
};
const rejects = async (fn: () => Promise<unknown>, why: string) => {
  await assert.rejects(fn, /violates check constraint|null value/i, why);
};

// ── before the migration ─────────────────────────────────────────────────────
await check('BEFORE: a review claim cannot record an unknown quantity at all', async () => {
  await rejects(() => insert('review', null),
    'this is exactly why the old normalizer had to fabricate a 1');
});

// ── apply the real migration ─────────────────────────────────────────────────
const migration = readFileSync('drizzle/0090_fulfillment_claim_nullable_quantity.sql', 'utf8');
await client.exec(migration);
console.log('ok   migration 0090 applied from its own file, not a paraphrase');

await check('the old blanket positive check is gone', async () => {
  const { rows } = await client.query(
    `select 1 from pg_constraint where conname = 'fulfillment_line_claims_quantity_check'`,
  );
  assert.equal(rows.length, 0);
});
await check('the new state check is present', async () => {
  const { rows } = await client.query(
    `select 1 from pg_constraint where conname = 'fulfillment_line_claims_quantity_state_check'`,
  );
  assert.equal(rows.length, 1);
});

// ── what the new rule permits ────────────────────────────────────────────────
await check('a review claim may record an unknown quantity', async () => {
  await insert('review', null);
});
await check('a pending claim with a positive quantity still inserts, unchanged', async () => {
  await insert('pending', 2);
});

// ── what it forbids ──────────────────────────────────────────────────────────
for (const status of ['pending', 'applied', 'superseded', 'reversed']) {
  await check(`a ${status} claim cannot carry an unknown quantity`, async () => {
    await rejects(() => insert(status, null),
      `${status} is deductable work — an unknown quantity must never reach a stock movement`);
  });
}
await check('zero is still rejected on deductable work', async () => {
  await rejects(() => insert('pending', 0), 'zero was never a legal deduction and still is not');
});
await check('zero is rejected even on a review claim', async () => {
  // Zero is recorded as `quantity: null` with reason `zero_quantity`, never as a literal 0.
  await rejects(() => insert('review', 0), 'the unknown-quantity encoding is NULL, not 0');
});
await check('a negative quantity is rejected on every status', async () => {
  await rejects(() => insert('pending', -1), 'negative');
  await rejects(() => insert('review', -1), 'negative');
});

// ── promotion out of review ──────────────────────────────────────────────────
await check('a review claim cannot be promoted to pending without supplying a quantity', async () => {
  const { rows } = await client.query(
    `insert into fulfillment_line_claims
       (lifecycle_event_id, order_id, line_key, sku, quantity, direction, status, idempotency_key)
     values (1, 1, 'promote-me', 'SKU-1', null, 'deduct', 'review', 'promote-me') returning id`,
  );
  const id = (rows[0] as { id: number }).id;
  await rejects(
    () => client.query(`update fulfillment_line_claims set status = 'pending' where id = $1`, [id]),
    'a future review-queue drain must not be able to promote an unknown quantity',
  );
  // It CAN be promoted when a real quantity is supplied in the same statement.
  await client.query(
    `update fulfillment_line_claims set status = 'pending', quantity = 3 where id = $1`,
    [id],
  );
  const { rows: after } = await client.query(
    `select status, quantity from fulfillment_line_claims where id = $1`, [id],
  );
  assert.deepEqual(after[0], { status: 'pending', quantity: 3 });
});

// ── the historical rows still satisfy the new rule ───────────────────────────
await check('every existing production row shape still validates', async () => {
  // Production holds: 2,950 review + 1 superseded + 9 review + 1 review + 263 applied, all
  // with positive quantities. The migration must not invalidate a single one.
  await insert('review', 1);       // the 2,950 fabricated-1 review rows
  await insert('superseded', 1);   // the one superseded row
  await insert('applied', 4);      // applied rows run 1..4
  console.log('     (review/superseded/applied with positive quantities all still insert)');
});

await client.close();

if (failures > 0) {
  console.error(`\nPS-497 claim quantity constraint integration FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 claim quantity constraint integration');
console.log('Real PostgreSQL (PGlite, in-process). No production access, no writes outside the throwaway database.');
