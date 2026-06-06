/**
 * Guard: eBay no-SKU lines fall back to the item title in the awaiting/shipped
 * SKU grouping (web/src/components/Views/orders-grouping.ts).
 *
 * eBay listings often have no custom SKU. Without a fallback they all collapse
 * into a single "Missing SKU" group and the group header literally reads
 * "Missing SKU". For eBay only (titleFallback: true) the line is identified and
 * labeled by its title, so distinct titles become distinct groups and the
 * header shows the product name. Non-eBay no-SKU lines must still read
 * "Missing SKU" (a data-quality signal). The print-queue surface already does
 * this via PS-070; this guard covers the orders list (awaiting + shipped).
 */
import { buildSkuCompositionKey, groupOrdersBySku } from '../web/src/components/Views/orders-grouping';
import { resolveSkuDisplayLines } from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// 1. No-SKU line WITHOUT titleFallback (non-eBay) keeps the "Missing SKU" flag.
const nonEbay = buildSkuCompositionKey([{ sku: '', name: '2 PACK - Nutricost Yohimbine', quantity: 1 }]);
check('non-eBay no-SKU line still labels "Missing SKU"', nonEbay.label === 'Missing SKU x1' && nonEbay.sku === 'Missing SKU');

// 2. No-SKU line WITH titleFallback (eBay) labels by title, not "Missing SKU".
const ebay = buildSkuCompositionKey([{ sku: '', name: '2 PACK - Nutricost Yohimbine', quantity: 1 }], { titleFallback: true });
check('eBay no-SKU line labels by title', ebay.label === '2 PACK - Nutricost Yohimbine x1' && ebay.sku === '2 PACK - Nutricost Yohimbine');
check('eBay no-SKU line does not say Missing SKU', !ebay.label.toLowerCase().includes('missing sku'));
check('eBay no-SKU line is keyed by title (distinct from __missing_sku__)', ebay.key.startsWith('title:'));

// 3. titleFallback but truly empty (no SKU, no title) → still "Missing SKU".
const empty = buildSkuCompositionKey([{ sku: '', name: '', quantity: 1 }], { titleFallback: true });
check('eBay line with no SKU and no title falls back to Missing SKU', empty.sku === 'Missing SKU');

// 4. A real SKU is always honored, regardless of titleFallback.
const withSku = buildSkuCompositionKey([{ sku: 'ABC-123', name: 'Some Title', quantity: 2 }], { titleFallback: true });
check('present SKU still wins over title', withSku.sku === 'ABC-123' && withSku.label === 'ABC-123 x2');

// 5. End-to-end: two eBay orders with DIFFERENT titles form TWO groups; two with
//    the SAME title collapse into one. Non-eBay no-SKU orders form one group.
type Row = { id: number; ebay: boolean; items: Array<{ sku: string; name: string; quantity: number }> };
const orders: Row[] = [
  { id: 1, ebay: true, items: [{ sku: '', name: 'Yohimbine', quantity: 1 }] },
  { id: 2, ebay: true, items: [{ sku: '', name: 'Vitamin C', quantity: 1 }] },
  { id: 3, ebay: true, items: [{ sku: '', name: 'Yohimbine', quantity: 1 }] },
  { id: 4, ebay: false, items: [{ sku: '', name: 'Walmart Thing', quantity: 1 }] },
];
const groups = groupOrdersBySku(
  orders,
  () => '',
  () => 1,
  (o) => o.items,
  (o) => o.ebay,
);
const labels = groups.map((g) => g.label).sort();
check('two distinct eBay titles → two title-labeled groups', labels.includes('Yohimbine x1') && labels.includes('Vitamin C x1'));
check('same eBay title collapses to one group of 2 orders', (groups.find((g) => g.label === 'Yohimbine x1')?.count ?? 0) === 2);
check('non-eBay no-SKU order stays "Missing SKU"', labels.includes('Missing SKU x1'));

// 6. The visible awaiting table SKU column must also show the title for eBay
// no-SKU items. This is separate from grouping: production showed the item name
// in Item Name while the SKU column still rendered a dash.
const ebaySkuDisplay = resolveSkuDisplayLines(
  [{ sku: '', name: 'Nutricost Vitamin C with Rose Hips 1025mg, 240 Capsules', quantity: 1 }],
  { titleFallback: true },
);
check('eBay table SKU cell falls back to item title', ebaySkuDisplay[0]?.label === 'Nutricost Vitamin C with Rose Hips 1025mg, 240 Capsules');
check('eBay table SKU cell title fallback is marked as fallback', ebaySkuDisplay[0]?.kind === 'title');
const nonEbaySkuDisplay = resolveSkuDisplayLines(
  [{ sku: '', name: 'Should not show for non-eBay', quantity: 1 }],
  { titleFallback: false },
);
check('non-eBay table SKU cell with no SKU stays blank/dash', nonEbaySkuDisplay[0]?.label === null);

if (failures > 0) {
  console.error(`\nFAIL eBay no-SKU title fallback grouping guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS eBay no-SKU title fallback grouping guard');
