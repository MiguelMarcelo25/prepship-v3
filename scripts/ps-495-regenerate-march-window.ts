/**
 * PS-495 one-off remediation: regenerate the 2026-03-05 .. 2026-03-20 billing window.
 *
 * Calls the CANONICAL owner (generateLineItems) rather than writing billing rows by hand,
 * so every rule the normal path applies — PS-434 weekday gate, freshness gate,
 * finalized/invoiced fencing, fee policy — applies identically here.
 *
 * WHY the window exists: billing generation is a point-in-time snapshot of a period, and
 * these shipments synced in long after their ship date (448 of 450 more than a week late,
 * most in a single 2026-04-23 bulk sync). Nothing regenerates a period when a late
 * shipment lands inside it, so 2026-03-05..03-20 was never billed for four clients.
 *
 * Verified read-only before writing (2026-08-07):
 *   - ZERO existing billing_line_items for clients 2, 8, 9, 11 in 03-05..03-20, so the
 *     delete half of the regenerate has nothing to remove. Purely additive.
 *   - ZERO billing_finalizations overlap the window.
 *   - ZERO invoiced lines in or adjacent to the window.
 *   - 03-21 DOES carry 46 lines, so dateTo is 2026-03-21 EXCLUSIVE and leaves them alone.
 *   - LA weekday is Thursday, so the weekend gate passes.
 *
 * DELIBERATELY NOT INCLUDED: client 11's 2024-01-29, a MIXED day (63 unbilled + 15
 * billed). Regenerating it would delete and recreate 15 already-billed orders' lines —
 * a different risk that needs its own decision.
 *
 * Dry-run by default; writes only with --apply.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { generateLineItems } from '../src/services/billing';

const APPLY = process.argv.includes('--apply');
const CLIENTS = [2, 8, 9, 11];
const DATE_FROM = '2026-03-05T00:00:00.000Z';
const DATE_TO = '2026-03-21T00:00:00.000Z'; // EXCLUSIVE

async function snapshot(label: string): Promise<void> {
  const rows = await db.execute<{
    client_id: number; lines: number; orders: number; total: string;
  }>(sql`
    select b.client_id,
           count(*)::int as lines,
           count(distinct b.order_id)::int as orders,
           coalesce(sum(b.total_cost), 0)::text as total
    from billing_line_items b
    where b.client_id = any(${sql.raw(`array[${CLIENTS.join(',')}]::int[]`)})
      and coalesce(b.billing_effective_date, b.ship_date) >= ${DATE_FROM}::timestamptz
      and coalesce(b.billing_effective_date, b.ship_date) <  ${DATE_TO}::timestamptz
    group by 1 order by 1
  `);
  const list = (Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows) ?? [];
  console.log(`\n--- ${label} ---`);
  if (!list.length) console.log('  (no billing lines in window)');
  let lines = 0; let total = 0;
  for (const r of list) {
    lines += Number(r.lines); total += Number(r.total);
    console.log(`  client ${r.client_id}: ${r.lines} lines, ${r.orders} orders, $${Number(r.total).toFixed(2)}`);
  }
  if (list.length) console.log(`  TOTAL: ${lines} lines, $${total.toFixed(2)}`);
}

await snapshot('BEFORE');

if (!APPLY) {
  console.log('\nDRY RUN — no writes performed. Re-run with --apply to regenerate.');
  process.exit(0);
}

for (const clientId of CLIENTS) {
  process.stdout.write(`\nregenerating client ${clientId} ... `);
  try {
    const result = await generateLineItems({
      clientId,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      scopeIsGlobal: true,
      scopeRestricted: false,
      actorId: 'ps-495-remediation',
      actorEmail: 'info@drprepperusa.com',
    });
    console.log(`ok ${JSON.stringify(result)}`);
  } catch (err) {
    console.log('FAILED');
    console.error(err instanceof Error ? `  ${err.name}: ${err.message}` : err);
  }
}

await snapshot('AFTER');
process.exit(0);
