#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== Inventory image_url health ===\n');

  const stats = await db.execute<{
    total: number;
    has_image: number;
    null_image: number;
    empty_image: number;
  }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where image_url is not null and image_url <> '')::int as has_image,
      count(*) filter (where image_url is null)::int as null_image,
      count(*) filter (where image_url = '')::int as empty_image
    from inventory
    where active = true
  `);
  const s = stats[0];
  console.log(`Total active SKUs:           ${s?.total ?? 0}`);
  console.log(`With image_url:              ${s?.has_image ?? 0}`);
  console.log(`Null image_url:              ${s?.null_image ?? 0}`);
  console.log(`Empty image_url:             ${s?.empty_image ?? 0}`);
  console.log('');

  console.log('Sample rows for the SKUs visible in your screenshot:');
  const rows = await db.execute<{ sku: string; image_url: string | null; client_id: number | null }>(sql`
    select sku, image_url, client_id from inventory
    where sku in ('B0F89RLYKQ','B0F89QXVBB','B0F89PWB4C','B0F89PCX9L','B0F7XNMT5V','B0F7X59J4P','B0F7X34CD9','B0DWI5PS6DG','B0DVNH9QKX')
    order by sku
  `);
  for (const r of rows) {
    console.log(`  ${r.sku.padEnd(15)} client=${String(r.client_id ?? '-').padEnd(3)} url=${r.image_url ? r.image_url.slice(0, 80) + (r.image_url.length > 80 ? '…' : '') : '(NULL)'}`);
  }
  console.log('');

  console.log('Sample 5 rows that DO have an image_url (to test):');
  const withUrl = await db.execute<{ sku: string; image_url: string }>(sql`
    select sku, image_url from inventory
    where image_url is not null and image_url <> ''
    limit 5
  `);
  for (const r of withUrl) {
    console.log(`  ${r.sku.padEnd(15)} ${r.image_url}`);
  }
}

main()
  .catch((e) => { console.error('FAIL:', e); process.exitCode = 1; })
  .finally(async () => { await pgClient.end({ timeout: 5 }); });
