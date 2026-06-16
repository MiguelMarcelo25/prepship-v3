/**
 * PS-249 (Card 4, slice 2): make storage-fee generation idempotent under concurrency.
 *
 * generateLineItems() deletes the period then regenerates, so SEQUENTIAL runs are already
 * idempotent. The only dup source is two CONCURRENT "Generate Invoices" runs: both insert a
 * storage line, and the existing onConflictDoNothing is a no-op (its target includes order_id,
 * which is NULL for storage rows → Postgres treats NULLs as distinct → no conflict).
 *
 * This adds a PARTIAL UNIQUE INDEX so a concurrent second insert raises a unique violation, which
 * the existing try/catch around the storage insert already swallows (skipped, not duplicated).
 * No billing.ts change is needed — and because creating a unique index FAILS if duplicates already
 * exist, this script DEDUPS first and is DRY-RUN BY DEFAULT (Card 10 gate). Review the dup report,
 * then re-run with --apply.
 *
 *   npx tsx scripts/migrate-billing-storage-unique.ts            # dry run: report dupes only
 *   npx tsx scripts/migrate-billing-storage-unique.ts --apply    # dedup + create the index
 */
import { sql as pg } from '../src/db/client';
import { opsMayMutate } from '../src/lib/ops-confirm';

const apply = opsMayMutate();

async function main(): Promise<void> {
  const dupes = await pg<{ client_id: number; ship_date: string; n: number }[]>`
    select client_id, ship_date, count(*)::int as n
    from billing_line_items
    where order_id is null and line_type = 'storage'
    group by client_id, ship_date
    having count(*) > 1
    order by n desc
  `;

  console.log(`Duplicate storage groups (client_id, ship_date): ${dupes.length}`);
  for (const d of dupes) console.log(`  client ${d.client_id} @ ${d.ship_date}: ${d.n} rows`);

  if (!apply) {
    console.log('\nDRY RUN — no changes made. Re-run with --apply to dedup + create the unique index.');
    return;
  }

  // 1. Dedup: keep the lowest id per (client_id, ship_date) storage group.
  const deleted = await pg`
    delete from billing_line_items a
    using billing_line_items b
    where a.order_id is null and b.order_id is null
      and a.line_type = 'storage' and b.line_type = 'storage'
      and a.client_id = b.client_id and a.ship_date = b.ship_date
      and a.id > b.id
  `;
  console.log(`Deduped ${deleted.count ?? 0} duplicate storage row(s).`);

  // 2. Partial unique index — one storage row per client per billing period.
  await pg`
    create unique index if not exists billing_line_items_storage_unique
    on billing_line_items (client_id, ship_date)
    where order_id is null and line_type = 'storage'
  `;
  console.log('Created billing_line_items_storage_unique. Concurrent storage inserts now no-op safely.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-billing-storage-unique] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
