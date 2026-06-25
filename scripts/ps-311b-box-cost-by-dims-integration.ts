/**
 * PS-311b — REAL integration test (PGlite) for the dims-based needs-review box-cost sweep.
 *
 * From ONE needs-review order (unmatched custom box, e.g. 6.5x4x2), bulk-apply a reviewed cost to
 * every OTHER needs-review order that shares the SAME box signature, scoped to (client + date range).
 * Proves BEHAVIOURALLY (real scope SQL + real resolution upsert/transaction):
 *   - the match key is the package_cost_missing review-line description (the dims signature);
 *   - same client + same signature + in range → swept; a DIFFERENT box size → not swept;
 *   - an ALREADY-PRICED order (package_cost line, has a packageId) → not swept;
 *   - other client / out-of-range → not swept;
 *   - FINALIZED (invoiced) orders → skipped, never re-billed;
 *   - apply writes override-price resolutions (packageId NULL) for editable orders, idempotently;
 *   - a source order that is NOT a needs-review row → null signature, zero impact (safe no-op).
 *
 * Offline + deterministic: PGlite is a WASM Postgres; nothing touches the production DB. The
 * service's `conn` seam points the real functions at the in-memory instance; its `conn === db`
 * guard guarantees a test connection can never reach the production singleton.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { billingBoxResolutions, billingLineItems } from '../src/db/schema/billing.js';
import {
  fetchBoxReviewSignature,
  fetchUnmatchedBoxOrdersByDims,
  previewBulkBoxCostByDims,
  applyBulkBoxCostByDimsResolutions,
  fetchSweepNoteForOrder,
  revertBulkBoxCostByDimsResolutions,
} from '../src/services/billing-box-cost-by-dims.js';

const SWEEP_NOTE = `[box-sweep] Unmatched box (Custom 6.5x4x2) — no package matches the shipment box`;

type Conn = Parameters<typeof fetchUnmatchedBoxOrdersByDims>[3];

// The exact deterministic strings billing emits (services/billing-box-policy.ts describeBoxReview).
const SIG_6x4x2 = 'Unmatched box (Custom 6.5x4x2) — no package matches the shipment box';
const SIG_8x8x8 = 'Unmatched box (Custom 8x8x8) — no package matches the shipment box';

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

  // Fixtures. Target scope = client 100, June 2026, source order 1 (Custom 6.5x4x2 needs review).
  //   1: client 100, SIG 6x4x2, in range, editable      → SOURCE + match
  //   2: client 100, SIG 6x4x2, in range, editable      → match (the sibling we want to sweep)
  //   3: client 100, SIG 6x4x2, in range, FINALIZED      → matched but SKIPPED on apply
  //   4: client 100, SIG 8x8x8, in range, editable      → other box size, NOT matched
  //   5: client 100, ALREADY-PRICED package_cost box 7  → resolved already, NOT matched (no review line)
  //   6: client 100, SIG 6x4x2, JULY (after range)      → out of range, NOT matched
  //   7: client 200, SIG 6x4x2, in range                → other client, NOT matched
  await pg.execute(sql`INSERT INTO billing_line_items
    (order_id, order_number, client_id, package_id, line_type, description, unit_cost, total_cost, ship_date, invoiced) VALUES
    (1, 'A1', 100, NULL, 'package_cost_missing', ${SIG_6x4x2}, '0.00', '0.00', '2026-06-10', false),
    (2, 'A2', 100, NULL, 'package_cost_missing', ${SIG_6x4x2}, '0.00', '0.00', '2026-06-11', false),
    (3, 'A3', 100, NULL, 'package_cost_missing', ${SIG_6x4x2}, '0.00', '0.00', '2026-06-12', true),
    (4, 'A4', 100, NULL, 'package_cost_missing', ${SIG_8x8x8}, '0.00', '0.00', '2026-06-13', false),
    (5, 'A5', 100, 7,    'package_cost',         'Box (12x10x3)', '3.00', '3.00', '2026-06-14', false),
    (6, 'A6', 100, NULL, 'package_cost_missing', ${SIG_6x4x2}, '0.00', '0.00', '2026-07-15', false),
    (7, 'B7', 200, NULL, 'package_cost_missing', ${SIG_6x4x2}, '0.00', '0.00', '2026-06-16', false)`);

  const scope = {
    clientId: 100,
    dateFrom: '2026-06-01T00:00:00.000Z',
    dateTo: '2026-07-01T00:00:00.000Z', // exclusive (billingDayRange shape for June 1–30)
    sourceOrderId: 1,
    newCost: 0.55,
  };

  // ── 1) signature is re-derived server-side from the source order ──
  const sig = await fetchBoxReviewSignature(100, 1, conn);
  check('source order 1 signature = its package_cost_missing description (Custom 6.5x4x2)', sig === SIG_6x4x2);
  const noSig = await fetchBoxReviewSignature(100, 5, conn);
  check('an already-priced order (no review line) has NULL signature (not a needs-review order)', noSig === null);

  // ── 2) the dims match finds ONLY same-client + same-signature + in-range ──
  const rows = await fetchUnmatchedBoxOrdersByDims(scope, SIG_6x4x2, undefined, conn);
  const matched = rows.map((r) => r.orderId).sort((a, b) => a - b);
  check('dims match = same-box needs-review orders [1,2,3] only', JSON.stringify(matched) === JSON.stringify([1, 2, 3]));
  check('order 4 NOT matched (different box size 8x8x8)', !matched.includes(4));
  check('order 5 NOT matched (already priced — a package_cost line, no review)', !matched.includes(5));
  check('order 6 NOT matched (July — after the range)', !matched.includes(6));
  check('order 7 NOT matched (client 200 ≠ scope client 100)', !matched.includes(7));
  check('finalized order 3 is read back as invoiced', rows.find((r) => r.orderId === 3)?.invoiced === true);

  // ── 3) preview: editable=2 (1,2), finalized=1 (3); before $0 → after 0.55×2 ──
  const preview = await previewBulkBoxCostByDims(scope, undefined, conn);
  check('preview signature labels the box (Custom 6.5x4x2)', preview.signature === SIG_6x4x2);
  check('preview: editable=2, finalized=1', preview.editableOrderCount === 2 && preview.finalizedOrderCount === 1);
  check('preview: beforeTotal=0 (review lines bill $0), afterTotal=1.10 (0.55×2), delta=1.10',
    preview.beforeTotal === 0 && preview.afterTotal === 1.1 && preview.delta === 1.1);

  // ── 4) preview from a NON-review source → null signature, zero impact (safe no-op) ──
  const nonReviewPreview = await previewBulkBoxCostByDims({ ...scope, sourceOrderId: 5 }, undefined, conn);
  check('source order 5 is not needs-review → null signature, 0 editable (nothing to apply)',
    nonReviewPreview.signature === null && nonReviewPreview.editableOrderCount === 0);

  // ── 5) apply writes override-price resolutions for editable orders ONLY ──
  const applied = await applyBulkBoxCostByDimsResolutions(scope, undefined, 'tester', conn);
  check('apply: appliedOrderCount=2, skippedFinalizedCount=1', applied.appliedOrderCount === 2 && applied.skippedFinalizedCount === 1);

  const afterApply = await pg.select().from(billingBoxResolutions);
  const byOrder = new Map(afterApply.map((r) => [r.orderId, r]));
  check('resolution written for editable orders 1 + 2 at 0.55',
    Number(byOrder.get(1)?.overridePrice) === 0.55 && Number(byOrder.get(2)?.overridePrice) === 0.55);
  check('resolutions carry packageId NULL (a custom box has no package row)',
    byOrder.get(1)?.packageId == null && byOrder.get(2)?.packageId == null);
  check('resolutions carry the [box-sweep] marker note (what UNDO finds)',
    byOrder.get(1)?.note === SWEEP_NOTE && byOrder.get(2)?.note === SWEEP_NOTE);
  check('NO resolution for finalized order 3 (an invoiced order is never re-billed)', !byOrder.has(3));
  check('NO resolution for other-box order 4', !byOrder.has(4));
  check('NO resolution for other-client order 7', !byOrder.has(7));
  check('exactly 2 resolution rows total (no spillover)', afterApply.length === 2);

  // ── 6) re-apply is idempotent — onConflict UPDATES in place ──
  const reapplied = await applyBulkBoxCostByDimsResolutions({ ...scope, newCost: 0.75 }, undefined, 'tester', conn);
  check('re-apply at 0.75 still touches exactly the 2 editable orders', reapplied.appliedOrderCount === 2);
  const afterReapply = await pg.select().from(billingBoxResolutions);
  const reByOrder = new Map(afterReapply.map((r) => [r.orderId, Number(r.overridePrice)]));
  check('re-apply UPDATED orders 1 + 2 to 0.75 (upsert, not insert)', reByOrder.get(1) === 0.75 && reByOrder.get(2) === 0.75);
  check('still exactly 2 resolution rows after re-apply (idempotent)', afterReapply.length === 2);

  // ── 7) UNDO INVOICED-GUARD + manual-protection: an order INVOICED after the sweep must NOT be
  // reverted (undo must never strip a box cost off a finalized invoice); a MANUAL (non-sweep)
  // resolution must SURVIVE; only EDITABLE sweep-marked resolutions are removed. ──
  await pg.execute(sql`UPDATE billing_line_items SET invoiced = true WHERE order_id = 1`); // invoiced AFTER the sweep
  await pg.execute(sql`INSERT INTO billing_box_resolutions (order_id, package_id, override_price, note, resolved_by)
    VALUES (5, 7, '3.00', 'Manual box edit', 'tester')`);
  check('source order 1 resolution carries the sweep marker note', (await fetchSweepNoteForOrder(100, 1, conn)) === SWEEP_NOTE);
  check('order 5 manual resolution is NOT recognized as a sweep (different note → null)', (await fetchSweepNoteForOrder(100, 5, conn)) === null);

  const revertScope = { clientId: 100, dateFrom: scope.dateFrom, dateTo: scope.dateTo, sourceOrderId: 1 };
  const reverted = await revertBulkBoxCostByDimsResolutions(revertScope, undefined, conn);
  check('revert undoes the EDITABLE swept order (2) and SKIPS the now-invoiced one (1)',
    reverted.revertedOrderCount === 1 && reverted.skippedFinalizedCount === 1);
  const afterRevert = await pg.select().from(billingBoxResolutions);
  const remaining = new Set(afterRevert.map((r) => r.orderId));
  check('swept resolution for editable order 2 is GONE (returns to needs-review on regen)', !remaining.has(2));
  check('swept resolution for INVOICED order 1 SURVIVES (undo never strips a finalized invoice)', remaining.has(1));
  check('MANUAL resolution on order 5 SURVIVED (undo never touches non-sweep edits)', remaining.has(5));
  check('exactly 2 resolutions remain (invoiced sweep #1 + manual #5)', afterRevert.length === 2);

  // ── 8) revert is idempotent — a second undo only finds the invoiced order, which it skips ──
  const reverted2 = await revertBulkBoxCostByDimsResolutions(revertScope, undefined, conn);
  check('second revert reverts nothing (the only swept resolution left is invoiced → skipped)',
    reverted2.revertedOrderCount === 0 && reverted2.skippedFinalizedCount === 1);

  // ── 9) SCOPE PREDICATE: a billing_line_items-keyed client-scope predicate RUNS (no clients-in-FROM
  // error) AND actually filters by client — proves the by-dims fetch enforces the scope it is given. ──
  const inScopeRows = await fetchUnmatchedBoxOrdersByDims(
    scope, SIG_6x4x2, sql`${billingLineItems.clientId} = any(array[100]::int[])`, conn);
  check('a billing_line_items-keyed scope predicate runs and matches in-scope orders [1,2,3]', inScopeRows.length === 3);
  const outScopeRows = await fetchUnmatchedBoxOrdersByDims(
    scope, SIG_6x4x2, sql`${billingLineItems.clientId} = any(array[999]::int[])`, conn);
  check('an out-of-scope client predicate filters everything out (defense-in-depth actually enforced)', outScopeRows.length === 0);

  await client.close();

  if (failures > 0) {
    console.error(`\nPS-311b box-cost by-dims INTEGRATION test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-311b box-cost by-dims integration test passed.');
}

void main().catch((err) => {
  console.error('PS-311b integration test crashed:', err);
  process.exit(1);
});
