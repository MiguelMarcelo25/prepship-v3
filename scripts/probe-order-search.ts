#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

const NEEDLE = process.argv[2] ?? '200014622686700';

async function main() {
  console.log(`\n=== Probe order search for "${NEEDLE}" ===\n`);

  // 1. Direct order_number match
  console.log('1. Exact / ilike match on orders.order_number / external_order_id:');
  const direct = await db.execute<{
    id: number;
    order_number: string | null;
    external_order_id: string | null;
    order_status: string | null;
    order_date: string | null;
    client_id: number | null;
    store_id: number | null;
    ship_to_name: string | null;
  }>(sql`
    select id, order_number, external_order_id, order_status, order_date,
           client_id, store_id, ship_to_name
    from orders
    where order_number ilike ${'%' + NEEDLE + '%'}
       or external_order_id ilike ${'%' + NEEDLE + '%'}
    order by order_date desc nulls last
    limit 10
  `);
  console.log(`  → ${direct.length} hit(s)`);
  for (const r of direct) {
    console.log(`    id=${r.id} order_number=${r.order_number} ext_id=${r.external_order_id} status=${r.order_status} date=${r.order_date} client=${r.client_id} store=${r.store_id} name=${r.ship_to_name}`);
  }
  console.log('');

  // 2. Tracking number match (in shipments)
  console.log('2. Match on shipments.tracking_number / label_tracking:');
  const ship = await db.execute<{
    id: number;
    order_id: number | null;
    order_number: string | null;
    tracking_number: string | null;
    label_tracking: string | null;
    voided: boolean | null;
  }>(sql`
    select id, order_id, order_number, tracking_number, label_tracking, voided
    from shipments
    where tracking_number ilike ${'%' + NEEDLE + '%'}
       or label_tracking  ilike ${'%' + NEEDLE + '%'}
    limit 10
  `);
  console.log(`  → ${ship.length} hit(s)`);
  for (const r of ship) {
    console.log(`    shipment_id=${r.id} order_id=${r.order_id} order_number=${r.order_number} tracking=${r.tracking_number} label_tracking=${r.label_tracking} voided=${r.voided}`);
  }
  console.log('');

  // 3. Any field anywhere on orders (the broad new-code search)
  console.log('3. Broad "anything ilike %NEEDLE%" against all the new searchable columns:');
  const broad = await db.execute<{
    id: number;
    order_number: string | null;
    order_status: string | null;
    order_date: string | null;
    matched_in: string;
  }>(sql`
    select id, order_number, order_status, order_date,
      case
        when order_number ilike ${'%' + NEEDLE + '%'} then 'order_number'
        when external_order_id ilike ${'%' + NEEDLE + '%'} then 'external_order_id'
        when ship_to_name ilike ${'%' + NEEDLE + '%'} then 'ship_to_name'
        when customer_email ilike ${'%' + NEEDLE + '%'} then 'customer_email'
        when ship_to_city ilike ${'%' + NEEDLE + '%'} then 'ship_to_city'
        when ship_to_state ilike ${'%' + NEEDLE + '%'} then 'ship_to_state'
        when ship_to_postal_code ilike ${'%' + NEEDLE + '%'} then 'ship_to_postal_code'
        when id::text ilike ${'%' + NEEDLE + '%'} then 'id'
        when raw->>'customerUsername' ilike ${'%' + NEEDLE + '%'} then 'raw.customerUsername'
        when raw->'shipTo'->>'company' ilike ${'%' + NEEDLE + '%'} then 'raw.shipTo.company'
        when raw->'shipTo'->>'street1' ilike ${'%' + NEEDLE + '%'} then 'raw.shipTo.street1'
        when raw->'shipTo'->>'street2' ilike ${'%' + NEEDLE + '%'} then 'raw.shipTo.street2'
        when exists (select 1 from jsonb_array_elements(items) item where item->>'sku' ilike ${'%' + NEEDLE + '%'} or item->>'name' ilike ${'%' + NEEDLE + '%'}) then 'items'
        else 'none'
      end as matched_in
    from orders
    where order_number ilike ${'%' + NEEDLE + '%'}
       or external_order_id ilike ${'%' + NEEDLE + '%'}
       or ship_to_name ilike ${'%' + NEEDLE + '%'}
       or customer_email ilike ${'%' + NEEDLE + '%'}
       or ship_to_city ilike ${'%' + NEEDLE + '%'}
       or ship_to_state ilike ${'%' + NEEDLE + '%'}
       or ship_to_postal_code ilike ${'%' + NEEDLE + '%'}
       or id::text ilike ${'%' + NEEDLE + '%'}
       or raw->>'customerUsername' ilike ${'%' + NEEDLE + '%'}
       or raw->'shipTo'->>'company' ilike ${'%' + NEEDLE + '%'}
       or raw->'shipTo'->>'street1' ilike ${'%' + NEEDLE + '%'}
       or raw->'shipTo'->>'street2' ilike ${'%' + NEEDLE + '%'}
       or exists (select 1 from jsonb_array_elements(items) item where item->>'sku' ilike ${'%' + NEEDLE + '%'} or item->>'name' ilike ${'%' + NEEDLE + '%'})
    order by order_date desc nulls last
    limit 10
  `);
  console.log(`  → ${broad.length} hit(s)`);
  for (const r of broad) {
    console.log(`    id=${r.id} order_number=${r.order_number} status=${r.order_status} date=${r.order_date} matched_in=${r.matched_in}`);
  }
  console.log('');

  // 4. Test the OLD-only fields (what production currently runs)
  console.log('4. Match on the OLD search set only (order_number, ship_to_name, customer_email):');
  const old = await db.execute<{ id: number; order_number: string; order_status: string }>(sql`
    select id, order_number, order_status
    from orders
    where order_number ilike ${'%' + NEEDLE + '%'}
       or ship_to_name ilike ${'%' + NEEDLE + '%'}
       or customer_email ilike ${'%' + NEEDLE + '%'}
    order by order_date desc nulls last
    limit 10
  `);
  console.log(`  → ${old.length} hit(s)`);
  for (const r of old) {
    console.log(`    id=${r.id} order_number=${r.order_number} status=${r.order_status}`);
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
