/**
 * Apply RLS hardening migration directly against the database, bypassing the
 * Supabase Dashboard SQL Editor's 60s gateway timeout.
 *
 * Each statement runs with `lock_timeout = '5s'` so if a table is locked by
 * another transaction (backend sync, dashboard query, etc.) we fail FAST
 * with a clear error instead of hanging for a minute.
 *
 * Usage:
 *   npx tsx scripts/apply-rls-hardening.ts            # run RLS + PK + indexes
 *   npx tsx scripts/apply-rls-hardening.ts --diagnose # only show what's blocking
 *   npx tsx scripts/apply-rls-hardening.ts --rls      # only RLS (skip PK/indexes)
 *
 * Requires DATABASE_URL in .env. Auto-switches port 6543 → 5432 (session pooler)
 * because DDL needs session state which the transaction pooler doesn't provide.
 */
import 'dotenv/config';
import * as postgresModule from 'postgres';
const postgres = (postgresModule as any).default ?? postgresModule;
type Sql = ReturnType<typeof postgres>;

const RLS_TABLES = [
  'sku_qty_dims', 'settings', 'orders', 'locations',
  'inventory_ledger', 'billing_ref_rates', 'parent_skus', 'billing_line_items',
  'print_queue_orders', 'client_package_prices', 'packages', 'inventory',
  'package_ledger', 'product_defaults', 'clients', 'sync_meta',
  'billing_config', 'mock_labels', 'return_labels', 'inventory_sku_parents',
  'products', 'rate_cache', 'order_overrides', 'shipments',
] as const;

const args = new Set(process.argv.slice(2));
const diagnoseOnly = args.has('--diagnose');
const rlsOnly = args.has('--rls');

function connectionString(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('❌ DATABASE_URL not set in .env');
    process.exit(1);
  }
  // Transaction pooler (6543) doesn't support session-level SETs we need.
  // Switch to session pooler (5432) silently.
  const fixed = raw.replace(':6543/', ':5432/');
  if (fixed !== raw) {
    console.log('ℹ️  Using session pooler (port 5432) instead of transaction pooler (6543)');
  }
  return fixed;
}

async function showBlockers(sql: Sql): Promise<number> {
  const rows = await sql<Array<{
    pid: number;
    usename: string | null;
    application_name: string | null;
    state: string | null;
    wait_event: string | null;
    query_start: Date | null;
    query: string | null;
  }>>`
    SELECT pid, usename, application_name, state, wait_event,
           query_start, LEFT(query, 100) AS query
    FROM pg_stat_activity
    WHERE state IS NOT NULL
      AND state != 'idle'
      AND pid != pg_backend_pid()
      AND backend_type = 'client backend'
    ORDER BY query_start NULLS LAST
  `;

  if (rows.length === 0) {
    console.log('✅ No active sessions found — locks should be free');
    return 0;
  }

  console.log(`\n⚠️  ${rows.length} active session(s) — any of these could hold locks:\n`);
  for (const r of rows) {
    const age = r.query_start ? `${Math.round((Date.now() - r.query_start.getTime()) / 1000)}s` : '?';
    console.log(`  PID ${r.pid} (${r.application_name ?? 'unknown'}, ${r.state}, age ${age})`);
    console.log(`    wait_event: ${r.wait_event ?? '—'}`);
    console.log(`    query: ${(r.query ?? '').replace(/\s+/g, ' ').trim()}\n`);
  }
  console.log('💡 To kill a stuck session: SELECT pg_terminate_backend(<pid>);\n');
  return rows.length;
}

async function applyRls(sql: Sql): Promise<{ done: number; skipped: number; failed: string[] }> {
  let done = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const table of RLS_TABLES) {
    const t0 = Date.now();
    try {
      // Check current state first (idempotent skip)
      const [{ enabled }] = await sql<Array<{ enabled: boolean }>>`
        SELECT COALESCE(c.relrowsecurity, false) AS enabled
        FROM pg_class c
        WHERE c.relname = ${table}
          AND c.relnamespace = 'public'::regnamespace
      `;
      if (enabled) {
        console.log(`  ⏭️  ${table.padEnd(28)} already enabled, skipped`);
        skipped++;
        continue;
      }

      // Wrap in a real transaction so SET LOCAL actually applies + auto-resets
      await sql.begin(async (tx: Sql) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '5s'`);
        await tx.unsafe(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      });
      const ms = Date.now() - t0;
      console.log(`  ✅ ${table.padEnd(28)} done (${ms}ms)`);
      done++;
    } catch (err: any) {
      const msg = String(err?.message ?? err).split('\n')[0];
      console.log(`  ❌ ${table.padEnd(28)} FAILED: ${msg}`);
      failed.push(table);
    }
  }

  return { done, skipped, failed };
}

async function applyPrimaryKey(sql: Sql): Promise<boolean> {
  // Check duplicates first
  const dups = await sql<Array<{ client_id: number; package_id: number; dup_count: number }>>`
    SELECT client_id, package_id, COUNT(*)::int AS dup_count
    FROM client_package_prices
    GROUP BY client_id, package_id
    HAVING COUNT(*) > 1
    LIMIT 5
  `;
  if (dups.length > 0) {
    console.log(`  ❌ client_package_prices has ${dups.length}+ duplicate (client_id, package_id) pairs:`);
    for (const d of dups) {
      console.log(`     client_id=${d.client_id}, package_id=${d.package_id}, count=${d.dup_count}`);
    }
    console.log('     Resolve duplicates manually before re-running.');
    return false;
  }

  // Add PK if not present
  const [{ has_pk }] = await sql<Array<{ has_pk: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.client_package_prices'::regclass AND contype = 'p'
    ) AS has_pk
  `;
  if (has_pk) {
    console.log('  ⏭️  client_package_prices already has a primary key, skipped');
    return true;
  }

  try {
    await sql.begin(async (tx: Sql) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '5s'`);
      await tx.unsafe(`
        ALTER TABLE public.client_package_prices
        ADD CONSTRAINT client_package_prices_pkey PRIMARY KEY (client_id, package_id)
      `);
      await tx.unsafe(`DROP INDEX IF EXISTS public.client_package_prices_pk_idx`);
    });
    console.log('  ✅ client_package_prices: primary key added, redundant index dropped');
    return true;
  } catch (err: any) {
    console.log(`  ❌ client_package_prices PK FAILED: ${String(err?.message ?? err).split('\n')[0]}`);
    return false;
  }
}

async function applyIndexes(sql: Sql): Promise<{ done: number; failed: string[] }> {
  // CREATE INDEX CONCURRENTLY can NOT be in a transaction. The `postgres`
  // driver wraps each .unsafe() call in its own statement, but if the driver
  // has any pending transaction state it'll fail. We use a fresh connection
  // for each CONCURRENTLY index to be safe.
  const indexes: Array<{ name: string; sql: string }> = [
    {
      name: 'billing_li_shipment_idx',
      sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_li_shipment_idx
            ON public.billing_line_items (shipment_id) WHERE shipment_id IS NOT NULL`,
    },
    {
      name: 'billing_li_order_idx',
      sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_li_order_idx
            ON public.billing_line_items (order_id) WHERE order_id IS NOT NULL`,
    },
    {
      name: 'inventory_ledger_order_idx',
      sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_ledger_order_idx
            ON public.inventory_ledger (order_id) WHERE order_id IS NOT NULL`,
    },
  ];

  let done = 0;
  const failed: string[] = [];
  for (const idx of indexes) {
    const t0 = Date.now();
    try {
      await sql.unsafe(idx.sql);
      const ms = Date.now() - t0;
      console.log(`  ✅ ${idx.name.padEnd(32)} done (${ms}ms)`);
      done++;
    } catch (err: any) {
      const msg = String(err?.message ?? err).split('\n')[0];
      console.log(`  ❌ ${idx.name.padEnd(32)} FAILED: ${msg}`);
      failed.push(idx.name);
    }
  }
  return { done, failed };
}

async function main() {
  const connStr = connectionString();
  // max:1 = single connection, simple/predictable for migrations
  const sql = postgres(connStr, { max: 1, idle_timeout: 5, connect_timeout: 10 });

  try {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Step 1 — Diagnose: who else is connected?');
    console.log('═══════════════════════════════════════════════════════════════');
    const blockerCount = await showBlockers(sql);

    if (diagnoseOnly) {
      console.log('Diagnose-only mode, exiting.');
      return;
    }

    if (blockerCount > 0) {
      console.log('⚠️  Active sessions detected. RLS will still try with 5s lock_timeout.');
      console.log('   If something fails with "lock_timeout", terminate the blocker and re-run.\n');
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Step 2 — RLS on 24 tables (5s lock timeout each)');
    console.log('═══════════════════════════════════════════════════════════════');
    const rlsResult = await applyRls(sql);
    console.log(`\n  Summary: ${rlsResult.done} enabled, ${rlsResult.skipped} skipped, ${rlsResult.failed.length} failed`);
    if (rlsResult.failed.length > 0) {
      console.log(`  Failed tables: ${rlsResult.failed.join(', ')}`);
      console.log(`  Re-run after resolving locks. The script is idempotent.`);
    }

    if (rlsOnly) {
      console.log('\n--rls flag set, skipping PK + indexes.');
      return;
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Step 3 — Primary key on client_package_prices');
    console.log('═══════════════════════════════════════════════════════════════');
    await applyPrimaryKey(sql);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Step 4 — Indexes on unindexed FKs (CONCURRENTLY)');
    console.log('═══════════════════════════════════════════════════════════════');
    const idxResult = await applyIndexes(sql);
    console.log(`\n  Summary: ${idxResult.done} created, ${idxResult.failed.length} failed`);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Done!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('Next: re-open Supabase Security Advisor — the 24 critical');
    console.log('warnings should be cleared. Then handle dashboard-only items:');
    console.log('  • Auth → Providers → Email → Leaked Password Protection');
    console.log('  • Auth → Sessions → Absolute Connection Strategy');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err?.message ?? err);
  process.exit(1);
});
