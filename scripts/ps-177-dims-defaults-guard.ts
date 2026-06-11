/**
 * PS-177 (Phase 5, part 3) guard — shipment dims/package DEFAULTS are
 * backend-owned.
 *
 * THE GAP: opening the shipment panel ran an N-per-panel /products/by-sku
 * fetch loop and derived the stacked parcel dims CLIENT-SIDE
 * (deriveShipmentDimsFromProductDefaults in OrdersView) — a rate-affecting
 * default policy living in the frontend.
 *
 * THE FIX: pure order-dims-defaults-policy.ts owns the stacking derivation
 * (exact FE parity); order-dims-defaults.ts resolves the per-SKU defaults
 * (products row first, Inventory completeness/global/recency fallback — the
 * SAME rule /products/by-sku now delegates to) and attaches `dimsDefaults` to
 * both order detail handlers; the FE seeds the panel from the payload and
 * keeps its fetch loop ONLY as the deploy-skew fallback (Phase 6 deletes).
 *
 *   npx tsx scripts/ps-177-dims-defaults-guard.ts
 */
import { readFileSync } from 'node:fs';
import { deriveShipmentDimsFromProductDefaults } from '../src/services/order-dims-defaults-policy';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const DEFAULTS = new Map<string, Record<string, unknown>>([
  ['booster-gel-001', { length: 6, width: 4, height: 2 }],
  ['hu-10', { length: 10, width: 3, height: 1.5 }],
  ['stringy', { length: '8.5', width: '5', height: '0.75' }],
  ['incomplete', { length: 6, width: 4 }],
]);

// ── behavioral parity matrix (FE deriveShipmentDimsFromProductDefaults) ───────
check('single line → that product\'s dims',
  JSON.stringify(deriveShipmentDimsFromProductDefaults([{ sku: 'Booster-gel-001', quantity: 1 }], DEFAULTS)) ===
  JSON.stringify({ length: 6, width: 4, height: 2 }));
check('multi-SKU → footprint max L/W, stacked height',
  JSON.stringify(deriveShipmentDimsFromProductDefaults(
    [{ sku: 'booster-gel-001', quantity: 1 }, { sku: 'hu-10', quantity: 1 }], DEFAULTS,
  )) === JSON.stringify({ length: 10, width: 4, height: 3.5 }));
check('quantity multiplies the stacked height',
  deriveShipmentDimsFromProductDefaults([{ sku: 'booster-gel-001', quantity: 3 }], DEFAULTS)?.height === 6);
check('ANY line without complete defaults → null (no partial guess)',
  deriveShipmentDimsFromProductDefaults(
    [{ sku: 'booster-gel-001', quantity: 1 }, { sku: 'incomplete', quantity: 1 }], DEFAULTS,
  ) === null &&
  deriveShipmentDimsFromProductDefaults(
    [{ sku: 'booster-gel-001', quantity: 1 }, { sku: 'unknown-sku', quantity: 1 }], DEFAULTS,
  ) === null);
check('numeric-string defaults parse (drizzle numeric columns)',
  JSON.stringify(deriveShipmentDimsFromProductDefaults([{ sku: 'STRINGY', quantity: 2 }], DEFAULTS)) ===
  JSON.stringify({ length: 8.5, width: 5, height: 1.5 }));
check('no lines → null', deriveShipmentDimsFromProductDefaults([], DEFAULTS) === null);
check('2dp rounding on the stacked height',
  deriveShipmentDimsFromProductDefaults([{ sku: 'stringy', quantity: 3 }], DEFAULTS)?.height === 2.25);

// ── wiring pins ───────────────────────────────────────────────────────────────
const dimsService = readFileSync('src/services/order-dims-defaults.ts', 'utf8');
check('service: single-SKU-only weight/package rule (multi-SKU never guesses)',
  /uniqueSkus\.length === 1 \? defaultsBySku\.get/.test(dimsService));
check('service: inventory fallback keeps completeness → global → recency ordering',
  /coalesce\(\$\{inventory\.weightOz\}, 0\) > 0/.test(dimsService) &&
  /case when \$\{inventory\.clientId\} is null then 0 else 1 end/.test(dimsService));
check('service: best-effort (returns null on failure, never breaks the detail payload)',
  /\[order-dims-defaults\] resolution skipped/.test(dimsService));
check('service: read-only (no db.update/insert/delete)',
  !/db\.(update|insert|delete)\(/.test(dimsService));
const productsRoute = readFileSync('src/routes/products.ts', 'utf8');
check('/products/by-sku delegates to the shared lookup (one rule)',
  /return c\.json\(await findProductDefaultsBySku\(sku\)\)/.test(productsRoute));
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('both detail handlers attach dimsDefaults',
  (ordersRoute.match(/dimsDefaults: await getOrderDimsDefaultsForOrder\(id\)/g)?.length ?? 0) === 2);
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('FE panel seeds from the backend payload first',
  /backendDimsDefaults/.test(ordersView) && /if \(seedFromBackendDefaults\(\)\) return/.test(ordersView));
check('FE fetch-loop fallback retained until Phase 6',
  /apiClient\.fetchProductsBySku\(sku\)/.test(ordersView) &&
  /deriveShipmentDimsFromProductDefaults\(activeItems, defaultsBySku\)/.test(ordersView));
check('FE seeding still only fills EMPTY fields (operator edits win)',
  /current\.length \|\| !derivedDims\?\.length \? current\.length/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-177 dims defaults guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-177 dims defaults guard');
