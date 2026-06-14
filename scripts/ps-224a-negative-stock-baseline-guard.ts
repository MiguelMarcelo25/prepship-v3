/**
 * PS-224a guard — auto-deduct never writes a negative cached stock.
 *
 * Per user override unlock shipped data on 2026-06-13. The auto-deduct path used to
 * write stock_qty = current - qty with NO floor, so a SKU shipped before it was ever
 * received went negative (row auto-created at 0, then 0 - qty). Both deduction sites
 * now floor the CACHE at 0 while the ledger 'ship' row still records the true -qty,
 * so the canonical ledger-based effective-stock is unchanged. This guard pins both
 * floors + the preserved ledger truth, and that the locked-file edit cites the override.
 *
 *   npx tsx scripts/ps-224a-negative-stock-baseline-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
const src = (() => { try { return readFileSync('src/services/fulfillment-deductions.ts', 'utf8'); } catch { return ''; } })();
const pkg = (() => { try { return readFileSync('package.json', 'utf8'); } catch { return ''; } })();

// 1. Inventory deduction floors the cache at 0.
check('inventory deduction floors cache at 0',
  /const balanceAfter = Math\.max\(0, row\.stockQty - line\.qty\)/.test(src));

// 2. Package deduction floors the cache at 0.
check('package deduction floors cache at 0',
  /const balanceAfter = Math\.max\(0, pkg\.stockQty - 1\)/.test(src));

// 3. The ledger still records the TRUE -qty (truth preserved for effective-stock).
check('inventory ledger still records the true -qty', /qty:\s*-line\.qty/.test(src));
check('package ledger still records the true -1 delta', /qtyDelta:\s*-1/.test(src));

// 4. No remaining un-floored negative write (defensive: the bare `row.stockQty - line.qty`
//    without Math.max must not be assigned straight into the patch).
check('no un-floored stock write remains',
  !/stockQty:\s*row\.stockQty - line\.qty/.test(src));

// 5. Locked-file edit cites the override.
check('locked-file edit cites the unlock override',
  src.includes('PS-224a') && src.includes('unlock shipped data on 2026-06-13'));

// 6. Kill-switch still governs both paths (not weakened).
check('INVENTORY_AUTO_DEDUCT kill-switch intact',
  src.includes('isInventoryAutoDeductEnabled') && /reason:\s*'lockdown'/.test(src));

check('package.json wires test:ps-224a-negative-stock-baseline',
  /test:ps-224a-negative-stock-baseline/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-224a negative-stock baseline guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-224a negative-stock baseline guard');
