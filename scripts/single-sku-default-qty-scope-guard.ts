/**
 * Guard: saving a single-SKU weight/dims default only affects orders with the
 * SAME sku + qty.
 *
 * Previously POST /products/save-defaults push-applied the saved box dimensions
 * to EVERY awaiting single-SKU order with that SKU regardless of qty, so saving
 * a 1-pack default overwrote a 2-pack order's (larger) box. The save now carries
 * the source order's qty (appliesToQty) and the push skips orders whose qty
 * differs, so a different qty is never changed.
 */
import { readFileSync } from 'node:fs';

const route = readFileSync('src/routes/products.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Backend accepts the source qty.
check(
  'save-defaults body accepts appliesToQty',
  /appliesToQty: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/.test(route),
);
check(
  'push function takes an appliesToQty scope',
  /appliesToQty\?: number \| null;/.test(route),
);
// The push skips orders whose qty differs from the saving order's qty.
check(
  'push skips orders whose qty != appliesToQty',
  /if \(input\.appliesToQty != null && qty !== input\.appliesToQty\) continue;/.test(route),
);
check(
  'qty scope is wired into the push call',
  /applySingleSkuDefaultsToMatchingMutableOrders\(\{[\s\S]*?appliesToQty: v\.appliesToQty \?\? null,[\s\S]*?\}\)/.test(route),
);
// appliesToQty must not be inserted as a products column.
check(
  'appliesToQty is excluded from the products upsert values',
  /const \{ clientId: inventoryClientId, appliesToQty: _appliesToQty, \.\.\.productValues \} = v;/.test(route),
);

// Frontend sends the source order's qty.
check(
  'savePanelSkuDefaults sends appliesToQty: target.qty',
  /appliesToQty: target\.qty,/.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL single-SKU default qty-scope guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS single-SKU default qty-scope guard');
