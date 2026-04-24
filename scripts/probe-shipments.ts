#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

const pageOrderIds = (
  await db.execute<{ id: number; external_order_id: string }>(
    sql`select o.id, o.external_order_id
        from orders o
        where o.order_status = 'shipped'
          and exists (select 1 from shipments s where s.order_id = o.id and coalesce(s.voided,false) = false)
        order by o.order_date desc limit 5`,
  )
);
console.log('pageOrderIds', pageOrderIds);

const idList = sql.join(
  pageOrderIds.map((r) => sql`${r.id}`),
  sql`, `,
);
const shipRows = await db.execute<Record<string, unknown>>(sql`
  select order_id, voided, carrier_code, service_code, tracking_number
  from shipments
  where order_id in (${idList})
  order by order_id, id desc
`);
console.log('shipments for these orders:', shipRows.length);
for (const s of shipRows) console.log(JSON.stringify(s));

// Also: how many shipped orders have ANY matching shipment?
const stats = await db.execute<{ shipped_orders: number; with_shipments: number; without: number }>(sql`
  select
    count(*)::int as shipped_orders,
    sum(case when exists (select 1 from shipments s where s.order_id = o.id and coalesce(s.voided, false) = false) then 1 else 0 end)::int as with_shipments,
    sum(case when not exists (select 1 from shipments s where s.order_id = o.id and coalesce(s.voided, false) = false) then 1 else 0 end)::int as without
  from orders o
  where o.order_status = 'shipped'
`);
console.log('STATS:', stats[0]);

await pgClient.end({ timeout: 2 });
