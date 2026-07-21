/**
 * PS-325 guard — the Dashboard In/Low/Out-of-Stock snapshot is BACKEND-OWNED.
 *
 * Before PS-325, DashboardView DEFINED the inventory KPIs in React: it aggregated In/Low/Out-of-Stock
 * counts with inline `inventoryRows.filter((item) => ... stock > min ...)` threshold math, making the
 * frontend a silent second source of truth for what "low stock" means.
 *
 * This guard pins the cleanup:
 *  1. src/lib/inventory-stock-status.ts is the single owner of the stock-status thresholds + snapshot.
 *  2. /dashboard/inventory-risk returns that snapshot (both the admin reporting-metrics path and the
 *     live-compute path) instead of leaving the buckets to the FE.
 *  3. DashboardView RENDERS the backend snapshot (preferring it, falling back to the same shared owner
 *     only during deploy skew) and its per-row badge delegates to the canonical classifier.
 *  4. Anti-vacuous: the old FE-owned aggregation (`inventoryRows.filter(... ).length` for the buckets)
 *     is GONE — the component no longer defines the thresholds.
 *
 * Offline/static only.
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

// 1. Canonical backend owner ------------------------------------------------------------------
const owner = read('src/lib/inventory-stock-status.ts');
check('owner exports classifyStockStatus (the single stock-status definition)',
  /export function classifyStockStatus/.test(owner) &&
  /if \(stock <= 0\) return 'out'/.test(owner) &&
  /if \(stock <= minStock\) return 'low'/.test(owner));
check('owner exports summarizeInventorySnapshot (backend computes the In/Low/Out counts)',
  /export function summarizeInventorySnapshot/.test(owner) &&
  /classifyStockStatus\(stock, minStock\)/.test(owner));
check('snapshot carries self-describing provenance (definition + computedAt)',
  /definition:/.test(owner) && /computedAt/.test(owner));

// 2. Backend route returns the snapshot (both paths) ------------------------------------------
const route = read('src/routes/dashboard.ts');
check('inventory-risk route imports the canonical owner',
  /import \{ summarizeInventorySnapshot.*\} from '\.\.\/lib\/inventory-stock-status'/.test(route));
const snapshotReturns = (route.match(/snapshot: summarizeInventorySnapshot\(/g) ?? []).length;
check('inventory-risk returns the snapshot in BOTH the reporting-metrics and live-compute paths',
  snapshotReturns >= 2, { snapshotReturns });

// 3. Dashboard renders the backend snapshot (no FE recompute of the definition) ---------------
const dash = read('web/src/components/Views/DashboardView.tsx');
check('DashboardView imports the shared stock-status owner',
  /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/inventory-stock-status'/.test(dash));
// FE-2 (audit 2.2 slice 1): the snapshot now travels through the
// inventory-risk React Query cache — queryFn passthrough + derived read —
// instead of a useState setter. Same invariant: the backend snapshot is
// kept, not dropped.
check('DashboardView stores the backend snapshot from /dashboard/inventory-risk',
  /snapshot: \(\(inventoryRes\?\.snapshot as InventorySnapshot \| undefined\) \?\? null\)/.test(dash) &&
  /const inventorySnapshot = inventoryRiskQuery\.data\?\.snapshot \?\? null/.test(dash));
check('the inventory KPIs PREFER the backend snapshot, falling back to the shared owner only on skew',
  /const snapshot = inventorySnapshot \?\? summarizeInventorySnapshot\(inventoryRows\)/.test(dash) &&
  /const inStock = snapshot\.inStock/.test(dash) &&
  /const outStock = snapshot\.outOfStock/.test(dash));
check('per-row stock status delegates to the canonical classifier',
  /return classifyStockStatus\(stock, minStock\)/.test(dash));

// 4. Anti-vacuous: the old FE-owned bucket aggregation is gone --------------------------------
check('DashboardView no longer DEFINES the buckets via inline inventoryRows.filter() thresholds',
  !/const inStock = inventoryRows\.filter\(/.test(dash) &&
  !/const outStock = inventoryRows\.filter\(/.test(dash));

if (failures > 0) {
  console.error(`\nPS-325 dashboard inventory snapshot guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-325 dashboard inventory snapshot guard passed.');
