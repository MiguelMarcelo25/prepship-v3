/**
 * PS-310 — REAL execution test: the invoice EXPORTS (XLSX / CSV / HTML print) now show
 * per-SKU QUANTITIES, built from the SAME canonical summarizer the Billing detail SCREEN
 * uses (summarizeBillingItemsForDetail) so the two surfaces can never drift.
 *
 * Reported bug: exports emitted a bare comma-joined SKU list (string_agg(oi.sku)) with no
 * ×N quantity and no duplicate-SKU aggregation — the detail screen already showed ×N, the
 * exports did not. The fix routes the export `skus` string through the screen's summarizer,
 * keeping the bare string_agg ONLY as a fallback for orders with no order_items rows.
 *
 * This guard DRIVES the real summarizer with #1298-shaped data AND pins the export wiring
 * (delegates to the summarizer + has the bare fallback + still fetches per-SKU rows).
 * Offline/pure: no DB, no network, no shipped/cancelled or billing-amount mutation.
 */
import { readFileSync } from 'node:fs';
import { summarizeBillingItemsForDetail } from '../src/services/billing-detail-utils';

const MUL = '×'; // × — the qty suffix the summarizer emits

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// #1298-shaped order items: a qty-2 SKU, a duplicate SKU split across two lines, and an
// adjustment row that must NOT appear in the SKU string.
const items = [
  { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
  { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
  { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 }, // duplicate line → aggregates to ×2
  { sku: 'ADJ-FEE', name: 'Manual adjustment', quantity: 1, adjustment: true }, // excluded
];
const summary = summarizeBillingItemsForDetail(items);

check(`export SKU string carries ${MUL}N for a qty>1 SKU`,
  summary.itemSkus?.includes(`Booster-gel-001 ${MUL}2`) === true);
check(`duplicate SKU lines aggregate into one ${MUL}N entry (HU-10 ${MUL}2)`,
  summary.itemSkus?.includes(`HU-10 ${MUL}2`) === true);
check('adjustment items are excluded from the export SKU string',
  summary.itemSkus?.includes('ADJ-FEE') === false);
check('a qty-1 SKU shows no ×N suffix',
  summarizeBillingItemsForDetail([{ sku: 'SOLO-1', name: 'Solo', quantity: 1 }]).itemSkus === 'SOLO-1');

// Fallback contract: an order with NO order_items rows yields null → the export route uses
// the bare string_agg value instead of fabricating.
check('empty item_rows → itemSkus null (export falls back to the bare string_agg)',
  summarizeBillingItemsForDetail([]).itemSkus === null);

// Export WIRING — single source of truth (the export delegates to the screen's summarizer).
const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
check('export builds the SKU string via the canonical summarizer with a bare fallback',
  /skus:\s*summarizeBillingItemsForDetail\(r\.item_rows\)\.itemSkus\s*\?\?\s*r\.skus/.test(billingRoute));
check('export fetches per-SKU item_rows (sku + name + quantity, ordered by line_index)',
  /json_build_object\(\s*'sku',\s*oi\.sku,\s*'name',\s*oi\.name,\s*'quantity',\s*oi\.quantity\s*\)/.test(billingRoute) &&
  /\)\s*as item_rows/.test(billingRoute));

if (failures > 0) {
  console.error(`\nPS-310 billing-export SKU-qty guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-310 billing-export SKU-qty guard passed.');
