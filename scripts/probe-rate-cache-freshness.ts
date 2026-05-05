#!/usr/bin/env tsx
// Determines whether PROD has actually deployed the new code by checking
// the rate_cache table:
//   - The new code prefixes every cache key with "v=ground-saver-v1|"
//   - The new /carriers-for-store + /v2/rates/estimate path bumps that key
//     when it inserts. So any rate_cache rows with the new prefix dated
//     after the push are evidence that PROD is running the new code.
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== rate_cache freshness probe ===\n');

  const summary = await db.execute<{
    total: number;
    new_version: number;
    new_in_last_hour: number;
    new_today: number;
    most_recent_new: string | null;
    most_recent_old: string | null;
  }>(sql`
    select
      count(*)::int                                                                               as total,
      count(*) filter (where cache_key like 'v=ground-saver-v1|%')::int                           as new_version,
      count(*) filter (where cache_key like 'v=ground-saver-v1|%' and fetched_at >= now() - interval '1 hour')::int as new_in_last_hour,
      count(*) filter (where cache_key like 'v=ground-saver-v1|%' and fetched_at >= now() - interval '24 hours')::int as new_today,
      max(case when cache_key like 'v=ground-saver-v1|%' then fetched_at end)::text              as most_recent_new,
      max(case when cache_key not like 'v=ground-saver-v1|%' then fetched_at end)::text          as most_recent_old
    from rate_cache
  `);
  const s = summary[0];
  console.log('Cache row counts:');
  console.log(`  total rows:                      ${s?.total ?? 0}`);
  console.log(`  with v=ground-saver-v1 prefix:   ${s?.new_version ?? 0}`);
  console.log(`  new-prefix rows in last hour:    ${s?.new_in_last_hour ?? 0}`);
  console.log(`  new-prefix rows in last 24 h:    ${s?.new_today ?? 0}`);
  console.log('');
  console.log('Most-recent fetch by version:');
  console.log(`  newest with NEW key prefix: ${s?.most_recent_new ?? '(none)'}`);
  console.log(`  newest with OLD key prefix: ${s?.most_recent_old ?? '(none)'}`);
  console.log('');

  // Check whether any new-prefix entries actually contain Ground Saver,
  // which the OLD filter would have stripped before caching.
  const gs = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from rate_cache
    where cache_key like 'v=ground-saver-v1|%'
      and (
        rates::text ilike '%ups_surepost%'
        or rates::text ilike '%ups_ground_saver%'
        or rates::text ilike '%Ground Saver%'
      )
  `);
  console.log(`New-prefix rows that include UPS Ground Saver / SurePost: ${gs[0]?.count ?? 0}`);
  console.log('');

  if ((s?.new_in_last_hour ?? 0) > 0) {
    console.log('VERDICT: PROD is serving the new code (cache writes seen in the last hour).');
  } else if ((s?.new_today ?? 0) > 0) {
    console.log('VERDICT: PROD has served the new code recently (writes within 24h).');
    console.log('  If user still sees 22 carriers, it may be browser cache on');
    console.log('  the rates UI — hard-refresh the page (Ctrl+Shift+R).');
  } else {
    console.log('VERDICT: No PROD writes against the new key prefix yet — the deploy');
    console.log('  may not have promoted, OR no Rate Browser opens have happened since.');
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
