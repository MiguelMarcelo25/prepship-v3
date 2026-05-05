#!/usr/bin/env tsx
// Backfills inventory.image_url for SKUs that don't have one yet, using
// imageUrl values found in orders.items JSONB. Doesn't overwrite rows that
// already have an image; doesn't hit any external API.
//
// For each (clientId, sku) pair where image_url is NULL, scan orders for
// the most recent order item carrying that sku + a non-empty imageUrl, and
// copy it onto inventory.
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== Backfill inventory.image_url from orders.items ===\n');

  const before = await db.execute<{ has: number; missing: number }>(sql`
    select
      count(*) filter (where image_url is not null and image_url <> '')::int as has,
      count(*) filter (where image_url is null or image_url = '')::int as missing
    from inventory where active = true
  `);
  console.log(`BEFORE: has=${before[0]?.has}, missing=${before[0]?.missing}`);

  const result = await db.execute<{ updated: number }>(sql`
    with candidates as (
      select distinct on (i.id)
        i.id as inventory_id,
        nullif(item->>'imageUrl', '') as image_url
      from inventory i
      join orders o on (
        (o.client_id is null and i.client_id is null)
        or o.client_id = i.client_id
      )
      cross join lateral jsonb_array_elements(o.items) item
      where (i.image_url is null or i.image_url = '')
        and i.active = true
        and item ? 'sku'
        and lower(item->>'sku') = lower(i.sku)
        and nullif(item->>'imageUrl', '') is not null
      order by i.id, o.order_date desc nulls last
    ),
    upd as (
      update inventory
      set image_url = candidates.image_url, updated_at = now()
      from candidates
      where inventory.id = candidates.inventory_id
      returning 1
    )
    select count(*)::int as updated from upd
  `);
  console.log(`UPDATED: ${result[0]?.updated} inventory rows`);

  const after = await db.execute<{ has: number; missing: number }>(sql`
    select
      count(*) filter (where image_url is not null and image_url <> '')::int as has,
      count(*) filter (where image_url is null or image_url = '')::int as missing
    from inventory where active = true
  `);
  console.log(`AFTER:  has=${after[0]?.has}, missing=${after[0]?.missing}`);
}

main()
  .catch((e) => { console.error('FAIL:', e); process.exitCode = 1; })
  .finally(async () => { await pgClient.end({ timeout: 5 }); });
