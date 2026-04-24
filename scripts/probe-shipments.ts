#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

// Verify every column name used by the /orders enrichment query actually exists.
await db.execute(sql`
  select
    order_id,
    tracking_number,
    carrier_code,
    service_code,
    ship_date,
    create_date,
    label_created_at,
    cost,
    label_cost,
    other_cost,
    label_url,
    label_shipment_id,
    provider_account_id,
    provider_account_nickname,
    selected_rate_json
  from shipments
  limit 1
`);
console.log('All column names in /orders enrichment exist on shipments.');
await pgClient.end({ timeout: 2 });
