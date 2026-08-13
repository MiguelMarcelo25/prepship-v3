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
    shipment_id integer,
    ship_date timestamptz,
    line_type text not null,
    description text not null,
    invoiced boolean not null default false
  );
  create unique index billing_li_shipment_unique_idx
    on billing_line_items (order_id, shipment_id, line_type, description)
    where shipment_id is not null;
  insert into billing_line_items
    (order_id, shipment_id, ship_date, line_type, description, invoiced)
  values
    (101, 1001, '2026-06-15T00:00:00Z', 'shipping', 'Shipping order 101', false),
    (202, 2002, '2026-07-05T00:00:00Z', 'shipping', 'Stale July order 202', false),
    (303, 3003, '2026-06-20T00:00:00Z', 'shipping', 'Finalized order 303', true),
    (404, 4004, '2026-06-21T00:00:00Z', 'shipping', 'Unrelated order 404', false);
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
    (order_id, shipment_id, ship_date, line_type, description, invoiced)
  values
    (101, 1001, '2026-07-15T00:00:00Z', 'shipping', 'Shipping order 101', false);
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

await assert.rejects(
  pg.exec(`
    insert into billing_line_items
      (order_id, shipment_id, ship_date, line_type, description, invoiced)
    values
      (101, 1001, '2026-07-16T00:00:00Z', 'shipping', 'Shipping order 101', false);
  `),
  /duplicate key/,
  'duplicate shipment charges must fail loudly',
);

const billing = readFileSync('src/services/billing.ts', 'utf8');

// PS-488 M2 re-anchor: a comment-free view, for assertions that must see EXECUTABLE code.
// Mutation-checked — commenting out the sweep-owner import still satisfied a raw-source
// regex, so the delegation assertion below passed against code that no longer imported it.
const billingCode = billing
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

assert.match(
  billing,
  /const orderLinesToRebuild = editableOrderIds\.length > 0[\s\S]*inArray\(billingLineItems\.orderId, editableOrderIds\)[\s\S]*requestedWindowOrderLines/,
  'generator must reconcile candidate order ids across periods and retain the window sweep',
);
// PS-488 M2 re-anchor. This pinned an INLINE `tx.delete(billingLineItems)` sitting between
// the editability assertion and the predicate. M2 extracted the order-scoped sweep into
// billing-outbound-sweep.ts so production and the PostgreSQL 17 proof call ONE owner — a
// test can no longer pass while production diverges. The literal shape this matched
// therefore no longer exists, and the regex became unsatisfiable: the four tokens now sit
// in an order the file cannot produce, so it failed on every commit rather than on a
// regression. (The remaining `tx.delete(billingLineItems)` in the file is the RETURN-line
// delete, a different statement entirely.)
//
// The RULE is unchanged and is what is asserted here: the finalized-order policy must
// still guard the order-scoped delete, and that delete must still carry the rebuild scope
// and the editability predicate. Delegation to the extracted owner is asserted separately
// so an inline copy cannot quietly come back.
assert.match(
  billing,
  /assertBillingOrdersEditable[\s\S]*deleteOutboundBillingLinesForRebuild[\s\S]*orderLinesToRebuild[\s\S]*billingLineItemIsEditablePredicate/,
  'finalized-order policy must guard the order-scoped delete, which now runs through '
    + 'deleteOutboundBillingLinesForRebuild carrying the rebuild scope and editable predicate',
);
assert.match(
  billingCode,
  /deleteOutboundBillingLinesForRebuild,[\s\S]*from '\.\/billing-outbound-sweep'/,
  'the sweep owner must be imported, never reimplemented inline',
);
assert.match(
  billing,
  /\.values\(chunk\)[\s\S]*\.returning\(\{[\s\S]*id: billingLineItems\.id,[\s\S]*shipmentId: billingLineItems\.shipmentId,[\s\S]*totalCost: billingLineItems\.totalCost/,
  'order-line inserts must return the exact persisted rows',
);
assert.match(
  billing,
  /generated \+= inserted\.length[\s\S]*for \(const row of inserted\) total \+= toNum\(row\.totalCost\)/,
  'generation counters and response total must use persisted rows only',
);
assert.doesNotMatch(
  billing,
  /billing\.line_item_conflict_skipped|lineItemConflictCount/,
  'order-line duplicates must fail the transaction instead of being conflict-skipped',
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
