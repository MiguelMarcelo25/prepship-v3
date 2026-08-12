/**
 * PS-488 M2 — behavioural writer proof, real PostgreSQL 17.
 *
 * The wiring guard is source-text. Hermes's ruling is correct that it is bypassable
 * through variables, helpers, raw SQL, aliases or another module: a regex proves what
 * the source LOOKS like, not what the database ENDS UP holding. This proves the
 * outcome instead, against the real 0092 contract.
 *
 * What it pins:
 *   - with RETURN_BILLING_ENABLED false, an outbound regeneration sweep must NOT
 *     delete canonical return rows (the M2 blocker)
 *   - the database refuses a canonical return row without relational identity being
 *     duplicated, and refuses a legacy alias carrying identity
 *   - two returns on one order remain two separate rows
 *   - finalized/invoiced rows are untouched by the sweep
 *
 * UNSKIPPABLE: absent PS488_PG17_ADMIN_URL this FAILS.
 */
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { billingLineItems } from '../src/db/schema/billing.js';
import {
  CANONICAL_RETURN_WRITE_LINE_TYPES,
  LEGACY_RETURN_READ_ONLY_LINE_TYPES,
} from '../src/services/billing-return-event-contract.js';
import {
  deleteOutboundBillingLinesForRebuild,
  type OutboundSweepExecutor,
} from '../src/services/billing-outbound-sweep.js';

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

const canonicalList = CANONICAL_RETURN_WRITE_LINE_TYPES.map((t) => `'${t}'`).join(', ');

const SCHEMA = `
  create table public.returns (id serial primary key, order_id integer);
  create table public.billing_line_items (
    id serial primary key, client_id integer not null, order_id integer,
    order_number text, shipment_id integer, ship_date timestamptz,
    billing_effective_date timestamptz, line_type text not null, description text not null,
    qty numeric(10,2) not null default '1', unit_cost numeric(10,2) not null,
    total_cost numeric(10,2) not null, invoiced boolean not null default false,
    return_id integer
  );
  alter table public.billing_line_items
    add constraint billing_line_items_return_id_returns_id_fk
    foreign key (return_id) references public.returns(id) on delete restrict;
  alter table public.billing_line_items
    add constraint billing_li_return_id_canonical_type_check
    check (return_id is null or line_type in (${canonicalList}));
  create unique index billing_li_return_identity_unq
    on public.billing_line_items (return_id, line_type) where return_id is not null;
`;

const admin = () => postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });

async function fresh(): Promise<{ name: string; url: string; db: postgres.Sql }> {
  counter += 1;
  const name = `ps488_writer_${process.pid}_${counter}`;
  const a = admin();
  try {
    await a.unsafe(`drop database if exists ${name}`);
    await a.unsafe(`create database ${name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await db.unsafe(SCHEMA);
  return { name, url: url.toString(), db };
}

async function drop(name: string): Promise<void> {
  const a = admin();
  try {
    await a.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${name}' and pid <> pg_backend_pid()`,
    );
    await a.unsafe(`drop database if exists ${name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
}

async function check(name: string, fn: (db: postgres.Sql, url: string) => Promise<void>): Promise<void> {
  const { name: dbName, url, db } = await fresh();
  try {
    await fn(db, url);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await db.end({ timeout: 5 });
    await drop(dbName);
  }
}

/**
 * Runs the PRODUCTION sweep owner — not a reproduced DELETE.
 *
 * deleteOutboundBillingLinesForRebuild is the same function src/services/billing.ts
 * calls, so this cannot pass while production diverges. A copied statement would only
 * ever prove the copy's semantics. The scope predicate mirrors the generator's
 * window/editability terms; the return-preservation term comes from the owner itself
 * and is deliberately NOT restated here.
 */
async function runProductionSweep(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const db = drizzle(client, { casing: 'snake_case' });
    await deleteOutboundBillingLinesForRebuild(
      db as unknown as OutboundSweepExecutor,
      and(sql`${billingLineItems.orderId} is not null`, eq(billingLineItems.invoiced, false)),
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * The PRE-M2 behaviour, for the contrast case only: the same scope with no
 * return-preservation term. This exists solely to prove the fix is load-bearing, and
 * is never used as the definition of correct behaviour.
 */
async function runUnprotectedSweep(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.unsafe(
      `delete from public.billing_line_items where order_id is not null and invoiced = false`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

const legacyList = LEGACY_RETURN_READ_ONLY_LINE_TYPES.map((t) => `'${t}'`).join(', ');

/**
 * Fixture carries BOTH vocabularies, uninvoiced and therefore sweepable.
 *
 * The legacy rows are the ones the previous submission left exposed: they hold real
 * historical return money, carry no relational identity, and nothing recreates them
 * if an outbound sweep deletes them.
 */
async function seed(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    insert into public.returns (id, order_id) values (25, 3074), (26, 3074);
    select setval('public.returns_id_seq', 100);
    insert into public.billing_line_items
      (client_id, order_id, ship_date, billing_effective_date, line_type, description,
       unit_cost, total_cost, invoiced, return_id)
    values
      (17, 3074, now(), now(), 'pick_pack',             'pp',         '2.50','2.50', false, null),
      (17, 3074, now(), now(), 'additional_unit',       'addl',       '0.75','0.75', false, null),
      -- canonical, relationally identified
      (17, 3074, now(), now(), 'return_postage',        'postage 25', '7.73','7.73', false, 25),
      (17, 3074, now(), now(), 'return_processing_fee', 'proc 25',    '3.00','3.00', false, 25),
      (17, 3074, now(), now(), 'return_postage',        'postage 26', '6.77','6.77', false, 26),
      -- frozen legacy history: real money, no identity, uninvoiced and sweepable
      (17, 3074, now(), now(), 'return_label',          'legacy lbl', '1.11','1.11', false, null),
      (17, 3074, now(), now(), 'return_processing',     'legacy proc','2.22','2.22', false, null),
      (17, 3074, now(), now(), 'return',                'legacy bare','3.33','3.33', false, null),
      -- finalized row, must never be swept
      (17, 3074, now(), now(), 'return_postage',        'frozen',     '9.99','9.99', true,  null);
  `);
}

const countWhere = async (db: postgres.Sql, where: string): Promise<number> => {
  const [row] = await db.unsafe<{ n: string }[]>(
    `select count(*)::text as n from public.billing_line_items where ${where}`,
  );
  return Number(row!.n);
};

async function main(): Promise<void> {
  console.log('PS-488 M2 writer behaviour — real PostgreSQL 17\n');

  await check('THE M2 BLOCKER: the PRODUCTION sweep preserves CANONICAL return rows', async (db, url) => {
    await seed(db);
    assert.equal(await countWhere(db, `line_type in (${canonicalList}) and invoiced = false`), 3);

    await runProductionSweep(url);

    assert.equal(
      await countWhere(db, `line_type in (${canonicalList}) and invoiced = false`),
      3,
      'every canonical return row must survive an outbound regeneration',
    );
  });

  await check('THE M2 BLOCKER: the PRODUCTION sweep preserves FROZEN LEGACY return rows', async (db, url) => {
    await seed(db);
    assert.equal(await countWhere(db, `line_type in (${legacyList})`), 3, 'fixture must seed all three legacy types');

    await runProductionSweep(url);

    assert.equal(
      await countWhere(db, `line_type in (${legacyList})`),
      3,
      'legacy return rows carry real historical money and nothing recreates them',
    );
  });

  await check('the production sweep still removes eligible outbound rows', async (db, url) => {
    await seed(db);
    assert.equal(await countWhere(db, `line_type in ('pick_pack','additional_unit')`), 2);
    await runProductionSweep(url);
    assert.equal(
      await countWhere(db, `line_type in ('pick_pack','additional_unit')`),
      0,
      'preservation must not turn the sweep into a no-op',
    );
  });

  await check('the UNPROTECTED sweep destroys both vocabularies — the fix is load-bearing', async (db, url) => {
    await seed(db);
    // Pre-M2 behaviour, for contrast only. Never the definition of correct.
    await runUnprotectedSweep(url);
    assert.equal(
      await countWhere(db, `line_type in (${canonicalList}) and invoiced = false`),
      0,
      'the old sweep deleted uninvoiced canonical return rows',
    );
    assert.equal(
      await countWhere(db, `line_type in (${legacyList})`),
      0,
      'and it deleted frozen legacy return money too — permanently, since nothing recreates it',
    );
  });

  await check('finalized/invoiced rows are never swept', async (db, url) => {
    await seed(db);
    await runProductionSweep(url);
    assert.equal(await countWhere(db, `invoiced = true`), 1, 'a finalized row must remain');
  });

  await check('two returns on one order remain two separate rows', async (db) => {
    await seed(db);
    const [row] = await db.unsafe<{ n: string }[]>(
      `select count(distinct return_id)::text as n from public.billing_line_items
        where return_id is not null`,
    );
    assert.equal(Number(row!.n), 2, 'returns 25 and 26 must not collapse');
  });

  await check('the database refuses a duplicate (return_id, line_type)', async (db) => {
    await seed(db);
    await assert.rejects(
      db`insert into public.billing_line_items
           (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, return_id)
         values (17, 3074, now(), now(), 'return_postage', 'dupe', '1.00','1.00', 25)`,
      /billing_li_return_identity_unq|duplicate key/i,
    );
  });

  for (const legacy of LEGACY_RETURN_READ_ONLY_LINE_TYPES) {
    await check(`the database refuses legacy '${legacy}' carrying relational identity`, async (db) => {
      await seed(db);
      await assert.rejects(
        db`insert into public.billing_line_items
             (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, return_id)
           values (17, 3074, now(), now(), ${legacy}, 'alias with identity', '1.00','1.00', 26)`,
        /canonical_type_check|violates check/i,
      );
    });
  }

  await check('legacy rows with return_id NULL remain writable and readable — history compatibility', async (db) => {
    await seed(db);
    // The fixture already seeds a return_label row, so a flat count of 1 was wrong:
    // it counted the seeded row and the newly written one. Assert the DELTA, which
    // does not assume an empty fixture and still fails if the insert is refused.
    const before = await countWhere(db, `line_type = 'return_label' and return_id is null`);

    await db`insert into public.billing_line_items
        (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost)
      values (17, 3075, now(), now(), 'return_label', 'frozen history', '1.11','1.11')`;

    const after = await countWhere(db, `line_type = 'return_label' and return_id is null`);
    assert.equal(after, before + 1, 'a legacy row with NULL identity must still be writable');

    // Read the exact row back. Proves readability of THIS row rather than inferring
    // it from a total, so the assertion cannot be satisfied by the seeded row.
    assert.equal(
      await countWhere(
        db,
        `line_type = 'return_label'
           and return_id is null
           and order_id = 3075
           and description = 'frozen history'`,
      ),
      1,
      'the newly written legacy row must be readable by its own identity',
    );
  });

  if (failures) {
    console.error(`\nFAIL ps-488 M2 writer behaviour (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-488 M2 writer behaviour');
}

await main();
