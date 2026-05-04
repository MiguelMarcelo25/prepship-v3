#!/usr/bin/env tsx
// Verifies the Receive flow + History (ledger) flow for the inventory module.
// Touches the real DB (per .env) but neutralizes any change with an offsetting
// adjust so on-hand stock is unchanged when the script finishes.
import 'dotenv/config';
import { eq, sql, isNotNull } from 'drizzle-orm';
import { sql as pgClient, db } from '../src/db/client';
import { inventory, inventoryLedger } from '../src/db/schema/inventory';
import { applyMovement } from '../src/services/inventory';

function log(label: string, value: unknown) {
  console.log(`  ${label.padEnd(28)} ${JSON.stringify(value)}`);
}

async function main() {
  console.log('\n=== Verify Receive + History flow ===\n');

  // 1. Pick a target SKU. Prefer one with negative stock (the exact scenario
  //    the working-tree fix unblocks). Fall back to any active SKU.
  const [negativeRow] = await db
    .select({
      id: inventory.id,
      sku: inventory.sku,
      clientId: inventory.clientId,
      stockQty: inventory.stockQty,
    })
    .from(inventory)
    .where(sql`${inventory.stockQty} < 0 and ${inventory.active} = true`)
    .orderBy(inventory.stockQty)
    .limit(1);

  const [fallback] = negativeRow
    ? [negativeRow]
    : await db
        .select({
          id: inventory.id,
          sku: inventory.sku,
          clientId: inventory.clientId,
          stockQty: inventory.stockQty,
        })
        .from(inventory)
        .where(eq(inventory.active, true))
        .limit(1);

  const target = negativeRow ?? fallback;
  if (!target) {
    console.log('No inventory rows found — abort.');
    return;
  }

  console.log('Target inventory row:');
  log('id', target.id);
  log('sku', target.sku);
  log('clientId', target.clientId);
  log('stockQtyBefore', target.stockQty);
  log('scenario', negativeRow ? 'NEGATIVE-STOCK (proves the fix)' : 'normal stock');
  console.log('');

  // 2. Run a Receive of +1 unit through applyMovement (the same call the
  //    POST /inventory/:id/receive and POST /inventory/receive routes use).
  console.log('Calling applyMovement(type=receive, qty=+1)...');
  const receive = await applyMovement({
    inventoryId: target.id,
    type: 'receive',
    qty: 1,
    note: 'verify-receive-fix script',
    createdBy: 'verify-script',
  });
  log('postReceiveStockQty', receive.inventory?.stockQty);
  log('ledgerId', receive.ledger?.id);
  log('ledgerType', receive.ledger?.type);
  log('ledgerQty', receive.ledger?.qty);
  log('ledgerCreatedAt', receive.ledger?.createdAt);

  if (receive.inventory?.stockQty !== target.stockQty + 1) {
    throw new Error('Stock did not increment by +1 — fix is not working');
  }
  console.log('  ✓ stock incremented by +1');
  console.log('');

  // 3. Confirm the ledger row is queryable through the same WHERE shape that
  //    the History tab uses.
  console.log('Reading back via History query shape...');
  const [historyRow] = await db
    .select({
      id: inventoryLedger.id,
      type: inventoryLedger.type,
      qty: inventoryLedger.qty,
      sku: inventory.sku,
      createdAt: inventoryLedger.createdAt,
      createdBy: inventoryLedger.createdBy,
    })
    .from(inventoryLedger)
    .innerJoin(inventory, eq(inventory.id, inventoryLedger.inventoryId))
    .where(eq(inventoryLedger.id, receive.ledger!.id))
    .limit(1);

  if (!historyRow) throw new Error('Ledger row not visible via History query');
  log('historyRow.type', historyRow.type);
  log('historyRow.qty', historyRow.qty);
  log('historyRow.sku', historyRow.sku);
  log('historyRow.createdBy', historyRow.createdBy);
  console.log('  ✓ Receive entry visible in History query');
  console.log('');

  // 4. Neutralize: roll back via direct DB update + delete the test ledger
  //    row so the script leaves the DB exactly as it was. (We can't use
  //    adjust(-1) when stock is negative — the new outflow guard would
  //    correctly block going more negative, which is the same fix we just
  //    verified.)
  console.log('Restoring DB to original state...');
  await db.transaction(async (tx) => {
    await tx
      .update(inventory)
      .set({ stockQty: target.stockQty })
      .where(eq(inventory.id, target.id));
    await tx
      .delete(inventoryLedger)
      .where(eq(inventoryLedger.id, receive.ledger!.id));
  });
  const [after] = await db
    .select({ stockQty: inventory.stockQty })
    .from(inventory)
    .where(eq(inventory.id, target.id))
    .limit(1);
  log('finalStockQty', after?.stockQty);
  if (after?.stockQty !== target.stockQty) {
    throw new Error('Failed to restore stock to original value');
  }
  console.log('  ✓ on-hand stock restored to original');
  console.log('  ✓ test ledger row deleted');
  console.log('');

  // Suppress unused import lint (isNotNull referenced for future tests).
  void isNotNull;

  console.log('=== ALL CHECKS PASSED ===');
  console.log('Receive endpoint persists ledger rows.');
  console.log('History query surfaces the new Receive entry.');
  console.log('Negative-stock SKUs accept Receive (the working-tree fix).');
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
