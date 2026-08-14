#!/usr/bin/env tsx
/**
 * BILL-DUP-OUTBOUND-CHARGE — read-only audit for duplicate outbound service charges.
 *
 * ── IDENTIFIER IS PROVISIONAL ────────────────────────────────────────────────
 * `BILL-DUP-OUTBOUND-CHARGE` is a descriptive working reference, NOT a Trello id.
 * DJ alone creates and numbers cards. Rename every reference atomically in the
 * implementation commit once an official successor exists — the same rule that governs
 * INV-SYNC-FALLBACK-BOUNDARY.
 *
 * ── WHAT THIS INVESTIGATES ───────────────────────────────────────────────────
 * Order #3074 carries TWO outbound billing rows for one shipment:
 *
 *   7/20/2026  shipping $7.95, selected rate $7.95, fee $4.49, row total $12.44
 *   7/19/2026  shipping $0.00, no selected rate,    fee $4.49, row total $4.49
 *
 * The order has exactly ONE shipment (USPS Ground Advantage, $7.95, shipped Jul 20),
 * so $8.98 of fulfillment service was billed for $4.49 of work.
 *
 * ── THE MECHANISM THIS AUDIT TESTS ───────────────────────────────────────────
 * Rebuild is supposed to DELETE-then-INSERT. Two gates disagree about granularity:
 *
 *   DELETE  billingLineItemIsEditablePredicate() is ORDER-scoped — one invoiced line
 *           anywhere on a (client_id, order_id) freezes every line on that order.
 *   INSERT  assertBillingOrdersEditable locks on
 *           billing_line_item_group_key(client_id, order_id, ship_date, line_type)
 *           — SHIP DATE is part of the key.
 *
 * So when an order's billing ship date moves, the insert side sees a brand-new group
 * and writes a full set of charges, while the delete side sees the invoiced sibling and
 * removes nothing. Rebuild becomes APPEND instead of REPLACE.
 *
 * The schema permits the resulting pair: the two partial unique indexes are disjoint on
 * `shipment_id IS NULL` vs `IS NOT NULL`, so a shipment-less row and a shipment-bearing
 * row for the same (order, line_type, description) violate neither, and the generator's
 * insert carries no ON CONFLICT.
 *
 * ── STRICTLY READ-ONLY ───────────────────────────────────────────────────────
 * Every statement is a SELECT. No INSERT/UPDATE/DELETE/DDL, no temp tables, and the
 * session is pinned READ ONLY at the server so the database itself refuses a write
 * regardless of what this code asks for. There is no --apply and no repair path: any
 * repair is a separately authorized task requiring DJ's explicit approval.
 *
 *   npx tsx scripts/billing-duplicate-outbound-charge-audit.ts
 *   AUDIT_ORDER_NUMBER=3074 AUDIT_CLIENT_ID=4 npx tsx scripts/...
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  // FAIL, never skip. An audit that skips reports clean while proving nothing.
  console.error('STOP: DATABASE_URL is not set.');
  process.exit(1);
}

const ORDER_NUMBER = process.env.AUDIT_ORDER_NUMBER ?? '3074';
const CLIENT_ID = process.env.AUDIT_CLIENT_ID ? Number(process.env.AUDIT_CLIENT_ID) : null;

/** The service line types that represent fulfillment WORK — the ones double-charging costs money. */
const SERVICE_LINE_TYPES = ['pick_pack', 'pickpack', 'additional_unit', 'additional', 'package_cost'];

const money = (v: unknown): string => `$${Number(v ?? 0).toFixed(2)}`;
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql.unsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const [meta] = await sql<{ db: string; now: string }[]>`
    select current_database()::text as db, now()::text as now`;
  console.log('BILL-DUP-OUTBOUND-CHARGE — read-only audit');
  console.log(`  database : ${meta!.db}`);
  console.log(`  read at  : ${meta!.now}`);
  console.log('  session  : READ ONLY (server-enforced)\n');

  // ── 1. The named order, full provenance ────────────────────────────────────
  console.log(`1. ORDER #${ORDER_NUMBER} — every billing line, oldest first`);
  const lines = await sql<Record<string, unknown>[]>`
    select b.id, b.client_id, b.order_id, b.order_number, b.shipment_id, b.return_id,
           b.line_type, b.description, b.qty::text as qty,
           b.unit_cost::text as unit_cost, b.total_cost::text as total_cost,
           b.ship_date::text as ship_date, b.billing_effective_date::text as billing_effective_date,
           b.invoiced, b.source_finalization_id, b.billing_adjustment_id,
           b.billing_policy_version, b.created_at::text as created_at
      from public.billing_line_items b
     where b.order_number = ${ORDER_NUMBER}
       ${CLIENT_ID === null ? sql`` : sql`and b.client_id = ${CLIENT_ID}`}
     order by b.created_at, b.id`;

  if (lines.length === 0) {
    console.log('  (no billing lines found for that order number)');
  }
  for (const l of lines) {
    console.log(
      `  id=${l.id} ${String(l.line_type).padEnd(20)} ship=${String(l.ship_date).slice(0, 10)}` +
      ` eff=${String(l.billing_effective_date ?? '-').slice(0, 10)} total=${money(l.total_cost)}`,
    );
    console.log(
      `        shipment_id=${l.shipment_id ?? 'NULL'} invoiced=${l.invoiced}` +
      ` finalization=${l.source_finalization_id ?? '-'} adjustment=${l.billing_adjustment_id ?? '-'}`,
    );
    console.log(`        created=${l.created_at}  desc="${l.description}"`);
  }

  // ── 2. Does the order have more than one live outbound shipment? ───────────
  // If it does, two charge sets may be legitimate. If it has exactly one, they are not.
  console.log('\n2. SHIPMENT CARDINALITY (is a second charge set defensible?)');
  const shipments = await sql<Record<string, unknown>[]>`
    select s.id, s.voided, s.is_return, s.ship_date::text as ship_date,
           s.selected_rate_cost::text as selected_rate_cost, s.tracking_number
      from public.shipments s
      join public.orders o on o.id = s.order_id
     where o.order_number = ${ORDER_NUMBER}
     order by s.id`;
  for (const s of shipments) {
    console.log(
      `  shipment ${s.id}: voided=${s.voided} is_return=${s.is_return}` +
      ` ship_date=${String(s.ship_date ?? '-').slice(0, 10)} cost=${money(s.selected_rate_cost)}`,
    );
  }
  const liveOutbound = shipments.filter((s) => s.voided !== true && s.is_return !== true).length;
  console.log(`  live outbound shipments: ${liveOutbound}`);
  console.log(
    liveOutbound <= 1
      ? '  => one fulfillment event. A second full service charge set is NOT defensible.'
      : '  => multiple shipments; per-shipment charging may be legitimate. Judgement required.',
  );

  // ── 3. The mechanism: shipment-less AND shipment-bearing on one order ──────
  console.log('\n3. POPULATION — orders charged the same service both with and without a shipment');
  const dupes = await sql<Record<string, unknown>[]>`
    select b.client_id, b.order_id, b.order_number, b.line_type,
           count(*) filter (where b.shipment_id is null)     as orphan_rows,
           count(*) filter (where b.shipment_id is not null) as shipment_rows,
           sum(b.total_cost) filter (where b.shipment_id is null) as orphan_money,
           bool_or(b.invoiced) filter (where b.shipment_id is null) as orphan_invoiced,
           count(distinct b.ship_date::date)                 as distinct_ship_days
      from public.billing_line_items b
     where b.order_id is not null
       and b.line_type in ${sql(SERVICE_LINE_TYPES)}
       ${CLIENT_ID === null ? sql`` : sql`and b.client_id = ${CLIENT_ID}`}
     group by b.client_id, b.order_id, b.order_number, b.line_type
    having count(*) filter (where b.shipment_id is null) > 0
       and count(*) filter (where b.shipment_id is not null) > 0
     order by sum(b.total_cost) filter (where b.shipment_id is null) desc nulls last
     limit 200`;

  console.log(`  affected (order, line_type) pairs: ${dupes.length}${dupes.length === 200 ? ' (capped at 200 — rerun without the limit to size fully)' : ''}`);
  for (const d of dupes.slice(0, 25)) {
    console.log(
      `  order ${d.order_number} client ${d.client_id} ${String(d.line_type).padEnd(18)}` +
      ` orphan=${d.orphan_rows} shipment=${d.shipment_rows} orphan_money=${money(d.orphan_money)}` +
      ` orphan_invoiced=${d.orphan_invoiced} ship_days=${d.distinct_ship_days}`,
    );
  }
  if (dupes.length > 25) console.log(`  … ${dupes.length - 25} more`);

  // ── 4. Money at risk ───────────────────────────────────────────────────────
  console.log('\n4. MONEY AT RISK (shipment-less service charges on orders that also have a shipment row)');
  const [risk] = await sql<{ pairs: string; orders: string; money: string; invoiced_money: string }[]>`
    with dup as (
      select b.client_id, b.order_id, b.line_type,
             sum(b.total_cost) filter (where b.shipment_id is null) as orphan_money,
             sum(b.total_cost) filter (where b.shipment_id is null and b.invoiced) as invoiced_money
        from public.billing_line_items b
       where b.order_id is not null
         and b.line_type in ${sql(SERVICE_LINE_TYPES)}
         ${CLIENT_ID === null ? sql`` : sql`and b.client_id = ${CLIENT_ID}`}
       group by b.client_id, b.order_id, b.line_type
      having count(*) filter (where b.shipment_id is null) > 0
         and count(*) filter (where b.shipment_id is not null) > 0
    )
    select count(*)::text as pairs,
           count(distinct order_id)::text as orders,
           coalesce(sum(orphan_money), 0)::text as money,
           coalesce(sum(invoiced_money), 0)::text as invoiced_money
      from dup`;
  console.log(`  affected orders          : ${risk!.orders}`);
  console.log(`  affected (order,type)    : ${risk!.pairs}`);
  console.log(`  shipment-less charges    : ${money(risk!.money)}`);
  console.log(`  …of which already INVOICED: ${money(risk!.invoiced_money)}  <- already billed to clients`);

  console.log('\nAUDIT COMPLETE. Nothing was written.');
  console.log('Repair is a separately authorized task requiring DJ approval. Preserve every row.');
} finally {
  await sql.end({ timeout: 5 });
}
