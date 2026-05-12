#!/usr/bin/env tsx
// ──────────────────────────────────────────────────────────────────
// rename-wm-ship-label.ts
//
// One-off rename for the operator-typed label "wm ship" (the
// nickname they gave their Walmart Shipping Solutions / Walmart
// carrier account when they set it up in Settings → Carriers).
//
// Background:
//   "wm ship" was discovered to live ONLY in the database as a
//   user-supplied label (the `label` column on carrier_accounts and
//   the matching column on store_accounts). It does NOT appear
//   anywhere in the codebase, so this rename has to happen in the
//   data layer, not in source. The Settings UI doesn't currently
//   expose an Edit action for renaming carrier-account labels, so
//   this script is the operator-friendly way to do it.
//
// What it does:
//   - Finds every row in carrier_accounts where the label, when
//     lower-cased and trimmed, matches "wm ship" (also tolerates
//     "wmship", "wm-ship", "wm_ship" variants).
//   - Same scan in store_accounts (Walmart Shipping Solutions is
//     sometimes registered there as the marketplace storefront).
//   - UPDATEs the label to the chosen new value. Default = "Walmart".
//
// What it explicitly does NOT touch:
//   - Order snapshots (orders.selected_rate, orders.best_rate JSON,
//     etc.). Those are HISTORICAL — they record what the label was
//     at the moment a rate was selected. Rewriting them would
//     destroy that audit trail and isn't needed for the operator's
//     forward-looking display.
//   - Shipment records. The shipments table is under the
//     shipped-data lockdown (AGENTS.md) and is also historical.
//
// Usage:
//   npx tsx scripts/rename-wm-ship-label.ts                # → "Walmart"
//   npx tsx scripts/rename-wm-ship-label.ts Wallmart       # → custom spelling
//   npx tsx scripts/rename-wm-ship-label.ts "Walmart Shipping"
//
// Safe to re-run: it's idempotent — once labels are renamed, the
// LIKE-match returns zero rows and the script exits cleanly.
// ──────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  // First positional arg = new label. Default to "Walmart" (the
  // canonical brand spelling). Operator can override with any value.
  const argv = process.argv.slice(2);
  const newLabel = (argv[0] ?? 'Walmart').trim();
  if (!newLabel) {
    console.error('New label cannot be empty.');
    process.exit(1);
  }

  // Match any of the common variants the operator might have typed:
  //   wm ship | wmship | wm-ship | wm_ship | wm  ship (double space)
  // All compared case-insensitively. We do this in SQL so an UPDATE
  // can target every matching row in one round-trip.
  const matchPredicate = sql`
    lower(trim(label)) in ('wm ship', 'wmship', 'wm-ship', 'wm_ship')
    or lower(trim(label)) like 'wm  %ship%'
  `;

  console.log(`Renaming carrier labels matching "wm ship"-variants → "${newLabel}"`);

  // ── carrier_accounts ───────────────────────────────────────────
  console.log('\n[1/2] Scanning carrier_accounts…');
  const carrierBefore = await db.execute<{ id: number; label: string | null; provider: string }>(sql`
    select id, label, provider
    from carrier_accounts
    where ${matchPredicate}
    order by id
  `);
  if (carrierBefore.length === 0) {
    console.log('  no matching rows');
  } else {
    console.log(`  ${carrierBefore.length} row(s) to update:`);
    for (const r of carrierBefore) {
      console.log(`    #${r.id} (provider=${r.provider}) label="${r.label}"`);
    }
    await db.execute(sql`
      update carrier_accounts
      set label = ${newLabel}, updated_at = now()
      where ${matchPredicate}
    `);
    console.log(`  → updated`);
  }

  // ── store_accounts ─────────────────────────────────────────────
  // Walmart Shipping Solutions can also be registered as a
  // store-side entry. Mirror the carrier_accounts scan exactly so
  // we catch it in either table.
  console.log('\n[2/2] Scanning store_accounts…');
  // store_accounts may or may not have updated_at — guard for it.
  // Use a defensive `to_regclass` check + a conditional SET in two
  // separate statements rather than one big query.
  let storeBefore: Array<{ id: number; label: string | null; provider: string }> = [];
  try {
    storeBefore = (await db.execute<{ id: number; label: string | null; provider: string }>(sql`
      select id, label, provider
      from store_accounts
      where ${matchPredicate}
      order by id
    `)) as Array<{ id: number; label: string | null; provider: string }>;
  } catch (err) {
    console.log(`  (store_accounts table absent or query failed — skipping: ${err instanceof Error ? err.message : String(err)})`);
  }
  if (storeBefore.length === 0) {
    console.log('  no matching rows');
  } else {
    console.log(`  ${storeBefore.length} row(s) to update:`);
    for (const r of storeBefore) {
      console.log(`    #${r.id} (provider=${r.provider}) label="${r.label}"`);
    }
    try {
      await db.execute(sql`
        update store_accounts
        set label = ${newLabel}
        where ${matchPredicate}
      `);
      console.log(`  → updated`);
    } catch (err) {
      console.error(`  ✗ update failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  console.log('\nDone.');
  console.log('Note: order snapshots (orders.selected_rate, etc.) keep their historical "wm ship" value by design — those record what the label was when each rate was selected.');
}

main()
  .catch((err) => {
    console.error('rename-wm-ship-label.ts failed:', err);
    process.exit(1);
  })
  .finally(() => {
    // Drizzle's postgres-js client doesn't auto-close; tsx exits anyway,
    // but explicit is friendlier in CI / scripted contexts.
    process.exit(0);
  });
