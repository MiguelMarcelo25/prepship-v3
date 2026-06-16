/**
 * PS-247 (Card 2, slice) — ship-time stock deductions are ATOMIC (no lost-update race).
 *
 * deductInventoryForOrder / deductPackageForShipment run inside a db.transaction and are idempotent
 * per order (the existing-ship-ledger guard). The remaining gap was the cross-order CONCURRENCY race:
 * an un-locked SELECT + a pre-computed balanceAfter write meant two simultaneous ship-deductions both
 * read the same start value and one decrement was LOST. The fix is an atomic in-DB decrement
 * (stock_qty - qty), which composes concurrent deductions under the row lock and keeps negative stock
 * intact (PS-224: negative = intentional backorder, so NO floor).
 *
 *   npx tsx scripts/ps-247-inventory-deduct-atomic-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ded = readFileSync('src/services/fulfillment-deductions.ts', 'utf8');

check('inventory deduction is an atomic in-DB decrement (race-safe, no read-modify-write)',
  ded.includes('stockQty: sql`${inventory.stockQty} - ${line.qty}`'));
check('inventory no longer writes a pre-read balanceAfter to stockQty',
  !ded.includes('stockQty: balanceAfter'));
check('package deduction is an atomic in-DB decrement',
  ded.includes('stockQty: sql`${packages.stockQty} - 1`'));
check('package balanceAfter comes from RETURNING (the DB post-decrement value, for the ledger)',
  ded.includes('.returning({ stockQty: packages.stockQty })'));
check('the SAME-order idempotency guard remains (existing ship ledger line -> skip)',
  /eq\(inventoryLedger\.type, 'ship'\)/.test(ded) && /if \(existingShipLine\)/.test(ded));
check('no negative-stock floor on the decrement — negative = intentional backorder (PS-224)',
  !/greatest\(/i.test(ded));
check('deductions stay inside a transaction (atomic with the ledger insert)',
  /return db\.transaction\(async \(tx\) =>/.test(ded));
check('the INVENTORY_AUTO_DEDUCT kill switch is intact (lockdown short-circuit preserved)',
  /isInventoryAutoDeductEnabled\(\)/.test(ded));

check('package.json wires test:ps-247-inventory-deduct-atomic',
  /test:ps-247-inventory-deduct-atomic/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-247 inventory-deduct atomic guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-247 inventory-deduct atomic guard');
