/**
 * Audit 2026-07-13 B-5 cross-period billing reconciliation guard.
 *
 * Offline only: PGlite plus source inspection. No configured DB connection,
 * provider call, label/postage purchase, marketplace notification, inventory
 * change, or production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const pg = new PGlite();
await pg.exec(`
  create table billing_line_items (
    id serial primary key,
    order_id integer,
    ship_date timestamptz,
    line_type text not null,
    description text not null,
    invoiced boolean not null default false,
    unique (order_id, line_type, description)
  );
  insert into billing_line_items
    (order_id, ship_date, line_type, description, invoiced)
  values
    (101, '2026-06-15T00:00:00Z', 'shipping', 'Shipping order 101', false),
    (202, '2026-07-05T00:00:00Z', 'shipping', 'Stale July order 202', false),
    (303, '2026-06-20T00:00:00Z', 'shipping', 'Finalized order 303', true),
    (404, '2026-06-21T00:00:00Z', 'shipping', 'Unrelated order 404', false);
`);

// Candidate 101 moved from June into the requested July period. Reconciliation
// removes its old editable line across periods and also preserves the existing
// requested-window sweep for stale order 202.
await pg.exec(`
  delete from billing_line_items
  where order_id is not null
    and invoiced = false
    and (
      order_id in (101)
      or (
        ship_date >= '2026-07-01T00:00:00Z'::timestamptz
        and ship_date < '2026-08-01T00:00:00Z'::timestamptz
      )
    );
`);
await pg.exec(`
  insert into billing_line_items
    (order_id, ship_date, line_type, description, invoiced)
  values
    (101, '2026-07-15T00:00:00Z', 'shipping', 'Shipping order 101', false)
  on conflict (order_id, line_type, description) do nothing;
`);

const rows = await pg.query<{
  order_id: number;
  ship_date: string;
  invoiced: boolean;
}>('select order_id, ship_date, invoiced from billing_line_items order by order_id');
assert.deepEqual(rows.rows.map((row) => row.order_id), [101, 303, 404]);
assert.equal(
  new Date(rows.rows[0]!.ship_date).toISOString(),
  '2026-07-15T00:00:00.000Z',
  'the candidate order must move to its canonical current period',
);
assert.equal(rows.rows[1]!.invoiced, true, 'finalized history must remain untouched');

const duplicate = await pg.query<{ id: number }>(`
  insert into billing_line_items
    (order_id, ship_date, line_type, description, invoiced)
  values
    (101, '2026-07-16T00:00:00Z', 'shipping', 'Shipping order 101', false)
  on conflict (order_id, line_type, description) do nothing
  returning id;
`);
assert.equal(duplicate.rows.length, 0, 'RETURNING must expose a skipped unique conflict');

const billing = readFileSync('src/services/billing.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

assert.match(
  billing,
  /const orderLinesToRebuild = editableOrderIds\.length > 0[\s\S]*inArray\(billingLineItems\.orderId, editableOrderIds\)[\s\S]*requestedWindowOrderLines/,
  'generator must reconcile candidate order ids across periods and retain the window sweep',
);
assert.match(
  billing,
  /assertBillingOrdersEditable[\s\S]*tx\.delete\(billingLineItems\)[\s\S]*orderLinesToRebuild[\s\S]*billingLineItemIsEditablePredicate/,
  'finalized-order policy must guard the order-scoped delete',
);
assert.match(
  billing,
  /onConflictDoNothing[\s\S]*returning\(\{ totalCost: billingLineItems\.totalCost \}\)/,
  'insert conflicts must be observable through RETURNING',
);
assert.match(
  billing,
  /generated \+= inserted\.length[\s\S]*for \(const row of inserted\) total \+= toNum\(row\.totalCost\)/,
  'generation counters and response total must use persisted rows only',
);
assert.match(
  billing,
  /logStructured\('warn', 'billing\.line_item_conflict_skipped'[\s\S]*conflictCount: lineItemConflictCount/,
  'remaining unique conflicts must emit a structured count-only warning',
);
assert.match(
  billing,
  /Per user override unlock shipped data on 2026-07-14 \(Audit B-5\)/,
  'the shipped-data billing-path change must record the current override',
);
assert.ok(packageJson.includes('"test:audit-billing-cross-period-reconciliation"'),
  'package must expose the B-5 guard');
assert.ok(guardPack.includes("'test:audit-billing-cross-period-reconciliation'"),
  'the mandatory source-of-truth pack must run the B-5 guard');

await pg.close();
console.log('PASS Audit B-5 cross-period billing reconciliation guard');
