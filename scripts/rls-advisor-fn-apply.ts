/**
 * Pin search_path on public.prepship_refresh_order_items_for_order() to satisfy
 * the "Function Search Path Mutable" advisor. Does not change the function body.
 * Idempotent; verifies the resulting proconfig.
 *
 *   npx tsx scripts/rls-advisor-fn-apply.ts
 */
import { sql } from '../src/db/client';

async function readConfig() {
  const rows = await sql<Array<{ config: string[] | null }>>`
    SELECT p.proconfig AS config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'prepship_refresh_order_items_for_order';
  `;
  if (!rows.length) throw new Error('Function public.prepship_refresh_order_items_for_order() not found.');
  return rows[0].config;
}

async function main() {
  console.log('before:', JSON.stringify(await readConfig()));
  await sql.unsafe(
    `ALTER FUNCTION public.prepship_refresh_order_items_for_order() SET search_path = public, pg_temp;`,
  );
  const after = await readConfig();
  console.log('after :', JSON.stringify(after));
  const ok = (after ?? []).some((c) => c.startsWith('search_path='));
  console.log(ok ? '\nOK — search_path is now fixed (advisor satisfied).' : '\nWARN — search_path not set.');
  if (!ok) process.exit(1);
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('fn-apply failed:', err);
  process.exit(1);
});
