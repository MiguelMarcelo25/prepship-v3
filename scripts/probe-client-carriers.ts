#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== Client carrier-credential setup ===\n');
  const rows = await db.execute<{
    id: number;
    name: string;
    active: boolean;
    has_v1_key: boolean;
    has_v2_key: boolean;
    rate_source_client_id: number | null;
    rate_source_name: string | null;
  }>(sql`
    select c.id, c.name, c.active,
      c.ss_api_key   is not null as has_v1_key,
      c.ss_api_key_v2 is not null as has_v2_key,
      c.rate_source_client_id,
      src.name as rate_source_name
    from clients c
    left join clients src on src.id = c.rate_source_client_id
    order by c.id
  `);
  console.log('id  active  v1key  v2key  rateSrc  client');
  console.log('-'.repeat(70));
  for (const r of rows) {
    console.log(
      `${String(r.id).padEnd(3)} ${(r.active ? 'yes' : 'no').padEnd(7)} ${(r.has_v1_key ? '✓' : '·').padEnd(6)} ${(r.has_v2_key ? '✓' : '·').padEnd(6)} ${(r.rate_source_name ?? '—').padEnd(8)} ${r.name}`
    );
  }
  console.log('');
  console.log('Legend:');
  console.log('  v1key = ss_api_key (legacy ShipStation v1 endpoints)');
  console.log('  v2key = ss_api_key_v2 (used by /v2/carriers, /v2/rates/estimate)');
  console.log('  rateSrc = client this one borrows the v2 key from when it has none of its own');
  console.log('');
  console.log('How carrier scoping works:');
  console.log('  - With own v2key:   sees its own ShipStation account\'s carriers');
  console.log('  - With rateSrc:     borrows the source client\'s v2key, sees those carriers');
  console.log('  - With neither:     falls through to env SHIPSTATION_API_KEY_V2 (DR PREPPER main)');
}

main()
  .catch((err) => { console.error('FAIL:', err); process.exitCode = 1; })
  .finally(async () => { await pgClient.end({ timeout: 5 }); });
