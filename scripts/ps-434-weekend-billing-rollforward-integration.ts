import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  billingLineEffectiveDayRangeSql,
  billingProviderActivityTimestampSql,
  billingSourceCalendarSql,
} from '../src/services/billing-calendar-policy.js';

const db = new PGlite();
const orm = drizzle(db);

await db.exec(`
  create table billing_line_items (
    id serial primary key,
    client_id integer not null,
    order_id integer,
    shipment_id integer,
    ship_date timestamptz,
    line_type text not null,
    description text not null,
    total_cost numeric(10,2) not null,
    invoiced boolean not null default false
  );
  create table billing_finalizations (
    id text primary key,
    client_id integer not null,
    period_start timestamptz not null,
    period_end timestamptz not null
  );
  insert into billing_line_items (
    client_id, order_id, shipment_id, ship_date, line_type, description, total_cost
  ) values
    (1, 101, 1001, '2026-07-11T00:00:00Z', 'shipping', 'legacy Saturday', 5.25),
    (1, 102, 1002, '2026-07-13T00:00:00Z', 'shipping', 'legacy Monday', 7.50);
`);

const before = await db.query<{ id: number; ship_date: string; total_cost: string }>(
  'select id, ship_date::text, total_cost::text from billing_line_items order by id',
);
await db.exec(readFileSync('drizzle/0071_billing_weekend_rollforward.sql', 'utf8'));
// Production already owns this trigger from migration 0065. The isolated
// fixture creates the same trigger after applying 0071 so the replacement
// function is exercised without re-creating the full close-workflow schema.
await db.exec(`
  create trigger billing_line_items_closed_period_guard
    before insert or update or delete on billing_line_items
    for each row execute function billing_line_items_block_closed_period_mutation();
`);

const after = await db.query<{
  id: number;
  ship_date: string;
  total_cost: string;
  billing_effective_date: string | null;
  billing_policy_version: string | null;
}>(`select id, ship_date::text, total_cost::text,
      billing_effective_date::text, billing_policy_version
    from billing_line_items order by id`);
assert.deepEqual(
  after.rows.map(({ id, ship_date, total_cost }) => ({ id, ship_date, total_cost })),
  before.rows,
);
assert.ok(after.rows.every((row) =>
  row.billing_effective_date == null && row.billing_policy_version == null));

await db.exec(`
  create table provider_activity_fixture (
    id integer primary key,
    raw_activity text not null,
    legacy_day timestamptz not null
  );
  insert into provider_activity_fixture (id, raw_activity, legacy_day) values
    (1, '2026-07-18', '2026-07-18T00:00:00Z'),
    (2, '2026-07-19T06:30:00Z', '2026-07-19T00:00:00Z'),
    (3, '2026-07-13', '2026-07-13T00:00:00Z');
`);
const providerTimestamp = billingProviderActivityTimestampSql(sql`raw_activity`);
const providerCalendar = billingSourceCalendarSql({
  sourceTimestamp: providerTimestamp,
  legacyActivityDay: sql`legacy_day`,
  effectiveDate: '2026-07-13',
});
const providerProjection = await orm.execute<{
  id: number;
  actual_day: string;
  effective_day: string;
  policy_version: string;
}>(sql`
  select
    id,
    to_char(${providerCalendar.actualActivityDay} at time zone 'UTC', 'YYYY-MM-DD') as actual_day,
    to_char(${providerCalendar.billingEffectiveDay} at time zone 'UTC', 'YYYY-MM-DD') as effective_day,
    ${providerCalendar.policyVersion} as policy_version
  from provider_activity_fixture
  order by id
`);
assert.deepEqual(providerProjection.rows, [
  {
    id: 1,
    actual_day: '2026-07-18',
    effective_day: '2026-07-20',
    policy_version: 'weekday_weekend_rollforward_v2',
  },
  {
    id: 2,
    actual_day: '2026-07-18',
    effective_day: '2026-07-20',
    policy_version: 'weekday_weekend_rollforward_v2',
  },
  {
    id: 3,
    actual_day: '2026-07-13',
    effective_day: '2026-07-13',
    policy_version: 'weekday_weekend_rollforward_v2',
  },
]);

await db.exec(`
  insert into billing_line_items (
    client_id, order_id, shipment_id, ship_date, billing_effective_date,
    billing_policy_version, line_type, description, total_cost
  ) values
    (1, 201, 2001, '2026-07-18T00:00:00Z', '2026-07-20T00:00:00Z',
      'weekday_weekend_rollforward_v2', 'shipping', 'Saturday order', 10.00),
    (1, 202, 2002, '2026-07-19T00:00:00Z', '2026-07-20T00:00:00Z',
      'weekday_weekend_rollforward_v2', 'shipping', 'Sunday order', 11.00),
    (1, 203, 2003, '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z',
      'weekday_weekend_rollforward_v2', 'shipping', 'Monday order', 12.00);
`);

const monday = await db.query<{ order_id: number; total_cost: string }>(`
  select order_id, total_cost::text
  from billing_line_items
  where coalesce(billing_effective_date, ship_date) >= '2026-07-20T00:00:00Z'
    and coalesce(billing_effective_date, ship_date) < '2026-07-21T00:00:00Z'
  order by order_id
`);
assert.deepEqual(monday.rows.map((row) => row.order_id), [201, 202, 203]);
assert.equal(monday.rows.reduce((sum, row) => sum + Number(row.total_cost), 0), 33);

// Regression: Drizzle's gte()/lt() loses the timestamp encoder when the left
// side is coalesce(...), leaving postgres.js to reject raw Date parameters.
// The canonical boundary must compile Dates to explicit ISO timestamptz values.
const mondayRange = billingLineEffectiveDayRangeSql(
  sql`billing_effective_date`,
  sql`ship_date`,
  new Date('2026-07-20T00:00:00Z'),
  new Date('2026-07-21T00:00:00Z'),
);
const renderedMondayRange = new PgDialect().sqlToQuery(sql`
  select order_id
  from billing_line_items
  where ${mondayRange}
  order by order_id
`);
assert.deepEqual(renderedMondayRange.params, [
  '2026-07-20T00:00:00.000Z',
  '2026-07-21T00:00:00.000Z',
]);
const mondayViaOwner = await orm.execute<{ order_id: number }>(sql`
  select order_id
  from billing_line_items
  where ${mondayRange}
  order by order_id
`);
assert.deepEqual(mondayViaOwner.rows.map((row) => row.order_id), [201, 202, 203]);

const legacyWeekend = await db.query<{ total: string }>(`
  select coalesce(sum(total_cost), 0)::text as total
  from billing_line_items
  where coalesce(billing_effective_date, ship_date) >= '2026-07-11T00:00:00Z'
    and coalesce(billing_effective_date, ship_date) < '2026-07-12T00:00:00Z'
`);
assert.equal(legacyWeekend.rows[0]?.total, '5.25');

await db.exec(`insert into billing_finalizations (id, client_id, period_start, period_end)
  values ('monday-close', 1, '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z')`);
await assert.rejects(() => db.exec(`
  insert into billing_line_items (
    client_id, order_id, shipment_id, ship_date, billing_effective_date,
    billing_policy_version, line_type, description, total_cost
  ) values (
    1, 204, 2004, '2026-07-19T00:00:00Z', '2026-07-20T00:00:00Z',
    'weekday_weekend_rollforward_v2', 'shipping', 'late Sunday order', 9.00
  )
`), /BILLING_PERIOD_FINALIZED/);

console.log('PS-434 migrated-database integration passed');
