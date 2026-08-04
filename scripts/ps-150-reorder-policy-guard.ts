/**
 * PS-150 — reorder policy owner guard.
 *
 * Pins the canonical velocity reorder model (src/lib/inventory-reorder-policy) and proves BOTH layers
 * delegate to it instead of hand-rolling the math:
 *   (1) computeReorderPolicy returns the exact velocity-model numbers (fixture parity).
 *   (2) DashboardView imports it, calls it, and no longer inlines dailyRate/targetStock/restock math.
 *   (3) the dashboard /inventory-risk route imports it and no longer inlines the par-level restock.
 *
 * Pure logic + static source checks — no DB, no network.
 *   npx tsx scripts/ps-150-reorder-policy-guard.ts
 */
import { readFileSync } from 'node:fs';
import { computeReorderPolicy } from '../src/lib/inventory-reorder-policy';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function checkBool(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); } else { console.log(`ok   ${name}`); }
}

// ── 1) Velocity-model fixture parity (pins the formula DJ chose 2026-06-10) ──
check('30u/30d, stock 10, min 5 → daily 1, days 10, target 14, restock 4',
  computeReorderPolicy({ units30: 30, stock: 10, minStock: 5 }),
  { velocityPerDay: 1, daysSupply: 10, targetStock: 14, restockQty: 4 });
check('no sales → velocity 0, daysSupply null, target = minStock, restock 0',
  computeReorderPolicy({ units30: 0, stock: 10, minStock: 5 }),
  { velocityPerDay: 0, daysSupply: null, targetStock: 5, restockQty: 0 });
check('fast mover, 0 stock → restock = ceil(14×daily)',
  computeReorderPolicy({ units30: 60, stock: 0, minStock: 0 }),
  { velocityPerDay: 2, daysSupply: 0, targetStock: 28, restockQty: 28 });
check('min floor wins over velocity target',
  computeReorderPolicy({ units30: 15, stock: 7, minStock: 20 }),
  { velocityPerDay: 0.5, daysSupply: 14, targetStock: 20, restockQty: 13 });
check('fractional velocity → restock is ceil()',
  computeReorderPolicy({ units30: 10, stock: 3, minStock: 0 }).restockQty, 2);

// ── 2) DashboardView delegates (no inline reorder math) ──
const dashboardView = readFileSync('web/src/components/Views/DashboardView.tsx', 'utf8');
// Inverted 2026-08-04. These required DashboardView to import
// '../../../../src/lib/inventory-reorder-policy' and call it -- the frontend
// reaching four levels up out of web/ into backend src/ to run a policy itself.
// PS-325 moved every dashboard metric to a backend read model and PS-464's
// boundary law forbids that import outright, so both assertions were demanding
// an architecture violation the repo has since removed.
//
// Second guard in two batches found requiring the frontend to own a backend
// computation, after ps-166's rate builders. The delegation is still pinned --
// harder than before, because "does not compute" is a stronger property than
// "imports the shared helper": a view that cannot reach the policy cannot drift
// from it either.
checkBool('DashboardView does not reach into backend src/ for the reorder policy',
  !/from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/inventory-reorder-policy'/.test(dashboardView));
checkBool('DashboardView never computes reorder policy itself (backend DTO only)',
  !/computeReorderPolicy\(/.test(dashboardView));
checkBool('DashboardView no longer inlines the velocity dailyRate math',
  !/const dailyRate = units30 > 0 \? units30 \/ 30/.test(dashboardView));
checkBool('DashboardView no longer inlines the restock = ceil(targetStock - stock) math',
  !/Math\.max\(0, Math\.ceil\(targetStock - stock\)\)/.test(dashboardView));

// ── 3) dashboard /inventory-risk route delegates (no inline par-level restock) ──
const dashboardRoute = readFileSync('src/routes/dashboard.ts', 'utf8');
checkBool('dashboard route imports the canonical reorder policy owner',
  /import \{ computeReorderPolicy \} from '\.\.\/lib\/inventory-reorder-policy'/.test(dashboardRoute));
// Repointed 2026-08-04: `stock: stockQty` became `stock: inventoryQuantity` when
// PS-462 replaced the split balances with one canonical ledger quantity. The
// delegation is unchanged; the variable it reads from is the point of that
// ticket. Pin the call and its keys, not the local that supplies stock.
checkBool('dashboard route delegates to computeReorderPolicy for the inventory-risk DTO',
  /computeReorderPolicy\(\{ units30: soldLast30Days, stock: \w+, minStock: reorderLevel \}\)/.test(dashboardRoute));
checkBool('dashboard route no longer inlines the par-level restock (reorderLevel - stockQty)',
  !/restockQty: Math\.max\(0, reorderLevel - stockQty\)/.test(dashboardRoute));

if (failures > 0) {
  console.error(`\nFAIL PS-150 reorder policy guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-150 reorder policy guard');
