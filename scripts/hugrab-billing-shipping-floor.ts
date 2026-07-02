/**
 * HUGRAB billing shipping floor.
 *
 * Rule: for HUGRAB billing shipping rows, when the backend-derived Selected Rate
 * is below $7.95, set the billed Shipping amount to $7.73.
 *
 * Dry-run by default. Use --apply to update billing_line_items only.
 *
 * Examples:
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --date-from=2026-07-01 --date-to=2026-07-03
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --apply --date-from=2026-07-01 --date-to=2026-07-03
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --revert --expect=465 --apply
 */

const CLIENT_NAME = 'HUGRAB';
const SELECTED_RATE_BELOW = 7.95;
const TARGET_SHIPPING = 7.73;
const DEFAULT_LIMIT = 5000;

type CandidateRow = {
  billing_line_id: number;
  order_id: number | null;
  order_number: string | null;
  ship_date: string | null;
  current_shipping: string;
  selected_rate_cost: string;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isoOrNull(name: string): string | null {
  const raw = argValue(name);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be a valid date`);
  return new Date(ms).toISOString();
}

function positiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveInt(name: string): number | null {
  const raw = argValue(name);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function money(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : '$0.00';
}

function usage(): void {
  console.log(`
HUGRAB billing shipping floor

Dry-run:
  npx tsx scripts/hugrab-billing-shipping-floor.ts

Apply:
  npx tsx scripts/hugrab-billing-shipping-floor.ts --apply

Revert the floor back to Selected Rate:
  npx tsx scripts/hugrab-billing-shipping-floor.ts --revert --expect=465 --apply

Optional:
  --date-from=YYYY-MM-DD   only billing ship_date on/after this date
  --date-to=YYYY-MM-DD     only billing ship_date before this date
  --limit=5000             max rows to inspect/update
  --expect=465             abort apply/revert unless the row count matches

Rule:
  client = ${CLIENT_NAME}
  line_type = shipping
  selected_rate_cost < ${money(SELECTED_RATE_BELOW)}
  current shipping > $0.00
  current shipping != ${money(TARGET_SHIPPING)}
  set unit_cost and total_cost to ${money(TARGET_SHIPPING)}
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    usage();
    return;
  }

  const apply = hasFlag('apply');
  const revert = hasFlag('revert');
  const dateFrom = isoOrNull('date-from');
  const dateTo = isoOrNull('date-to');
  const limit = positiveInt('limit', DEFAULT_LIMIT);
  const expectCount = optionalPositiveInt('expect');
  const { sql } = await import('../src/db/client');

  const candidates = await sql<CandidateRow[]>`
    with source_rows as (
      select
        b.id as billing_line_id,
        b.order_id,
        b.order_number,
        b.ship_date,
        b.total_cost as current_shipping,
        coalesce(s.cost, fs.cost) as cost,
        coalesce(s.label_cost, fs.label_cost) as label_cost,
        coalesce(s.other_cost, fs.other_cost) as other_cost,
        coalesce(s.selected_rate_json, fs.selected_rate_json) as selected_rate_json
      from billing_line_items b
      join clients c on c.id = b.client_id
      left join shipments s on s.id = b.shipment_id
      left join lateral (
        select sx.*
        from shipments sx
        where sx.order_id = b.order_id
          and coalesce(sx.voided, false) = false
          and coalesce(sx.is_return, false) = false
        order by sx.ship_date desc nulls last, sx.id desc
        limit 1
      ) fs on s.id is null and b.order_id is not null
      where c.name = ${CLIENT_NAME}
        and b.line_type = 'shipping'
        and b.total_cost > 0
        and b.description not ilike 'Included%'
        and (${dateFrom}::timestamptz is null or b.ship_date >= ${dateFrom}::timestamptz)
        and (${dateTo}::timestamptz is null or b.ship_date < ${dateTo}::timestamptz)
    ),
    priced_rows as (
      select
        src.billing_line_id,
        src.order_id,
        src.order_number,
        src.ship_date::text as ship_date,
        src.current_shipping::text as current_shipping,
        round(
          coalesce(
            money.postage_cost + money.other_cost,
            money.selected_total
          ),
          2
        ) as selected_rate_cost
      from source_rows src
      left join lateral (
        select
          coalesce(
            src.cost,
            src.label_cost,
            max(case
              when j.key in ('shipmentCost', 'shipment_cost', 'labelCost', 'label_cost', 'rateCostAmount')
                and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              then (j.value #>> '{}')::numeric
              else null
            end)
          ) as postage_cost,
          coalesce(
            src.other_cost,
            max(case
              when j.key in ('otherCost', 'other_cost', 'insuranceCost', 'insurance_cost')
                and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              then (j.value #>> '{}')::numeric
              else null
            end),
            0
          ) as other_cost,
          max(case
            when j.key in ('totalCost', 'total_cost')
              and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            then (j.value #>> '{}')::numeric
            else null
          end) as selected_total
        from jsonb_each(coalesce(src.selected_rate_json, '{}'::jsonb)) j
      ) money on true
    )
    select
      billing_line_id,
      order_id,
      order_number,
      ship_date,
      current_shipping,
      selected_rate_cost::text as selected_rate_cost
    from priced_rows
    where selected_rate_cost is not null
      and selected_rate_cost < ${SELECTED_RATE_BELOW}
      and (
        case
          when ${revert}::boolean
            then abs(current_shipping::numeric - ${TARGET_SHIPPING}) <= 0.004
              and abs(current_shipping::numeric - selected_rate_cost) > 0.004
          else abs(current_shipping::numeric - ${TARGET_SHIPPING}) > 0.004
        end
      )
    order by ship_date desc nulls last, billing_line_id desc
    limit ${limit}
  `;

  const currentTotal = candidates.reduce((sum, row) => sum + Number(row.current_shipping), 0);
  const newTotal = candidates.reduce(
    (sum, row) => sum + (revert ? Number(row.selected_rate_cost) : TARGET_SHIPPING),
    0,
  );
  const delta = newTotal - currentTotal;

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${CLIENT_NAME} billing shipping ${revert ? 'floor revert' : 'floor'}`);
  console.log(`Rows matched: ${candidates.length}`);
  console.log(`Current shipping total: ${money(currentTotal)}`);
  console.log(`New shipping total:     ${money(newTotal)}`);
  console.log(`Delta:                  ${money(delta)}`);
  console.log('');

  console.table(
    candidates.slice(0, 25).map((row) => ({
      billingLineId: row.billing_line_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      shipDate: row.ship_date,
      selectedRate: money(row.selected_rate_cost),
      from: money(row.current_shipping),
      to: money(revert ? row.selected_rate_cost : TARGET_SHIPPING),
    })),
  );
  if (candidates.length > 25) {
    console.log(`...${candidates.length - 25} more row(s) not shown`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to update these billing rows.');
    await sql.end({ timeout: 5 });
    return;
  }

  if (expectCount !== null && candidates.length !== expectCount) {
    console.log(
      `\nRefusing to update: --expect=${expectCount}, but matched ${candidates.length} row(s).`,
    );
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  if (!candidates.length) {
    console.log('\nNothing to update.');
    await sql.end({ timeout: 5 });
    return;
  }

  const updated = await sql.begin(async (tx) => {
    const ids: number[] = [];
    for (const row of candidates) {
      const amount = revert ? Number(row.selected_rate_cost) : TARGET_SHIPPING;
      const rows = await tx<{ id: number }[]>`
        update billing_line_items
           set unit_cost = ${amount.toFixed(2)}::numeric,
               total_cost = ${amount.toFixed(2)}::numeric
         where id = ${row.billing_line_id}
         returning id
      `;
      ids.push(...rows.map((updatedRow) => updatedRow.id));
    }
    return ids;
  });
  console.log(
    `\nUpdated ${updated.length} billing shipping row(s) ${revert ? 'back to Selected Rate' : `to ${money(TARGET_SHIPPING)}`}.`,
  );
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
