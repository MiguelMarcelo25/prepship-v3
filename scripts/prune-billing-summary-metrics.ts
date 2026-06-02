/**
 * Prune the billing_summary_metrics cache: remove orphaned (no active/non-system
 * client) and stale (not refreshed within retention) windows. The cache rebuilds
 * any range on demand (refresh-on-read), so this only tidies derived data and
 * never touches billing_line_items.
 *
 *   npx tsx scripts/prune-billing-summary-metrics.ts              # dry-run (default)
 *   npx tsx scripts/prune-billing-summary-metrics.ts --apply      # actually delete
 *   npx tsx scripts/prune-billing-summary-metrics.ts --apply --days 30
 */
import { sql } from '../src/db/client';
import { pruneBillingSummaryMetrics } from '../src/services/reporting-metrics';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const days = Number.parseInt(argValue('--days') ?? '', 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : 45;

  const [{ before }] = await sql<Array<{ before: string }>>`
    select count(*)::text as before from public.billing_summary_metrics
  `;
  console.log(`billing_summary_metrics rows before: ${before}`);
  console.log(`mode: ${apply ? 'APPLY (deleting)' : 'DRY-RUN (no changes)'}  retentionDays: ${retentionDays}`);

  const result = await pruneBillingSummaryMetrics({ retentionDays, dryRun: !apply });
  console.log(`  orphaned (no active/non-system client): ${result.orphaned}`);
  console.log(`  stale (> ${retentionDays}d since refresh)  : ${result.stale}`);
  console.log(`  ${apply ? 'deleted' : 'would delete'} (distinct orphaned OR stale): ${apply ? result.deleted : result.candidates}`);

  if (apply) {
    const [{ after }] = await sql<Array<{ after: string }>>`
      select count(*)::text as after from public.billing_summary_metrics
    `;
    console.log(`billing_summary_metrics rows after : ${after}`);
  } else {
    console.log('\nDry-run only. Re-run with --apply to delete.');
  }

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('prune-billing-summary-metrics failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
