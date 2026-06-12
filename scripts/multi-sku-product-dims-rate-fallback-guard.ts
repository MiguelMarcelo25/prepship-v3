/**
 * Guard: multi-SKU awaiting orders with complete SKU/product defaults must not
 * be stranded at "Rate unavailable" only because order-level package dims are
 * blank.
 *
 * PS-205 re-anchor (2026-06-12, failing-at-base fix): the original pins
 * required the FRONTEND to fetch every SKU default and derive stacked dims
 * (deriveShipmentDimsFromProductDefaults inline in OrdersView + a per-SKU
 * apiClient.fetchProductsBySku loop). PS-177 (Phase 5, part 3) moved that
 * derivation BACKEND-side (order-dims-defaults / order-dims-defaults-policy →
 * the detail payload's `dimsDefaults` block) and PS-178 deleted the FE loop —
 * so this guard had been failing silently ever since, pinning code that no
 * longer exists. Same intent, new owners:
 *   • the stacking derivation lives in the PURE policy module,
 *   • the panel consumes the backend dimsDefaults payload (no FE fetch loop,
 *     no FE-derived dims policy),
 *   • the by-SKU lookup (products row → complete inventory defaults) lives in
 *     the shared backend resolver,
 *   • PS-205: product-derived dims remain a FALLBACK below explicit combo
 *     defaults in the canonical package-facts precedence.
 */
import { readFileSync } from 'node:fs';

const policy = readFileSync('src/services/order-dims-defaults-policy.ts', 'utf8');
const resolver = readFileSync('src/services/order-dims-defaults.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const factsPolicy = readFileSync('src/services/package-facts-policy.ts', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

check('derived shipment dims helper exists (backend pure policy owner)',
  /export function deriveShipmentDimsFromProductDefaults/.test(policy));
check('derived dims use max item length', /Math\.max\(\.\.\.resolved\.map\(\(item\) => item\.length\)\)/.test(policy));
check('derived dims use max item width', /Math\.max\(\.\.\.resolved\.map\(\(item\) => item\.width\)\)/.test(policy));
check('derived dims stack item height by quantity', /item\.height \* item\.quantity/.test(policy));
check('backend resolves every active SKU default in ONE server-side pass (no FE fetch loop)',
  /uniqueSkus\.map\(async \(sku\) => \(\{ sku, payload: await findProductDefaultsBySku\(sku\) \}\)\)/.test(resolver));
check('panel consumes the backend dimsDefaults payload instead of deriving dims client-side',
  /backendDimsDefaults/.test(ordersView) &&
  /dims\/weight\/package defaults are\s*\n\s*\/\/ BACKEND-owned/.test(ordersView) &&
  !/function deriveShipmentDimsFromProductDefaults/.test(ordersView) &&
  !/fetchProductsBySku\(sku\)/.test(ordersView));
check('products by-sku falls back to complete inventory defaults (shared backend lookup)',
  /export async function findProductDefaultsBySku/.test(resolver) &&
  /\.from\(inventory\)/.test(resolver) &&
  /coalesce\(\$\{inventory\.weightOz\}, 0\) > 0/.test(resolver));
check('PS-205: product-derived dims sit BELOW explicit combo defaults in the canonical precedence',
  /if \(rungHasFacts\(input\.comboDefault\)\) return build\('combo_default', input\.comboDefault\);\s*\n\s*if \(rungHasFacts\(input\.singleSkuDefault\)\)/.test(factsPolicy));

if (failures > 0) {
  console.error(`\nFAIL multi-SKU product dims rate fallback guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS multi-SKU product dims rate fallback guard');
