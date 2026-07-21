import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { inventory, inventoryLedger } from '../src/db/schema/inventory';
import { orders } from '../src/db/schema/orders';
import { deductInventoryForOrder } from '../src/services/fulfillment-deductions';
import { ensureInventoryLedgerSchema } from '../src/services/inventory-ledger-schema';

type Args = {
  sku?: string;
  all: boolean;
  dryRun: boolean;
  limit?: number;
  since?: Date;
};

function parseArgs(argv: string[]): Args {
  // Per user override unlock shipped data on 2026-07-15: repair is read-only
  // by default. Production mutation requires the explicit --apply flag in
  // addition to the separate operator approval documented on PS-432.
  const args: Args = { all: false, dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--apply') {
      args.dryRun = false;
    } else if (arg === '--sku') {
      args.sku = argv[index + 1]?.trim();
      index += 1;
    } else if (arg.startsWith('--sku=')) {
      args.sku = arg.slice('--sku='.length).trim();
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) args.limit = parsed;
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.limit = parsed;
    } else if (arg === '--since') {
      const parsed = new Date(argv[index + 1] ?? '');
      if (Number.isNaN(parsed.getTime())) throw new Error('--since requires a valid date');
      args.since = parsed;
      index += 1;
    } else if (arg.startsWith('--since=')) {
      const parsed = new Date(arg.slice('--since='.length));
      if (Number.isNaN(parsed.getTime())) throw new Error('--since requires a valid date');
      args.since = parsed;
    }
  }
  return args;
}

function asDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function skuPredicate(sku: string | undefined) {
  return sku
    ? sql`and lower(item->>'sku') = lower(${sku})`
    : sql``;
}

async function getSummary(sku: string | undefined, since: Date | undefined) {
  const sinceIso = since?.toISOString();
  const [summary] = await db.execute<{
    shipped_orders: number;
    shipped_lines: number;
    shipped_units: number;
    lines_with_ledger: number;
    units_with_ledger: number;
    missing_lines: number;
    missing_units: number;
    missing_orders: number;
  }>(sql`
    with lines as (
      select
        o.id as order_id,
        o.client_id,
        item->>'sku' as sku,
        case
          when coalesce(item->>'quantity', '') ~ '^[0-9]+$'
            then (item->>'quantity')::int
          else 1
        end as qty
      from ${orders} o
      cross join lateral jsonb_array_elements(o.items) item
      where o.order_status = 'shipped'
        ${sinceIso ? sql`and o.updated_at >= ${sinceIso}::timestamptz` : sql``}
        and item ? 'sku'
        and coalesce(item->>'sku', '') <> ''
        and coalesce(item->>'adjustment', 'false') <> 'true'
        ${skuPredicate(sku)}
    ),
    matched as (
      select
        lines.*,
        inv.id as inventory_id,
        exists (
          select 1
          from ${inventoryLedger} ledger
          where ledger.order_id = lines.order_id
            and ledger.type = 'ship'
            and ledger.inventory_id = inv.id
        ) as has_line_ledger
      from lines
      left join lateral (
        select ${inventory.id}
        from ${inventory}
        where lower(${inventory.sku}) = lower(lines.sku)
          and ${inventory.active} = true
          and (
            (lines.client_id is not null and ${inventory.clientId} = lines.client_id)
            or ${inventory.clientId} is null
          )
        order by case when ${inventory.clientId} = lines.client_id then 0 else 1 end
        limit 1
      ) inv on true
    )
    select
      count(distinct order_id)::int as shipped_orders,
      count(*)::int as shipped_lines,
      coalesce(sum(qty), 0)::int as shipped_units,
      count(*) filter (where has_line_ledger)::int as lines_with_ledger,
      coalesce(sum(qty) filter (where has_line_ledger), 0)::int as units_with_ledger,
      count(*) filter (where not has_line_ledger)::int as missing_lines,
      coalesce(sum(qty) filter (where not has_line_ledger), 0)::int as missing_units,
      count(distinct order_id) filter (where not has_line_ledger)::int as missing_orders
    from matched
  `);
  return summary;
}

async function alignExistingLedgerDates(sku: string | undefined, since: Date | undefined) {
  const sinceIso = since?.toISOString();
  const rows = await db.execute<{ id: number }>(sql`
    update ${inventoryLedger} ledger
    set effective_at = ${orders.orderDate}
    from ${orders}, ${inventory}
    where ledger.order_id = ${orders.id}
      and ledger.inventory_id = ${inventory.id}
      and ledger.type = 'ship'
      and ${orders.orderDate} is not null
      ${sku ? sql`and lower(${inventory.sku}) = lower(${sku})` : sql``}
      ${sinceIso ? sql`and ${orders.updatedAt} >= ${sinceIso}::timestamptz` : sql``}
      and ledger.effective_at is distinct from ${orders.orderDate}
    returning ledger.id
  `);
  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sku && !args.all) {
    throw new Error('Pass --sku "SKU" for a targeted backfill, or --all for every SKU.');
  }
  if (!args.dryRun && args.all && !args.since) {
    throw new Error('Refusing unbounded --all apply. Pass an audited --since date.');
  }

  const before = await getSummary(args.sku, args.since);
  console.log('Scope:', JSON.stringify({
    sku: args.sku ?? 'all',
    since: args.since?.toISOString() ?? null,
  }));
  console.log('Before:', JSON.stringify(before));

  if (args.dryRun) {
    console.log('Dry run only. No rows changed.');
    return;
  }
  await ensureInventoryLedgerSchema();

  const filters = [
    eq(orders.orderStatus, 'shipped'),
    args.since ? sql`${orders.updatedAt} >= ${args.since.toISOString()}::timestamptz` : undefined,
    args.sku
      ? sql`exists (
          select 1
          from jsonb_array_elements(${orders.items}) item
          where item ? 'sku'
            and lower(item->>'sku') = lower(${args.sku})
            and coalesce(item->>'adjustment', 'false') <> 'true'
        )`
      : undefined,
  ].filter(<T>(value: T | undefined): value is T => value !== undefined);

  let query = db
    .select()
    .from(orders)
    .where(and(...filters))
    .orderBy(asc(orders.orderDate), asc(orders.id));

  if (args.limit) {
    query = query.limit(args.limit) as typeof query;
  }

  const orderRows = await query;
  let deductedUnits = 0;
  let skippedUnits = 0;
  let touchedOrders = 0;

  for (const order of orderRows) {
    const result = await deductInventoryForOrder(order, {
      source: 'retroactive_order_backfill',
      effectiveAt: asDate(order.orderDate) ?? asDate(order.updatedAt) ?? new Date(),
      skus: args.sku ? [args.sku] : undefined,
    });
    deductedUnits += result.deducted ?? 0;
    skippedUnits += result.skippedUnits ?? 0;
    if ((result.deducted ?? 0) > 0) touchedOrders += 1;
  }

  const normalizedDates = await alignExistingLedgerDates(args.sku, args.since);
  const after = await getSummary(args.sku, args.since);

  console.log('Backfill:', JSON.stringify({
    scannedOrders: orderRows.length,
    touchedOrders,
    deductedUnits,
    skippedUnits,
    normalizedDates,
  }));
  console.log('After:', JSON.stringify(after));
}

main()
  .catch((err) => {
    const cause = err && typeof err === 'object' && 'cause' in err
      ? (err as { cause?: { message?: string } }).cause
      : null;
    if (cause?.message) console.error(`Cause: ${cause.message}`);
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
