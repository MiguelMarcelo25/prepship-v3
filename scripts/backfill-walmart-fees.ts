#!/usr/bin/env tsx
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// scripts/backfill-walmart-fees.ts
//
// One-off operator-runnable backfill: pull Walmart selling fees for
// every active Walmart store_account over a configurable lookback
// window (default 90 days). Powers the initial seeding of the new
// orders.selling_fee column so the Analysis page's Profit data has
// history immediately, without waiting for the nightly cron's
// 14-day window to catch up over many days.
//
// Uses the same shared helper as the user-triggered "Pull Fees"
// button and the nightly cron â€” api/_lib/walmart-fees-sync.ts â€”
// so the three paths can never drift apart on the data they write.
//
// Usage:
//   npx tsx scripts/backfill-walmart-fees.ts                       # 90 days, all accounts
//   npx tsx scripts/backfill-walmart-fees.ts --days 180             # 180 days, all accounts
//   npx tsx scripts/backfill-walmart-fees.ts --store-account-id 5   # 90 days, one account
//   npx tsx scripts/backfill-walmart-fees.ts --days 30 --store-account-id 5
//
// Safe to re-run: the UPDATE inside the helper is idempotent â€”
// running the same window twice produces the same selling_fee
// values. Fees only change when Walmart issues a retro adjustment,
// which the cron's 14-day rolling window also catches.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import 'dotenv/config';
import postgres from 'postgres';
import {
  syncWalmartFeesAllAccounts,
  syncWalmartFeesForAccount,
  type WalmartFeesSyncOutcome,
} from '../src/connectors/store/walmart-fees';

function parseArgs(): { days: number; storeAccountId: number | null } {
  const argv = process.argv.slice(2);
  let days = 90;
  let storeAccountId: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days' || arg === '-d') {
      const next = argv[i + 1];
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        days = Math.min(n, 365);
        i += 1;
      } else {
        console.error(`--days expects a positive number, got "${next}"`);
        process.exit(1);
      }
    } else if (arg === '--store-account-id') {
      const next = argv[i + 1];
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        storeAccountId = n;
        i += 1;
      } else {
        console.error(`--store-account-id expects a positive integer, got "${next}"`);
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  npx tsx scripts/backfill-walmart-fees.ts [--days N] [--store-account-id ID]

Options:
  --days N                  Number of days to back-fill (default 90, max 365)
  --store-account-id ID     Run for a single store_account only (default: all active Walmart accounts)
  --help, -h                Show this help`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return { days, storeAccountId };
}

function formatResult(label: string, r: WalmartFeesSyncOutcome): string {
  if (!r.ok) return `  âœ— ${label}: ${r.error}`;
  const note = r.note ? ` Â· ${r.note}` : '';
  return `  âœ“ ${label}: ${r.fetched} transactions Â· ${r.ordersUpdated} orders updated Â· $${r.totalFeesUsd.toFixed(2)} fees${
    r.ordersMissing > 0 ? ` Â· ${r.ordersMissing} unmatched` : ''
  }${note}`;
}

async function main() {
  const { days, storeAccountId } = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is not set (load via .env or shell export before running).');
    process.exit(1);
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  console.log('Walmart fees backfill');
  console.log(`  window: ${fromDate} â†’ ${toDate} (${days} days)`);
  console.log(`  scope:  ${storeAccountId ? `store_account #${storeAccountId}` : 'all active Walmart accounts'}`);
  console.log('');

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  try {
    if (storeAccountId != null) {
      const r = await syncWalmartFeesForAccount(sql, storeAccountId, fromDate, toDate);
      console.log(formatResult(`store_account #${storeAccountId}`, r));
    } else {
      const results = await syncWalmartFeesAllAccounts(sql, fromDate, toDate);
      if (results.length === 0) {
        console.log('  (no active Walmart store_accounts found)');
      } else {
        for (const r of results) {
          const label = r.storeAccountLabel
            ? `store_account #${r.storeAccountId} "${r.storeAccountLabel}"`
            : `store_account #${r.storeAccountId}`;
          console.log(formatResult(label, r));
        }
        const totalFetched = results.reduce((acc, r) => acc + (r.ok ? r.fetched : 0), 0);
        const totalUpdated = results.reduce((acc, r) => acc + (r.ok ? r.ordersUpdated : 0), 0);
        const totalFees = results.reduce((acc, r) => acc + (r.ok ? r.totalFeesUsd : 0), 0);
        console.log('');
        console.log(`Totals: ${totalFetched} transactions Â· ${totalUpdated} orders updated Â· $${totalFees.toFixed(2)} fees across ${results.length} accounts`);
      }
    }
    console.log('\nDone.');
  } catch (err) {
    console.error('backfill-walmart-fees.ts failed:', err);
    process.exit(1);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
