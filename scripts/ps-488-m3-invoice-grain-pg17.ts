/**
 * PS-488 M3 — invoice row grain, real PostgreSQL 17.
 *
 * The M3 grouping change is otherwise only source-text asserted (ps-425 checks that
 * `b.return_id` appears in the key). A regex proves what the clause LOOKS like, not what
 * PostgreSQL does with it — and the two claims this change rests on are both claims about
 * database behaviour, not about text:
 *
 *   1. adding b.return_id CANNOT split an outbound group, because outbound lines carry it
 *      NULL and GROUP BY treats NULLs as equal;
 *   2. it DOES split two return events raised on one order in one billing day, which
 *      before M3 collapsed into a single invoice row.
 *
 * If (1) were false this would shatter every outbound invoice row that has a NULL
 * grouping value — a catastrophic, silent cardinality change. It is asserted here rather
 * than assumed.
 *
 * The GROUP BY and ORDER BY clauses are EXTRACTED FROM src/routes/billing.ts rather than
 * retyped. A hand-copied clause proves only the copy's semantics, and would keep passing
 * after production drifted away from it.
 *
 * UNSKIPPABLE: absent PS488_PG17_ADMIN_URL this FAILS.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const ADMIN_URL = process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS488_PG17_ADMIN_URL is not set. This proof is unskippable.');
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error(`FAIL: refusing non-ephemeral host "${host}"`);
    process.exit(1);
  }
}

let failures = 0;
let counter = 0;

// ── the clauses under test, taken from production source ─────────────────────
const ROUTE = readFileSync('src/routes/billing.ts', 'utf8');

function clean(clause: string): string {
  // Drop the SQL comments and newlines the source carries inside the clause.
  return clause
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function die(label: string): never {
  console.error(`FAIL: could not extract the ${label} clause from src/routes/billing.ts.`);
  console.error('This proof is worthless against a clause it cannot find — re-anchor it.');
  process.exit(1);
}

// Anchored POSITIONALLY, not by first match. The invoice query contains a correlated
// subquery with its own `order by oi.line_index`, so a plain /order by .../ found that
// one and silently swallowed the whole FROM clause with it — producing a syntax error
// rather than testing the wrong thing, which is the good failure mode, but only by luck.
const GROUP_BY_AT = ROUTE.search(/\n\s*group by b\.order_id,/);
if (GROUP_BY_AT < 0) die('GROUP BY');
const GROUP_BY = clean(
  /\n\s*group by ([\s\S]*?)\n\s*(?:--[^\n]*\n\s*)*order by/.exec(ROUTE.slice(GROUP_BY_AT))?.[1] ?? die('GROUP BY'),
);
const ORDER_BY_TAIL = clean(
  /\n\s*order by ([\s\S]*?)\n\s*`\);/.exec(ROUTE.slice(GROUP_BY_AT))?.[1] ?? die('ORDER BY'),
);

// The invoice's effective-day expression is interpolated in production. Substituting the
// equivalent literal keeps this test about the GRAIN, which is what M3 changed.
const EFFECTIVE_DAY = "coalesce(b.billing_effective_date, b.ship_date)";
const ORDER_BY = ORDER_BY_TAIL.replace(/\$\{invoiceEffectiveDay\}/g, EFFECTIVE_DAY);

// A DEDICATED schema, dropped and recreated per run.
//
// The fixture tables are named orders / returns / billing_line_items — exactly what a
// real database holds. Creating them in `public` and dropping them to make the run
// repeatable would mean this script contains `drop table ... orders`, one wrong
// connection string away from being catastrophic. Confining everything to ps488_m3 means
// the only destructive statement names a schema that nothing else could own, and the
// loopback host check stops being the single line of defence.
const FIXTURE_SCHEMA = 'ps488_m3';

const SCHEMA = `
  drop schema if exists ${FIXTURE_SCHEMA} cascade;
  create schema ${FIXTURE_SCHEMA};
  set search_path to ${FIXTURE_SCHEMA};
  create table returns (id serial primary key, order_id integer);
  create table orders (id serial primary key, order_status text, canonical_status text);
  create table shipments (id serial primary key);
  create table billing_line_items (
    id serial primary key, client_id integer not null, order_id integer,
    order_number text, shipment_id integer, ship_date timestamptz,
    billing_effective_date timestamptz, billing_policy_version text,
    billing_adjustment_id text, source_finalization_id text,
    line_type text not null, description text not null,
    qty numeric(10,2) not null default '1', unit_cost numeric(10,2) not null default '0',
    total_cost numeric(10,2) not null, return_id integer references returns(id)
  );
`;

/**
 * The production grouping, run for real. Only the aggregate list is reduced — every
 * grouping and ordering term is the extracted production text.
 */
const GRAIN_SQL = `
  select b.order_id, b.shipment_id, b.return_id,
         sum(b.total_cost)::text as row_total,
         count(*)::int as line_count
  from billing_line_items b
  left join shipments s on s.id = b.shipment_id
  left join orders o on o.id = b.order_id
  where b.client_id = 1
  group by ${GROUP_BY}
  order by ${ORDER_BY}
`;

// One connection, one database, truncated between checks.
//
// Deliberately NOT create-database-per-check like the M2 proofs: those need role and RLS
// isolation, this needs only a clean table. Staying inside one database also lets the
// exact same file run against the CI postgres:17 service container and against a local
// PGlite socket (PGlite is a single-database engine and cannot CREATE DATABASE), so the
// clause is proven on the developer's machine by the same code CI runs — not by a
// second, drifting local variant.
const db = postgres(ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} });

// Every statement is schema-qualified through search_path, set once on this single
// pooled connection. max:1 is what makes a session-level SET reliable here.
const TRUNCATE_ALL = `truncate ${FIXTURE_SCHEMA}.billing_line_items, ${FIXTURE_SCHEMA}.returns, ${FIXTURE_SCHEMA}.orders, ${FIXTURE_SCHEMA}.shipments restart identity cascade`;

// Reported, not asserted, so the output always says what it actually ran against.
{
  const [row] = await db`show server_version`;
  console.log(`server_version = ${row?.server_version ?? 'unknown'}`);
}
await db.unsafe(SCHEMA);

async function check(name: string, fn: (db: postgres.Sql) => Promise<void>): Promise<void> {
  counter += 1;
  await db.unsafe(TRUNCATE_ALL);
  try {
    await fn(db);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const DAY = '2026-05-05T00:00:00.000Z';

type Line = {
  orderId: number; shipmentId?: number | null; returnId?: number | null;
  lineType: string; total: string; day?: string;
};

async function seed(db: postgres.Sql, lines: Line[]): Promise<void> {
  for (const [i, l] of lines.entries()) {
    await db`
      insert into billing_line_items
        (client_id, order_id, order_number, shipment_id, return_id, ship_date,
         billing_effective_date, line_type, description, total_cost)
      values (1, ${l.orderId}, ${String(l.orderId)}, ${l.shipmentId ?? null}, ${l.returnId ?? null},
              ${l.day ?? DAY}, ${l.day ?? DAY}, ${l.lineType}, ${`line-${i}`}, ${l.total})
    `;
  }
}

// ── the claim the whole change rests on ──────────────────────────────────────
await check('b.return_id does NOT split outbound groups (NULLs group as equal)', async (db) => {
  await db`insert into orders (id) values (4242)`;
  await db`insert into shipments (id) values (501)`;
  // Three outbound lines of ONE shipment: the ordinary case, every return_id NULL.
  await seed(db, [
    { orderId: 4242, shipmentId: 501, lineType: 'pick_pack', total: '2.50' },
    { orderId: 4242, shipmentId: 501, lineType: 'package_cost', total: '1.00' },
    { orderId: 4242, shipmentId: 501, lineType: 'shipping', total: '4.25' },
  ]);
  const rows = await db.unsafe(GRAIN_SQL);
  assert.equal(rows.length, 1, 'three lines of one shipment must stay ONE invoice row');
  assert.equal(rows[0]!.line_count, 3);
  assert.equal(Number(rows[0]!.row_total), 7.75, 'no money may be lost to the new key');
});

await check('PS-425 shipment grain survives the new key', async (db) => {
  await db`insert into orders (id) values (4242)`;
  await db`insert into shipments (id) values (501), (502)`;
  await seed(db, [
    { orderId: 4242, shipmentId: 501, lineType: 'shipping', total: '5.00' },
    { orderId: 4242, shipmentId: 502, lineType: 'shipping', total: '7.00' },
  ]);
  const rows = await db.unsafe(GRAIN_SQL);
  assert.equal(rows.length, 2, 'two shipments of one order must stay TWO invoice rows');
  assert.deepEqual(rows.map((r) => r.shipment_id), [502, 501], 'shipment desc, unchanged');
});

// ── the defect M3 fixes ──────────────────────────────────────────────────────
await check('two returns on one order in one day are TWO rows', async (db) => {
  await db`insert into orders (id) values (4242)`;
  await db`insert into returns (id, order_id) values (7, 4242), (8, 4242)`;
  await seed(db, [
    { orderId: 4242, returnId: 7, lineType: 'return_postage', total: '7.73' },
    { orderId: 4242, returnId: 7, lineType: 'return_processing_fee', total: '3.00' },
    { orderId: 4242, returnId: 8, lineType: 'return_postage', total: '5.00' },
  ]);
  const rows = await db.unsafe(GRAIN_SQL);
  assert.equal(rows.length, 2, 'each return event is its own invoice row');
  const byReturn = new Map(rows.map((r) => [r.return_id, Number(r.row_total)]));
  assert.equal(byReturn.get(7), 10.73);
  assert.equal(byReturn.get(8), 5);
});

await check('the SAME fixture collapsed to one row BEFORE the key was added', async (db) => {
  // The defect, reproduced against the production clause with b.return_id removed. Without
  // this the test above proves only "two rows appear", not that the key is what causes it.
  // return_id has to come out of the SELECT list and the ORDER BY as well, not only the
  // GROUP BY: PostgreSQL rejects projecting or ordering by a column that is neither
  // grouped nor aggregated. That rejection is itself a small confirmation that the key is
  // load-bearing rather than decorative.
  const withoutReturnId = GRAIN_SQL
    .replace(/,\s*b\.return_id asc nulls first/g, '')
    .replace(/b\.return_id,\s*/g, '');
  // Checked against the GROUP BY clause alone. Scanning the whole statement matched the
  // SELECT list, which legitimately still projects b.return_id — so the self-check passed
  // whether or not the control had actually been stripped of the key it controls for.
  const controlKeys = /group by ([^\n]*)/.exec(withoutReturnId)?.[1] ?? '';
  assert.ok(controlKeys.length > 0, 'the control query must still have a GROUP BY');
  assert.ok(!controlKeys.includes('b.return_id'),
    'the control query must actually be missing the key it is controlling for');
  await db`insert into orders (id) values (4242)`;
  await db`insert into returns (id, order_id) values (7, 4242), (8, 4242)`;
  await seed(db, [
    { orderId: 4242, returnId: 7, lineType: 'return_postage', total: '7.73' },
    { orderId: 4242, returnId: 7, lineType: 'return_processing_fee', total: '3.00' },
    { orderId: 4242, returnId: 8, lineType: 'return_postage', total: '5.00' },
  ]);
  const rows = await db.unsafe(withoutReturnId);
  assert.equal(rows.length, 1, 'the pre-M3 clause merged both returns — this is the defect');
  assert.equal(Number(rows[0]!.row_total), 15.73,
    'the money was right, which is exactly why the merge went unnoticed');
});

await check('an outbound shipment and a return on one order stay separate', async (db) => {
  await db`insert into orders (id) values (4242)`;
  await db`insert into shipments (id) values (501)`;
  await db`insert into returns (id, order_id) values (7, 4242)`;
  await seed(db, [
    { orderId: 4242, shipmentId: 501, lineType: 'pick_pack', total: '2.50' },
    { orderId: 4242, returnId: 7, lineType: 'return_postage', total: '7.73' },
  ]);
  const rows = await db.unsafe(GRAIN_SQL);
  assert.equal(rows.length, 2);
  const outbound = rows.find((r) => r.shipment_id === 501)!;
  assert.equal(Number(outbound.row_total), 2.5, 'no return fee may hide behind the outbound row');
});

// ── ordering is deterministic, which the new tie made necessary ──────────────
await check('two returns on one order order deterministically, not by arrival', async (db) => {
  // Both rows agree on effective day, order and a NULL shipment_id, so before the
  // return_id tiebreak their relative order was unconstrained — the same frozen period
  // could render in two different sequences.
  const sequences: unknown[][] = [];
  for (const arrival of [[8, 7], [7, 8]]) {
    await db.unsafe(TRUNCATE_ALL);
    await db`insert into orders (id) values (4242)`;
    await db`insert into returns (id, order_id) values (7, 4242), (8, 4242)`;
    await seed(db, arrival.map((id) => (
      { orderId: 4242, returnId: id, lineType: 'return_postage', total: '1.00' }
    )));
    const rows = await db.unsafe(GRAIN_SQL);
    sequences.push(rows.map((r) => r.return_id));
  }
  assert.deepEqual(sequences[0], sequences[1],
    'reversing insert order must not reorder the invoice');
  assert.deepEqual(sequences[0], [7, 8], 'ascending return_id, matching reconcileInvoiceRows');
});

await db.end({ timeout: 5 });

if (failures > 0) {
  console.error(`\nFAIL PS-488 M3 invoice grain PG17 proof (${failures} failing)`);
  process.exit(1);
}
console.log(`\nPASS PS-488 M3 invoice grain PG17 proof (${counter} checks)`);
