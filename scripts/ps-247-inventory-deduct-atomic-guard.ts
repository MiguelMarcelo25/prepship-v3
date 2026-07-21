/**
 * PS-247 (Card 2, slice) — ship-time stock deductions are ATOMIC (no lost-update race).
 *
 * deductInventoryForOrder and PS-413 package-consumption run inside transactions. Inventory is
 * idempotent per order/inventory row; package consumption is idempotent per outbound shipment key.
 * The remaining PS-247 gap was the cross-order CONCURRENCY race:
 * an un-locked SELECT + a pre-computed balanceAfter write meant two simultaneous ship-deductions both
 * read the same start value and one decrement was LOST. PS-439 supersedes the cache with an
 * immutable signed ledger insert, which composes concurrent deductions and keeps negatives visible.
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
const inventoryMovement = readFileSync('src/services/inventory-movement.ts', 'utf8');
const packageConsumption = readFileSync('src/services/package-consumption.ts', 'utf8');

check('inventory deduction is one idempotent canonical ledger insert (race-safe, no read-modify-write)',
  ded.includes('qty: -line.qty') &&
  inventoryMovement.includes('.insert(inventoryLedger)') &&
  inventoryMovement.includes('.onConflictDoNothing()'));
check('inventory no longer writes a pre-read balanceAfter to stockQty',
  !ded.includes('stockQty: balanceAfter'));
check('package deduction is an atomic in-DB decrement',
  packageConsumption.includes('stockQty: sql`${packages.stockQty} - 1`'));
check('package balanceAfter comes from RETURNING (the DB post-decrement value, for the ledger)',
  packageConsumption.includes('.returning({ balanceAfter: packages.stockQty })'));
check('the SAME-order idempotency guard remains (existing ship ledger line -> skip)',
  /eq\(inventoryLedger\.type, 'ship'\)/.test(ded) && /if \(existingShipLine\)/.test(ded));
check('no negative-stock floor on the decrement — negative = intentional backorder (PS-224)',
  !/greatest\(/i.test(ded));
check('deductions stay inside a transaction (atomic with the ledger insert)',
  /return db\.transaction\(async \(tx\) =>/.test(ded) &&
  inventoryMovement.includes('applyInventoryMovementInTransaction') &&
  packageConsumption.includes('conn.transaction((tx) => consumeWithExecutor(input, tx))'));
check('the INVENTORY_AUTO_DEDUCT kill switch is intact (lockdown short-circuit preserved)',
  /isInventoryAutoDeductEnabled\(\)/.test(ded));

check('package.json wires test:ps-247-inventory-deduct-atomic',
  /test:ps-247-inventory-deduct-atomic/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-247 inventory-deduct atomic guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-247 inventory-deduct atomic guard');
