#!/usr/bin/env tsx
import postgres from 'postgres';

const SRC = process.env.SOURCE_DATABASE_URL!;
const TGT = process.env.TARGET_DATABASE_URL!;

async function main() {
  const src = postgres(SRC, { prepare: false, max: 2, idle_timeout: 5 });
  const tgt = postgres(TGT, { prepare: false, max: 2, idle_timeout: 5 });

  console.log('\n=== Migration verification ===\n');

  console.log('Auth users on target:');
  const users = await tgt`select id, email, email_confirmed_at from auth.users order by email`;
  for (const u of users) console.log(`  ${u.id}  ${u.email}  confirmed=${u.email_confirmed_at != null}`);

  console.log('\nSpot-check: orders.assigned_to_user_id values point at real auth users on target?');
  const assigned = await tgt`
    select count(*)::int as total,
      count(*) filter (where exists (select 1 from auth.users u where u.id = o.assigned_to_user_id::uuid))::int as resolves
    from orders o where assigned_to_user_id is not null
  `;
  const a = assigned[0] as { total: number; resolves: number };
  console.log(`  ${a.resolves}/${a.total} assigned orders point at a valid user on target`);

  console.log('\nSpot-check: 3 most-recent orders match between source and target?');
  const srcRecent = await src`select id, order_number, order_status, order_date from orders order by id desc limit 3`;
  const tgtRecent = await tgt`select id, order_number, order_status, order_date from orders order by id desc limit 3`;
  for (let i = 0; i < 3; i++) {
    const s = srcRecent[i] as { id: number; order_number: string };
    const t = tgtRecent[i] as { id: number; order_number: string };
    const match = s && t && s.id === t.id && s.order_number === t.order_number;
    console.log(`  ${match ? '✓' : '✗'}  src id=${s?.id} ord=${s?.order_number}   tgt id=${t?.id} ord=${t?.order_number}`);
  }

  console.log('\nSpot-check: settings keys match?');
  const sSet = await src`select key from settings order by key`;
  const tSet = await tgt`select key from settings order by key`;
  console.log(`  source: ${sSet.length} keys: ${sSet.map((r) => (r as { key: string }).key).join(', ')}`);
  console.log(`  target: ${tSet.length} keys: ${tSet.map((r) => (r as { key: string }).key).join(', ')}`);

  console.log('\nDatabase size on target:');
  const size = await tgt`select pg_size_pretty(pg_database_size(current_database())) as size`;
  console.log(`  ${(size[0] as { size: string }).size}`);

  await src.end({ timeout: 5 });
  await tgt.end({ timeout: 5 });
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
