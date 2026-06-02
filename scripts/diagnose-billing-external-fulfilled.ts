import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client';

type DiagnosticRow = {
  client_id: number;
  client_name: string;
  total_source_orders: number;
  previously_excluded_external: number;
  generated_billing_orders: number;
  included_with_missing_shipping_cost: number;
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isoOrDefault(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${raw}`);
  }
  return date.toISOString();
}

async function main() {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const dateFrom = isoOrDefault(argValue('from') ?? argValue('dateFrom'), defaultFrom.toISOString());
  const dateTo = isoOrDefault(argValue('to') ?? argValue('dateTo'), now.toISOString());
  const clientLike = argValue('client');

  const rows = await db.execute<DiagnosticRow>(sql`
    with scoped_clients as (
      select c.id, c.name, c.store_ids
      from clients c
      where c.active = true
        and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
        ${clientLike ? sql`and c.name ilike ${`%${clientLike}%`}` : sql``}
    ),
    source_orders as (
      select
        o.id as order_id,
        sc.id as client_id,
        sc.name as client_name,
        coalesce(s.ship_date, o.order_date) as billable_date,
        coalesce(o.externally_shipped, false) as externally_shipped,
        coalesce(o.raw->>'externallyFulfilled', 'false') = 'true' as externally_fulfilled,
        coalesce(s.cost, s.label_cost, '0')::numeric + coalesce(s.other_cost, '0')::numeric as shipping_cost
      from orders o
      join scoped_clients sc
        on o.client_id = sc.id
        or (o.store_id is not null and o.store_id = any(sc.store_ids))
      left join shipments s on s.order_id = o.id and s.voided = false
      where o.order_status = 'shipped'
        and coalesce(s.ship_date, o.order_date) >= ${dateFrom}::timestamptz
        and coalesce(s.ship_date, o.order_date) <= ${dateTo}::timestamptz
    ),
    billing_orders as (
      select
        b.client_id,
        b.order_id,
        bool_or(b.line_type = 'shipping_missing') as has_missing_shipping
      from billing_line_items b
      where b.ship_date >= ${dateFrom}::timestamptz
        and b.ship_date <= ${dateTo}::timestamptz
        and b.order_id is not null
      group by b.client_id, b.order_id
    )
    select
      so.client_id,
      so.client_name,
      count(distinct so.order_id)::int as total_source_orders,
      count(distinct so.order_id) filter (
        where so.externally_shipped = true or so.externally_fulfilled = true
      )::int as previously_excluded_external,
      count(distinct bo.order_id)::int as generated_billing_orders,
      count(distinct bo.order_id) filter (where bo.has_missing_shipping = true)::int
        as included_with_missing_shipping_cost
    from source_orders so
    left join billing_orders bo
      on bo.client_id = so.client_id and bo.order_id = so.order_id
    group by so.client_id, so.client_name
    order by so.client_name asc
  `);

  const output = rows.map((row) => ({
    client: row.client_name,
    totalSourceOrders: Number(row.total_source_orders ?? 0),
    previouslyExcludedExternal: Number(row.previously_excluded_external ?? 0),
    generatedBillingOrders: Number(row.generated_billing_orders ?? 0),
    includedWithMissingShippingCost: Number(row.included_with_missing_shipping_cost ?? 0),
  }));

  console.log('[PS-067 billing external fulfilled diagnostic] DRY RUN - read-only');
  console.log(`Range: ${dateFrom} to ${dateTo}`);
  console.table(output);
  console.log('No orders, shipments, labels, billing rows, postage, or marketplace state were mutated.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
