/**
 * PS-324 guard — Inventory read-model / source-of-truth cleanup.
 *
 * InventoryView used to OWN two backend-critical facts in the frontend:
 *  1. per-unit cubic feet (a storage-fee BILLING input) — getInventoryCuFt computed
 *     `cuFtOverride ‖ L*W*H/1728`, the exact formula src/services/billing.ts charges on.
 *  2. the out/low/in stock-status THRESHOLD — defined THREE times in the FE
 *     (getInventoryDisplayStatus, the apiClient normalizer's inventoryStatus, and an inline
 *     copy in the Alerts tab).
 *
 * This guard pins the cleanup and fails if the frontend re-acquires either authority:
 *  A. cuFt is owned by src/lib/inventory-cuft.ts (mirroring the billing formula); the
 *     /inventory route stamps it on every row; the FE renders the field.
 *  B. the stock-status threshold is owned by src/lib/inventory-stock-status.ts
 *     (classifyStockStatus, shared with the Dashboard/PS-325); the inventory FE classifiers
 *     DELEGATE to it; the retired inline threshold copies are GONE (anti-vacuous).
 *
 * Offline / static only.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// ── A. cuFt is backend-owned ─────────────────────────────────────────────────────────────
const cuftOwner = read('src/lib/inventory-cuft.ts');
check('cuFt owner exports cuFtPerUnit with the override-or-L*W*H/1728 formula',
  /export function cuFtPerUnit/.test(cuftOwner) &&
  /if \(override > 0\) return override/.test(cuftOwner) &&
  /\(l \* w \* h\) \/ 1728/.test(cuftOwner));

const invRoute = read('src/routes/inventory.ts');
check('/inventory route imports the cuFt owner', /import \{ cuFtPerUnit \} from '\.\.\/lib\/inventory-cuft'/.test(invRoute));
const cuftStamps = (invRoute.match(/cuFt: cuFtPerUnit\(row\.cuFtOverride, row\.length, row\.width, row\.height\)/g) ?? []).length;
check('/inventory route stamps cuFt on BOTH list DTO branches (metric + no-metric)', cuftStamps >= 2, { cuftStamps });

const apiShared = read('web/src/lib/v2-apiClient/shared.ts');
check('apiClient normalizer threads the backend cuFt field through', /cuFt: parseFiniteNumber\(row\.cuFt\)/.test(apiShared));

const parity = read('web/src/components/Views/inventory-parity.ts');
check('FE getInventoryCuFt RENDERS the backend field (item.cuFt) before any fallback',
  /const backendCuFt = Number\(item\.cuFt\)/.test(parity) &&
  /if \(Number\.isFinite\(backendCuFt\)\) return backendCuFt/.test(parity));

// ── B. stock-status threshold is backend-owned; FE delegates ─────────────────────────────
const statusOwner = read('src/lib/inventory-stock-status.ts');
check('stock-status owner exports classifyStockStatus (the single threshold)',
  /export function classifyStockStatus/.test(statusOwner) &&
  /if \(stock <= 0\) return 'out'/.test(statusOwner));

const helpers = read('web/src/components/Views/inventory-stock-helpers.ts');
check('getInventoryDisplayStatus imports + delegates to the canonical classifier',
  /import \{ classifyStockStatus \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/inventory-stock-status'/.test(helpers) &&
  /classifyStockStatus\(getInventoryDisplayStock\(row\), toSortNumber\(row\.minStock\)\)/.test(helpers));
check('anti-vacuous: getInventoryDisplayStatus no longer DEFINES the inline threshold',
  !helpers.includes("if (stock <= 0) return 'out'"));

check('apiClient inventoryStatus imports + delegates to the canonical classifier',
  /import \{ classifyStockStatus \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/inventory-stock-status'/.test(apiShared) &&
  /const status = classifyStockStatus\(stockQty, reorderLevel\)/.test(apiShared));
check('anti-vacuous: inventoryStatus no longer DEFINES the inline threshold',
  !apiShared.includes("if (stockQty <= 0) return 'out'"));

const view = read('web/src/components/Views/InventoryView.tsx');
check('Alerts tab derives the badge from the single status owner (getInventoryDisplayStatus)',
  /const status = getInventoryDisplayStatus\(alert as InventoryItemDto\)/.test(view) &&
  /const isOut = status === 'out'/.test(view) &&
  /const isLow = status === 'low'/.test(view));
check('anti-vacuous: the Alerts tab no longer carries the third inline threshold copy',
  !view.includes('!isOut && minStock > 0 && stock <= minStock'));

if (failures > 0) {
  console.error(`\nPS-324 inventory read-model guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-324 inventory read-model guard passed.');
