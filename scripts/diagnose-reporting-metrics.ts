/**
 * Read-only diagnosis: why is billing_summary_metrics empty in production?
 *
 * THE OBSERVATION
 *
 * The PS-501 / 0095 operator-lane inspect reported `cached rows: 0` against production.
 * billing_summary_metrics is the cached answer behind the Billing dashboard, so zero rows
 * means /billing/summary has been taking the live query on every request. Nothing is
 * visibly broken — which is exactly why it could sit unnoticed.
 *
 * THE HYPOTHESIS THIS TESTS
 *
 * Both callers of refreshBillingSummaryMetrics wrap it in try/catch and report
 * `billing.summary_metrics.refresh_failed` without failing the request (billing.ts:2300).
 * So a PERSISTENT refresh failure looks precisely like this: table present, zero rows, no
 * user-visible breakage.
 *
 * The likeliest thrower is ensureReportingMetricsTables(), which requires FIVE tables and
 * throws naming drizzle/0029_reporting_metrics.sql if any is missing. The 0095 inspect only
 * proved billing_summary_metrics exists; the other four were never checked.
 *
 * withRefreshRun() writes a row to reporting_refresh_runs at the START of each refresh and
 * updates it with status + error text, so that table is a built-in audit trail:
 *   - failure rows        -> the `error` column names the cause outright
 *   - table EMPTY         -> the refresh never started, i.e. ensureTables threw first
 *
 * READ-ONLY BY CONSTRUCTION
 *
 * There is no --apply mode and no write path. The session is additionally pinned
 * READ ONLY at the server, so this cannot write even if this file were later edited to
 * try. A diagnostic that could mutate the thing it is diagnosing is not a diagnostic.
 *
 *   npx tsx scripts/diagnose-reporting-metrics.ts
 */
import postgres from 'postgres';

const REQUIRED_TABLES = [
  'reporting_refresh_runs',
  'daily_sales_metrics',
  'sku_velocity_metrics',
  'inventory_risk_metrics',
  'billing_summary_metrics',
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. This runner is for the operator lane.');

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // Belt and braces: the server itself refuses writes for this session.
    await sql.unsafe('set session characteristics as transaction read only');
    console.log(`target host : ${new URL(databaseUrl).hostname}`);
    console.log('mode        : READ ONLY (session pinned; no write path exists)\n');

    // ── 1. Do the five tables ensureTables() demands actually exist? ──────────
    console.log('== required reporting tables ==');
    const present = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any(${REQUIRED_TABLES as unknown as string[]})`;
    const found = new Set(present.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
    for (const t of REQUIRED_TABLES) console.log(`  ${found.has(t) ? 'present' : 'MISSING'}  ${t}`);

    if (missing.length) {
      console.log(
        `\n  >> CAUSE FOUND: ensureReportingMetricsTables() throws while ${missing.join(', ')} ` +
          'is absent, so EVERY refresh dies before doing work and both call sites swallow it ' +
          'into a logged billing.summary_metrics.refresh_failed. Fix is to apply ' +
          'drizzle/0029_reporting_metrics.sql through an operator lane.',
      );
    }

    // ── 2. Row counts, so "empty" is measured rather than assumed ─────────────
    console.log('\n== row counts ==');
    for (const table of REQUIRED_TABLES) {
      if (!found.has(table)) { console.log(`  (skipped) ${table}`); continue; }
      const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
      console.log(`  ${String(row?.n ?? 0).padStart(8)}  ${table}`);
    }

    // ── 3. The audit trail — the decisive evidence ────────────────────────────
    console.log('\n== reporting_refresh_runs (most recent 20) ==');
    if (!found.has('reporting_refresh_runs')) {
      console.log('  table absent — see above; this IS the likely cause');
    } else {
      const runs = await sql<{
        scope: string; status: string; started_at: Date | null; duration_ms: number | null;
        rows_affected: number | null; error: string | null;
      }[]>`
        select scope, status, started_at, duration_ms, rows_affected, error
        from reporting_refresh_runs order by started_at desc limit 20`;
      if (runs.length === 0) {
        console.log('  EMPTY — no refresh has ever STARTED.');
        console.log('  withRefreshRun() inserts a row before doing any work, so an empty table');
        console.log('  means execution never reached it: ensureReportingMetricsTables() threw');
        console.log('  first, or no caller ever fired.');
      } else {
        for (const r of runs) {
          const when = r.started_at ? new Date(r.started_at).toISOString() : '(no start)';
          console.log(`  ${when}  ${r.scope.padEnd(16)} ${r.status.padEnd(8)} rows=${r.rows_affected ?? '-'} ${r.duration_ms ?? '-'}ms`);
          if (r.error) console.log(`      error: ${r.error.slice(0, 300)}`);
        }
        const failures = runs.filter((r) => r.status === 'failure');
        if (failures.length) {
          console.log(`\n  >> ${failures.length} of the last ${runs.length} runs FAILED. The error text above is the cause.`);
        } else if (found.has('billing_summary_metrics')) {
          console.log('\n  >> Runs are succeeding. If billing_summary_metrics is still empty, the refresh');
          console.log('     is completing without writing rows — check the upsert predicate and whether');
          console.log('     any client passes the active/system-client filter for the period.');
        }
      }
    }

    // ── 4. Is there anything to summarise at all? ─────────────────────────────
    console.log('\n== is there billing data to cache? ==');
    const [lines] = await sql<{ n: number }[]>`select count(*)::int as n from billing_line_items`;
    console.log(`  billing_line_items rows: ${lines?.n ?? 0}`);
    if ((lines?.n ?? 0) === 0) {
      console.log('  >> No billing lines at all, so the lazy refresh path is gated off by');
      console.log('     hasLineItems() and an empty cache would be CORRECT, not a fault.');
    }

    // ── 5. Did PS-501's column land? ──────────────────────────────────────────
    if (found.has('billing_summary_metrics')) {
      const [col] = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'billing_summary_metrics'
          and column_name = 'return_total'`;
      console.log(`\n== PS-501 ==\n  billing_summary_metrics.return_total present: ${col?.n === 1}`);
    }

    console.log('\nDiagnosis complete. Nothing was written.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
