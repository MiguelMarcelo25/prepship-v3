/**
 * PS-495 one-off remediation: regenerate the billing windows that were never generated.
 *
 * Calls the CANONICAL owner (generateLineItems) rather than writing billing rows by hand,
 * so every rule the normal path applies — PS-434 weekday gate, freshness gate,
 * finalized/invoiced fencing, fee policy — applies identically here.
 *
 * WHY the windows exist: billing generation is a point-in-time snapshot of a period, and
 * these shipments synced in long after their ship date (448 of 450 more than a week late,
 * most in a single 2026-04-23 bulk sync). Nothing regenerates a period when a late
 * shipment lands inside it.
 *
 * ── The two windows are NOT equally safe ───────────────────────────────────
 *
 * WINDOW 1 — 2026-03-05 .. 2026-03-20, clients 2, 8, 9, 11. ADDITIVE.
 *   Verified read-only 2026-08-07: zero existing billing_line_items in the range for all
 *   four clients, so the delete half of the regenerate removes nothing. Zero overlapping
 *   finalizations, zero invoiced lines. 2026-03-21 DOES carry 46 lines, so dateTo is
 *   2026-03-21 EXCLUSIVE and leaves them untouched.
 *
 * WINDOW 2 — 2024-01-29, client 11 only. A REWRITE, not an addition.
 *   This day is MIXED: 63 unbilled orders alongside 20 already-billed ones carrying 37
 *   lines worth $165.51. generateLineItems is delete-and-recreate, so those 37 lines are
 *   deleted and rebuilt from CURRENT data. If any input has changed since January 2024
 *   (package prices, fee schedule, rate data) the rebuilt amounts will differ.
 *   Nothing is invoiced and nothing is finalized, so nothing is frozen — but this is the
 *   window that can CHANGE an existing bill rather than only add to it.
 *
 * That is why this script snapshots per-order totals before and after and prints a diff:
 * a rewrite nobody can inspect is indistinguishable from a silent restatement.
 *
 * Dry-run by default; writes only with --apply.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { generateLineItems } from '../src/services/billing';

const APPLY = process.argv.includes('--apply');

type Window = {
  label: string;
  clients: number[];
  /** INCLUSIVE */
  dateFrom: string;
  /** EXCLUSIVE */
  dateTo: string;
  additive: boolean;
};

const WINDOWS: Window[] = [
  {
    label: '2026-03-05..2026-03-20 (4 clients, additive)',
    clients: [2, 8, 9, 11],
    dateFrom: '2026-03-05T00:00:00.000Z',
    dateTo: '2026-03-21T00:00:00.000Z',
    additive: true,
  },
  {
    label: '2024-01-29 (client 11, REWRITES 20 already-billed orders)',
    clients: [11],
    dateFrom: '2024-01-29T00:00:00.000Z',
    dateTo: '2024-01-30T00:00:00.000Z',
    additive: false,
  },
];

type OrderTotals = Map<number, number>;

async function orderTotals(w: Window): Promise<OrderTotals> {
  const rows = await db.execute<{ order_id: number; total: string }>(sql`
    select b.order_id, coalesce(sum(b.total_cost), 0)::text as total
    from billing_line_items b
    where b.client_id = any(${sql.raw(`array[${w.clients.join(',')}]::int[]`)})
      and coalesce(b.billing_effective_date, b.ship_date) >= ${w.dateFrom}::timestamptz
      and coalesce(b.billing_effective_date, b.ship_date) <  ${w.dateTo}::timestamptz
      and b.order_id is not null
    group by b.order_id
  `);
  const list = (Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows) ?? [];
  const map: OrderTotals = new Map();
  for (const r of list) map.set(Number(r.order_id), Number(r.total));
  return map;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function summarize(t: OrderTotals): string {
  let sum = 0;
  for (const v of t.values()) sum += v;
  return `${t.size} orders, ${money(sum)}`;
}

/** The whole point for window 2: show what a delete-and-recreate actually changed. */
function diff(before: OrderTotals, after: OrderTotals): void {
  const added: number[] = [];
  const removed: number[] = [];
  const changed: Array<[number, number, number]> = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined) added.push(id);
    else if (Math.abs(a - b) > 0.005) changed.push([id, b, a]);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);

  console.log(`  newly billed orders : ${added.length}`);
  console.log(`  orders CHANGED      : ${changed.length}`);
  console.log(`  orders DISAPPEARED  : ${removed.length}`);
  for (const [id, b, a] of changed.slice(0, 40)) {
    console.log(`    order ${id}: ${money(b)} -> ${money(a)}  (${a > b ? '+' : ''}${money(a - b)})`);
  }
  if (changed.length > 40) console.log(`    ... and ${changed.length - 40} more`);
  // A vanished order is the alarming case: it was billed before and is not billed now.
  for (const id of removed.slice(0, 40)) {
    console.log(`    order ${id}: ${money(before.get(id) ?? 0)} -> GONE`);
  }
}

for (const w of WINDOWS) {
  console.log(`\n================ ${w.label} ================`);
  const before = await orderTotals(w);
  console.log(`BEFORE: ${summarize(before)}`);
  if (!w.additive && before.size > 0) {
    console.log(`  NOTE: this window REWRITES ${before.size} already-billed orders.`);
  }

  if (!APPLY) {
    console.log('DRY RUN — no writes. Re-run with --apply.');
    continue;
  }

  for (const clientId of w.clients) {
    process.stdout.write(`  regenerating client ${clientId} ... `);
    try {
      const result = await generateLineItems({
        clientId,
        dateFrom: w.dateFrom,
        dateTo: w.dateTo,
        scopeIsGlobal: true,
        scopeRestricted: false,
        actorId: 'ps-495-remediation',
        actorEmail: 'info@drprepperusa.com',
      });
      console.log(`ok ${JSON.stringify(result)}`);
    } catch (err) {
      console.log('FAILED');
      console.error(err instanceof Error ? `    ${err.name}: ${err.message}` : err);
    }
  }

  const after = await orderTotals(w);
  console.log(`AFTER : ${summarize(after)}`);
  diff(before, after);
}

process.exit(0);
