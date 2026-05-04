#!/usr/bin/env tsx
// Confirms that the shipping-phase auto-save chain (ensurePanelPackageForDims
// → savePanelSkuDefaults → POST /products/save-defaults → mirror into inventory)
// is actually populating inventory.weight_oz / length / width / height /
// package_id for SKUs that have been through the shipping panel.
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== Probe: shipping-phase → inventory mirror ===\n');

  const totals = await db.execute<{
    total: number;
    has_weight: number;
    has_dims: number;
    has_pkg: number;
    has_any_default: number;
  }>(sql`
    select
      count(*)::int                                                  as total,
      count(*) filter (where weight_oz > 0)::int                     as has_weight,
      count(*) filter (where length > 0 and width > 0 and height > 0)::int as has_dims,
      count(*) filter (where package_id is not null)::int            as has_pkg,
      count(*) filter (
        where weight_oz > 0
           or (length > 0 and width > 0 and height > 0)
           or package_id is not null
      )::int                                                         as has_any_default
    from inventory
    where active = true
  `);
  const t = totals[0];
  console.log('Active inventory rows with shipping defaults populated:');
  console.log(`  total active SKUs:                  ${t?.total ?? 0}`);
  console.log(`  with weight_oz > 0:                 ${t?.has_weight ?? 0}`);
  console.log(`  with complete dims (L/W/H all > 0): ${t?.has_dims ?? 0}`);
  console.log(`  with package_id set:                ${t?.has_pkg ?? 0}`);
  console.log(`  with at least one default:          ${t?.has_any_default ?? 0}`);
  console.log('');

  // Cross-reference: which of these SKUs have actually been shipped recently?
  // If lots of SKUs have shipped but none have inventory defaults, the mirror
  // is broken. If most shipped SKUs have at least one default, it's working.
  const recent = await db.execute<{
    shipped_skus_30d: number;
    shipped_with_defaults: number;
  }>(sql`
    with shipped_skus as (
      select distinct lower(item->>'sku') as sku
      from orders o
      cross join lateral jsonb_array_elements(o.items) item
      where o.order_status = 'shipped'
        and o.order_date >= now() - interval '30 days'
        and item ? 'sku'
        and item->>'sku' <> ''
    )
    select
      (select count(*) from shipped_skus)::int as shipped_skus_30d,
      (
        select count(*)::int
        from shipped_skus s
        join inventory i on lower(i.sku) = s.sku
        where i.active = true
          and (
            i.weight_oz > 0
            or (i.length > 0 and i.width > 0 and i.height > 0)
            or i.package_id is not null
          )
      ) as shipped_with_defaults
  `);
  const r = recent[0];
  const ratio = r && r.shipped_skus_30d > 0
    ? Math.round((r.shipped_with_defaults / r.shipped_skus_30d) * 100)
    : 0;
  console.log('Of SKUs shipped in the last 30 days:');
  console.log(`  shipped distinct SKUs:              ${r?.shipped_skus_30d ?? 0}`);
  console.log(`  also have inventory defaults set:   ${r?.shipped_with_defaults ?? 0}  (${ratio}%)`);
  console.log('');

  // Recent updates timing — were any inventory rows updated by the shipping
  // mirror today? (Orders saved/shipped today should update inventory.updated_at.)
  const recentUpdates = await db.execute<{
    sku: string;
    weight_oz: number | null;
    length: number | null;
    width: number | null;
    height: number | null;
    package_id: number | null;
    updated_at: string;
  }>(sql`
    select sku, weight_oz, length, width, height, package_id, updated_at
    from inventory
    where active = true
      and (weight_oz > 0
           or (length > 0 and width > 0 and height > 0)
           or package_id is not null)
    order by updated_at desc
    limit 8
  `);
  console.log('Most-recent inventory rows with defaults (top 8):');
  for (const row of recentUpdates) {
    console.log(`  ${row.sku.padEnd(20)} w=${String(row.weight_oz ?? '-').padStart(6)}oz  dims=${row.length ?? '-'}x${row.width ?? '-'}x${row.height ?? '-'}  pkg=${row.package_id ?? '-'}  updated=${row.updated_at}`);
  }
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
