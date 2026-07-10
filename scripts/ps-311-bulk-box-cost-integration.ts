/**
 * PS-311 — REAL integration test for the bulk box-cost preview + apply, against an in-memory
 * Postgres (PGlite). Unlike the pure guard, this exercises the ACTUAL scope SQL and the ACTUAL
 * resolution upserts/transaction — so it proves the card's fixture cases BEHAVIOURALLY, not just
 * by asserting the WHERE-clause text:
 *   - same client/box/range → one reviewed cost applied consistently to every editable order;
 *   - rows OUTSIDE the date range do not change;
 *   - a DIFFERENT client with the same box does not change;
 *   - a DIFFERENT box for the same client does not change;
 *   - FINALIZED (invoiced) orders are skipped — never re-billed;
 *   - re-apply is idempotent (onConflict upsert, no duplicate resolution rows).
 *
 * Offline + deterministic: PGlite is a WASM Postgres; nothing touches the production DB. The
 * service's `conn` seam lets us point the real functions at the in-memory instance, and its
 * `conn === db` guard guarantees a test connection can never reach the production singleton.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import * as schema from '../src/db/schema/index.js';
import { billingBoxResolutions } from '../src/db/schema/billing.js';
import { billingDayRange } from '../src/lib/time/billing-day.js';
import {
  fetchBulkBoxCostOrderRows,
  computeBulkBoxCostPreview,
  applyBulkBoxCostResolutions,
} from '../src/services/billing-box-cost-bulk.js';

type Conn = Parameters<typeof fetchBulkBoxCostOrderRows>[2];

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  // Minimal real schema (no cross-table FKs — we are not seeding orders/packages/shipments).
  await pg.execute(sql`CREATE TABLE billing_line_items (
    id serial primary key,
    client_id integer not null,
    order_id integer,
    order_number text,
    shipment_id integer,
    ship_date timestamptz,
    line_type text not null,
    description text not null,
    qty numeric(10,2) not null default '1',
    unit_cost numeric(10,2) not null,
    total_cost numeric(10,2) not null,
    package_id integer,
    invoiced boolean not null default false,
    created_at timestamptz not null default now()
  )`);
  await pg.execute(sql`CREATE TABLE billing_box_resolutions (
    id serial primary key,
    order_id integer not null unique,
    shipment_id integer,
    package_id integer,
    override_price numeric(10,2),
    note text,
    resolved_by text,
    resolved_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);

  // Fixtures. Target scope = client 100, box 7, June 2026.
  //   order 1: in scope, $1.00, editable
  //   order 2: in scope, $2.00, FINALIZED (invoiced) → must be skipped
  //   order 5: in scope, $0.00, editable (a $0 box-cost is a legitimate re-price target)
  //   order 4: client 100 / box 7 but JULY (after range) → isolates the dateTo upper bound
  //   order 7: client 100 / box 7 but MAY (before range) → isolates the dateFrom lower bound
  //   order 3: box 7 but client 200 → other client
  //   order 6: client 100 but box 9 → other box
  //   order 8: client 100 / box 7, shipped ON the LAST selected day (June 30, UTC midnight) →
  //            the boundary the off-by-one fix is about (PS-311 date fix)
  await pg.execute(sql`INSERT INTO billing_line_items
    (order_id, order_number, client_id, package_id, line_type, description, unit_cost, total_cost, ship_date, invoiced) VALUES
    (1, 'A1', 100, 7, 'package_cost', 'box', '1.00', '1.00', '2026-06-10', false),
    (2, 'A2', 100, 7, 'package_cost', 'box', '2.00', '2.00', '2026-06-11', true),
    (5, 'A5', 100, 7, 'package_cost', 'box', '0.00', '0.00', '2026-06-13', false),
    (4, 'A4', 100, 7, 'package_cost', 'box', '9.00', '9.00', '2026-07-15', false),
    (7, 'A7', 100, 7, 'package_cost', 'box', '7.00', '7.00', '2026-05-15', false),
    (3, 'B3', 200, 7, 'package_cost', 'box', '3.00', '3.00', '2026-06-12', false),
    (6, 'A6', 100, 9, 'package_cost', 'box', '4.00', '4.00', '2026-06-14', false),
    (8, 'A8', 100, 7, 'package_cost', 'box', '8.00', '8.00', '2026-06-30T00:00:00.000Z', false)`);

  await client.exec(readFileSync('drizzle/0059_billing_finalized_lock.sql', 'utf8'));

  const scope = {
    clientId: 100,
    dateFrom: '2026-06-01T00:00:00.000Z',
    dateTo: '2026-06-30T00:00:00.000Z',
    packageId: 7,
    newCost: 2.5,
  };

  // ── 1) The REAL scope SQL matches ONLY the in-scope orders (1, 2, 5) ──
  const rows = await fetchBulkBoxCostOrderRows(scope, undefined, conn);
  const matchedIds = rows.map((r) => r.orderId).sort((a, b) => a - b);
  check('scope SQL matches ONLY client+box+range orders [1,2,5] (excludes other client/box/out-of-range)',
    JSON.stringify(matchedIds) === JSON.stringify([1, 2, 5]));
  check('matched order 4 is NOT present (July ship-date is AFTER the range — isolates the dateTo upper bound)', !matchedIds.includes(4));
  check('matched order 7 is NOT present (May ship-date is BEFORE the range — isolates the dateFrom lower bound)', !matchedIds.includes(7));
  check('matched order 3 is NOT present (client 200 ≠ scope client 100)', !matchedIds.includes(3));
  check('matched order 6 is NOT present (box 9 ≠ scope box 7)', !matchedIds.includes(6));
  check('order 2 is read back as FINALIZED (invoiced=true)', rows.find((r) => r.orderId === 2)?.invoiced === true);

  // ── 2) Preview math over the real rows ──
  const preview = computeBulkBoxCostPreview(rows, scope.newCost);
  check('preview: editable=2 (orders 1,5), finalized=1 (order 2)',
    preview.editableOrderCount === 2 && preview.finalizedOrderCount === 1);
  check('preview: beforeTotal=1.00 (1+0; finalized $2 excluded), afterTotal=5.00 (2.50×2), delta=4.00',
    preview.beforeTotal === 1.0 && preview.afterTotal === 5.0 && preview.delta === 4.0);

  // ── 3) The REAL apply writes resolutions for editable orders ONLY ──
  const applied = await applyBulkBoxCostResolutions(scope, undefined, 'tester', 'bulk', conn);
  check('apply result: appliedOrderCount=2, skippedFinalizedCount=1',
    applied.appliedOrderCount === 2 && applied.skippedFinalizedCount === 1);

  const afterApply = await pg.select().from(billingBoxResolutions);
  const resByOrder = new Map(afterApply.map((r) => [r.orderId, Number(r.overridePrice)]));
  check('resolution written for editable orders 1 + 5 at the reviewed cost 2.50',
    resByOrder.get(1) === 2.5 && resByOrder.get(5) === 2.5);
  check('NO resolution for finalized order 2 (an invoiced order is never re-billed)', !resByOrder.has(2));
  check('NO resolution for out-of-range order 4', !resByOrder.has(4));
  check('NO resolution for other-client order 3', !resByOrder.has(3));
  check('NO resolution for other-box order 6', !resByOrder.has(6));
  check('exactly 2 resolution rows total (no spillover)', afterApply.length === 2);

  // ── 4) Re-apply is idempotent — onConflict UPDATES in place, no duplicate rows ──
  const reapplied = await applyBulkBoxCostResolutions({ ...scope, newCost: 3.0 }, undefined, 'tester', 'bulk2', conn);
  check('re-apply at 3.00 still touches exactly the 2 editable orders', reapplied.appliedOrderCount === 2);
  const afterReapply = await pg.select().from(billingBoxResolutions);
  const reByOrder = new Map(afterReapply.map((r) => [r.orderId, Number(r.overridePrice)]));
  check('re-apply UPDATED orders 1 + 5 to 3.00 (upsert, not insert)',
    reByOrder.get(1) === 3.0 && reByOrder.get(5) === 3.0);
  check('still exactly 2 resolution rows after re-apply (idempotent, no duplicates)', afterReapply.length === 2);

  // ── 5) PS-311 DATE FIX: operators pick whole calendar DAYS (e.g. June 1 → June 30). The route
  // MUST normalize those through billingDayRange so the LAST selected day is INCLUDED. Order 8
  // shipped ON June 30 (UTC midnight) — exactly the boundary the old raw-string path dropped,
  // because a raw inclusive "2026-06-30" dateTo became `< 2026-06-30T00:00:00Z`. ──
  const rawLastDay = await fetchBulkBoxCostOrderRows({ ...scope, dateTo: '2026-06-30' }, undefined, conn);
  check('CONTROL: a raw inclusive last-day string (2026-06-30) EXCLUDES the June-30 order — the exact off-by-one the fix removes',
    !rawLastDay.map((r) => r.orderId).includes(8));

  const range = billingDayRange('2026-06-01', '2026-06-30');
  check('billingDayRange upper bound is EXCLUSIVE = first instant of the day AFTER the last selected day (so the last day is included)',
    range?.fromUtc === '2026-06-01T00:00:00.000Z' && range?.toUtcExclusive === '2026-07-01T00:00:00.000Z');

  const normalizedRows = await fetchBulkBoxCostOrderRows(
    { ...scope, dateFrom: range!.fromUtc, dateTo: range!.toUtcExclusive },
    undefined,
    conn,
  );
  const normalizedIds = normalizedRows.map((r) => r.orderId).sort((a, b) => a - b);
  check('FIX: with billingDayRange bounds the June-30 boundary order (8) IS included — the FULL selected range is re-priced [1,2,5,8]',
    JSON.stringify(normalizedIds) === JSON.stringify([1, 2, 5, 8]));

  await client.close();

  if (failures > 0) {
    console.error(`\nPS-311 bulk box-cost INTEGRATION test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-311 bulk box-cost integration test passed.');
}

void main().catch((err) => {
  console.error('PS-311 integration test crashed:', err);
  process.exit(1);
});
