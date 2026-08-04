/**
 * PS-310 / PS-362 - Billing export SKU quantity guard.
 *
 * The invoice exports and Billing detail rows must use the same backend
 * summarizer for SKU quantities. PS-362 makes that string Excel-safe:
 * ASCII "xN" quantity suffixes and newline-separated SKU lines.
 */
import { readFileSync } from 'node:fs';
import { summarizeBillingItemsForDetail } from '../src/services/billing-detail-utils';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const items = [
  { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
  { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
  { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
  { sku: 'ADJ-FEE', name: 'Manual adjustment', quantity: 1, adjustment: true },
];
const summary = summarizeBillingItemsForDetail(items);

check('export SKU string carries xN for a qty>1 SKU',
  summary.itemSkus?.includes('Booster-gel-001 x2') === true);
check('duplicate SKU lines aggregate into one xN entry',
  summary.itemSkus?.includes('HU-10 x2') === true);
check('multi-SKU export string is newline-separated for Excel readability',
  summary.itemSkus?.includes('\nHU-10 x2') === true);
check('adjustment items are excluded from the export SKU string',
  summary.itemSkus?.includes('ADJ-FEE') === false);
check('a qty-1 SKU shows no xN suffix',
  summarizeBillingItemsForDetail([{ sku: 'SOLO-1', name: 'Solo', quantity: 1 }]).itemSkus === 'SOLO-1');
check('empty item_rows -> itemSkus null (export falls back to the bare string_agg)',
  summarizeBillingItemsForDetail([]).itemSkus === null);

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
// d2abef4e hoisted the summarizer call to a local (itemSummary); export still delegates
// SKU strings to it with a bare `?? r.skus` fallback.
// Repointed 2026-08-04. This required `skus:` to be immediately followed by
// `itemSummary.itemSkus ?? r.skus`. A credit-note branch was inserted between
// them -- when the row derives from a source finalization the column shows
// "Original invoice N" instead -- so the ternary broke adjacency while the
// property this check protects is untouched: the non-credit branch is still the
// canonical summarizer with the bare string_agg fallback.
// Match the delegation, not its adjacency to the key.
check('export builds the SKU string via the canonical summarizer with a bare fallback',
  /const itemSummary = summarizeBillingItemsForDetail\(r\.item_rows\)/.test(billingRoute) &&
  /skus:[\s\S]{0,160}?itemSummary\.itemSkus\s*\?\?\s*r\.skus/.test(billingRoute));
check('export fetches per-SKU item_rows (sku + name + quantity, ordered by line_index)',
  /json_build_object\(\s*'sku',\s*oi\.sku,\s*'name',\s*oi\.name,\s*'quantity',\s*oi\.quantity\s*\)/.test(billingRoute) &&
  /\)\s*as item_rows/.test(billingRoute));

if (failures > 0) {
  console.error(`\nPS-310 billing-export SKU-qty guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-310 billing-export SKU-qty guard passed.');
