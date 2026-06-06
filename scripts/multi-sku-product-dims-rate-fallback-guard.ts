/**
 * Guard: multi-SKU awaiting orders with complete SKU/product defaults must not
 * be stranded at "Rate unavailable" only because order-level package dims are
 * blank. The Orders panel should fetch all SKU defaults and derive conservative
 * shipment dims for the rate request form.
 */
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const productsRoute = readFileSync('src/routes/products.ts', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const deriveStart = ordersView.indexOf('function deriveShipmentDimsFromProductDefaults');
const deriveEnd = deriveStart >= 0 ? ordersView.indexOf('\n  function assertSavedProductDefaults', deriveStart) : -1;
const deriveBlock = deriveStart >= 0 && deriveEnd > deriveStart ? ordersView.slice(deriveStart, deriveEnd) : '';

const effectMarker = 'const activeItems = getActiveItems(panelOrder, panelDetail).filter((item) => item.sku)';
const effectStart = ordersView.indexOf(effectMarker);
const effectEnd = effectStart >= 0 ? ordersView.indexOf('\n  }, [panelOrderId, panelOrder, panelDetail, locations, packages])', effectStart) : -1;
const effectBlock = effectStart >= 0 && effectEnd > effectStart ? ordersView.slice(effectStart, effectEnd) : '';

check('derived shipment dims helper exists', deriveBlock.length > 0);
check('derived dims use max item length', /Math\.max\(\.\.\.resolved\.map\(\(item\) => item\.length\)\)/.test(deriveBlock));
check('derived dims use max item width', /Math\.max\(\.\.\.resolved\.map\(\(item\) => item\.width\)\)/.test(deriveBlock));
check('derived dims stack item height by quantity', /item\.height \* item\.quantity/.test(deriveBlock));
check('panel hydration fetches every active SKU default', /Promise\.all\([\s\S]*uniqueSkus\.map\([\s\S]*apiClient\.fetchProductsBySku\(sku\)/.test(effectBlock));
check('panel hydration no longer bails out for multi-SKU orders', !/if\s*\(uniqueSkus\.length !== 1\)\s*\{\s*return\s*\}/.test(effectBlock));
check('panel hydration applies derived dims only into blank fields', /derivedDims[\s\S]*nextLength[\s\S]*current\.length \|\| !derivedDims\?\.length/s.test(effectBlock));
check('products by-sku falls back to complete inventory defaults', /complete shipping defaults fallback[\s\S]*\.from\(inventory\)/.test(productsRoute));

if (failures > 0) {
  console.error(`\nFAIL multi-SKU product dims rate fallback guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS multi-SKU product dims rate fallback guard');
