import 'dotenv/config';
import postgres from 'postgres';

export const PS439_CLASSIFICATIONS = [
  'balance_mismatch',
  'missing_movement',
  'duplicate_ship_deduction',
  'direct_stock_write',
  'negative_balance',
  'case_variant_sku_collision',
  'missing_volume',
  'duplicate_storage_line',
  'billing_display_mismatch',
] as const;

const REPORT_SQL = `
with ledger_balance as (
  select inventory_id, coalesce(sum(qty), 0)::int as inventory_quantity
  from inventory_ledger group by inventory_id
), inventory_audit as (
  select
    i.id,
    i.client_id,
    i.sku,
    nullif(to_jsonb(i)->>'stock_qty', '')::int as legacy_quantity,
    coalesce(lb.inventory_quantity, 0)::int as inventory_quantity,
    i.updated_at,
    i.cu_ft_override,
    i.length,
    i.width,
    i.height
  from inventory i left join ledger_balance lb on lb.inventory_id = i.id
), missing_ship as (
  select distinct i.id, o.id as order_id
  from inventory i
  join order_items oi on lower(oi.sku) = lower(i.sku)
  join orders o on o.id = oi.order_id
    and o.order_status = 'shipped'
    and ((i.client_id is null and o.client_id is null) or i.client_id = o.client_id)
  where oi.quantity > 0
    and not exists (
      select 1 from inventory_ledger l
      where l.inventory_id = i.id and l.order_id = o.id and l.type = 'ship'
    )
), duplicate_ship as (
  select inventory_id, order_id
  from inventory_ledger
  where type = 'ship' and order_id is not null
  group by inventory_id, order_id having count(*) > 1
), case_collision as (
  select client_id, lower(sku)
  from inventory
  group by client_id, lower(sku)
  having count(distinct sku) > 1
), duplicate_storage as (
  select client_id, description
  from billing_line_items
  where line_type = 'storage' and order_id is null
  group by client_id, description having count(*) > 1
), billing_mismatch as (
  select m.client_id, m.period_from, m.period_to
  from billing_summary_metrics m
  left join billing_line_items b
    on b.client_id = m.client_id
   and coalesce(b.billing_effective_date, b.ship_date)::date >= m.period_from
   and coalesce(b.billing_effective_date, b.ship_date)::date < m.period_to
  group by m.client_id, m.period_from, m.period_to, m.grand_total
  having abs(coalesce(sum(b.total_cost), 0) - m.grand_total) >= 0.01
)
select
  count(*) filter (where legacy_quantity is not null and legacy_quantity <> inventory_quantity)::int as balance_mismatch,
  (select count(*) from missing_ship)::int as missing_movement,
  (select count(*) from duplicate_ship)::int as duplicate_ship_deduction,
  count(*) filter (
    where legacy_quantity is not null
      and legacy_quantity <> inventory_quantity
      and updated_at > coalesce((select max(created_at) from inventory_ledger l where l.inventory_id = inventory_audit.id), '-infinity'::timestamptz)
  )::int as direct_stock_write,
  count(*) filter (where inventory_quantity < 0)::int as negative_balance,
  (select count(*) from case_collision)::int as case_variant_sku_collision,
  count(*) filter (
    where not (coalesce(cu_ft_override, 0) > 0 or (length > 0 and width > 0 and height > 0))
  )::int as missing_volume,
  (select count(*) from duplicate_storage)::int as duplicate_storage_line,
  (select count(*) from billing_mismatch)::int as billing_display_mismatch
from inventory_audit
`;

function selfTest(): void {
  for (const classification of PS439_CLASSIFICATIONS) {
    if (!REPORT_SQL.includes(classification)) throw new Error(`Missing ${classification}`);
  }
  if (/\b(update|delete|insert|alter|drop|truncate)\b/i.test(REPORT_SQL)) {
    throw new Error('Discrepancy report must remain read-only');
  }
  console.log(`PS-439 discrepancy report self-test passed (${PS439_CLASSIFICATIONS.length} classifications).`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) return selfTest();
  if (process.argv.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) {
    throw new Error('PS-439 discrepancy reporting is read-only; --apply is not supported.');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await sql.unsafe<Record<string, number>[]>(REPORT_SQL);
    const classifications = Object.fromEntries(
      PS439_CLASSIFICATIONS.map((name) => [name, Number(row?.[name] ?? 0)]),
    );
    console.log(JSON.stringify({ contract: 'ps439_read_only_discrepancy_counts', classifications }, null, 2));
  } finally {
    await sql.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
