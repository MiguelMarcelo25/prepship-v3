#!/usr/bin/env tsx
/**
 * PS-506 — the reconciliation plan for shipped orders whose inventory deduction stranded.
 *
 * Investigated under the `unlock shipped data` override on 2026-08-12.
 *
 * Between 2026-06-14 and 2026-08-07, shipped orders piled into `fulfillment_line_claims`
 * with `status='review'` — a terminal state nothing consumes — and never deducted stock.
 * PS-497 fixed the label path on 08-07 and PS-505 fixed the sync path, so the leak is
 * closed. The stock those orders shipped is still counted as on-hand.
 *
 * ── PLAN ONLY. This script never writes. ──────────────────────────────────────
 * It deliberately has no `--apply`. Writing these movements is a PS-462-class operation and
 * must go through that flow:
 *
 *   - a prepared correction packet whose plan hash and movements SHA are approved in
 *     advance (`assertInventoryCorrectionApproval` rejects a mismatch), and
 *   - a maintenance window: `api-workers-stopped-inventory-auto-deduct-disabled`.
 *
 * That second requirement is why this script cannot apply. The obvious implementation —
 * reuse `deductInventoryForOrder` — is incompatible with it: that function short-circuits
 * to `{ lockedDown: true }` the moment `INVENTORY_AUTO_DEDUCT` is off, which is exactly the
 * state the maintenance window requires. Applying must therefore go through
 * `applyInventoryMovementInTransaction`, as `ps-462-inventory-correction-operator.ts` does.
 *
 * Writing these movements against a LIVE system would also race the ordinary deduction path
 * that this same repair exists to make trustworthy again.
 *
 * The canonical idempotency key is order+inventory scoped
 * (`inventory:ship:order:<id>:inventory:<id>`), so the eventual apply is re-runnable: a
 * second pass returns `already_applied` and decrements nothing.
 *
 * ── What is deliberately excluded ─────────────────────────────────────────────
 *   - Orders with ANY line missing a SKU. `buildDeductionLines` silently skips such lines
 *     (`if (!sku) continue`), so including them would write a PARTIAL deduction — the exact
 *     failure PS-497 refuses: "a partial deduction is harder to reconcile than none,
 *     because nothing records what was skipped." Measured 2026-08-12: 608 orders sit here.
 *     They need client data fixes, not a script.
 *   - Orders without exactly one live outbound shipment. The order's lines are valid
 *     shipment truth only when the shipment's scope equals the order's scope — the same
 *     gate PS-505 enforces. A split order would over-deduct.
 *   - Orders that already have a `ship` ledger row.
 *   - Test clients, unless --include-test-clients is passed.
 *
 * ── Effective date for the eventual apply ─────────────────────────────────────
 * `ship_date` is selected so movements can be stamped with the period the stock actually
 * left, not the day the repair runs.
 *
 * Usage:
 *   npx tsx scripts/ps-506-reconcile-stranded-deductions.ts             # full plan
 *   npx tsx scripts/ps-506-reconcile-stranded-deductions.ts --client 4  # one client
 */
import { sql } from '../src/db/client';

type Args = { limit: number; clientId: number | null; excludeClients: number[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 5000, clientId: null, excludeClients: [12] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Math.max(1, Number(argv[i + 1]) || 5000);
    else if (argv[i] === '--client') args.clientId = Number(argv[i + 1]);
    else if (argv[i] === '--include-test-clients') args.excludeClients = [];
  }
  return args;
}

type Candidate = {
  id: number;
  client_id: number | null;
  client_name: string | null;
  order_number: string | null;
  ship_date: Date | null;
  units: number;
};

async function loadCandidates(args: Args): Promise<Candidate[]> {
  return sql<Candidate[]>`
    select o.id, o.client_id, c.name as client_name, o.order_number,
           coalesce(s.ship_date, s.create_date, o.order_date) as ship_date,
           (select coalesce(sum(coalesce((it->>'quantity')::numeric, 0)), 0)::int
              from jsonb_array_elements(o.items) it)::int as units
      from orders o
      join clients c on c.id = o.client_id
      join lateral (
        select s2.id, s2.ship_date, s2.create_date
          from shipments s2
         where s2.order_id = o.id
           and coalesce(s2.is_return, false) = false
           and coalesce(s2.voided, false) = false
         limit 1
      ) s on true
     where o.order_status = 'shipped'
       and o.externally_shipped = false
       and exists (select 1 from fulfillment_line_claims fc
                    where fc.order_id = o.id and fc.status = 'review')
       and not exists (select 1 from inventory_ledger l
                        where l.order_id = o.id and l.type = 'ship')
       and (select count(*) from shipments s3
             where s3.order_id = o.id
               and coalesce(s3.is_return, false) = false
               and coalesce(s3.voided, false) = false) = 1
       and jsonb_array_length(coalesce(o.items, '[]'::jsonb)) > 0
       and (select count(*) from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) it
             where nullif(trim(coalesce(it->>'sku', '')), '') is null) = 0
       ${args.clientId != null ? sql`and o.client_id = ${args.clientId}` : sql``}
       ${args.excludeClients.length ? sql`and o.client_id <> all(${args.excludeClients})` : sql``}
     order by o.order_date asc, o.id asc
     limit ${args.limit}
  `;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(args);

  console.log('PS-506 stranded inventory deduction — RECONCILIATION PLAN');
  console.log('  mode      : PLAN ONLY (never writes; apply via the PS-462 operator flow)');
  console.log(`  candidates: ${candidates.length}${args.clientId != null ? ` (client ${args.clientId})` : ''}`);
  if (args.excludeClients.length) {
    console.log(`  excluding : test client(s) ${args.excludeClients.join(', ')}`);
  }
  console.log('');

  const perClient = new Map<string, { orders: number; units: number }>();
  for (const row of candidates) {
    const name = row.client_name ?? `client ${row.client_id ?? 'unknown'}`;
    const bucket = perClient.get(name) ?? { orders: 0, units: 0 };
    bucket.orders += 1;
    bucket.units += row.units;
    perClient.set(name, bucket);
  }

  console.log('  client                          orders   units');
  for (const [name, v] of [...perClient.entries()].sort((a, b) => b[1].units - a[1].units)) {
    console.log(`  ${name.padEnd(30)}  ${String(v.orders).padStart(6)}  ${String(v.units).padStart(6)}`);
  }

  const orders = candidates.length;
  const units = candidates.reduce((total, row) => total + row.units, 0);
  console.log(`\n  TOTAL: ${orders} orders, ${units} units`);
  console.log('\n  Plan only. Applying requires the PS-462 correction packet, an approved');
  console.log('  plan hash, and a maintenance window with auto-deduct disabled.');
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (error) => {
    console.error(error);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
