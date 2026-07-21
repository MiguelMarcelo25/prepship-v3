/**
 * Comprehensive test-data cleanup. Goes BEYOND the existing
 * /admin/purge-test-orders endpoint (which only purges orders,
 * shipments, inventory_ledger entries, and billing line items).
 * This script ALSO purges:
 *   - inventory rows whose client_id belongs to a test client
 *     (the test SKUs themselves — TEST-SKU-001 / TEST-SKU-002 /
 *     TESTING-KIT / TEST-PACK)
 *   - print_queue_orders entries belonging to test clients or
 *     test orders (queue entries pointing at orders we just deleted)
 *   - order_overrides for test orders (cascade FK handles this on
 *     orders DELETE, but we delete explicitly first to make the
 *     summary count visible)
 *
 * NOT touched: packages + package_ledger. The packages table has
 * no client_id (packages are global, not per-client). The package
 * ledger does reference orders only via free-text "note" (e.g.
 * "Shipment 5735135 for order TESTING-MORV1TLT-067") — string
 * matching to delete those is fragile and might catch real-order
 * entries by accident. If the user wants the package ledger
 * cleaned too, they can re-count the negative-balance packages
 * manually via Inventory > Packages > the per-package adjust UI.
 *
 * USAGE
 * ─────
 * Dry-run (no deletes — just shows what would be deleted):
 *   tsx scripts/purge-test-data.ts --dry-run
 *
 * Live run:
 *   tsx scripts/purge-test-data.ts
 *
 * SAFETY
 * ──────
 * - Only acts on rows whose client_id is in clients.is_test=true
 * - Idempotent: re-running on already-clean state finds 0 rows
 * - Order of deletion respects FK constraints (children first)
 * - Wraps all deletes in a single transaction so a mid-run failure
 *   rolls back the whole thing
 *
 * Per user override `unlock shipped data` on 2026-05-07.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { clients } from '../src/db/schema/clients';
import { orders } from '../src/db/schema/orders';
import { orderOverrides } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { inventory, inventoryLedger } from '../src/db/schema/inventory';
import { billingLineItems } from '../src/db/schema/billing';
import { printQueue } from '../src/db/schema/print-queue';

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(isDryRun ? '🧪 DRY RUN — no deletes will happen' : '⚠️  LIVE RUN — rows will be deleted');
  console.log('');

  // 1. Find all test clients
  const testClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.isTest, true));

  if (testClients.length === 0) {
    console.log('No clients flagged is_test=true. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${testClients.length} test client(s):`);
  for (const c of testClients) console.log(`  - id=${c.id} name="${c.name}"`);
  console.log('');

  const testClientIds = testClients.map((c) => c.id);

  // 2. Find all order IDs belonging to those clients
  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.clientId, testClientIds));
  const testOrderIds = orderRows.map((r) => r.id);

  // 3. Find all inventory IDs belonging to those clients
  const inventoryRows = await db
    .select({ id: inventory.id, sku: inventory.sku })
    .from(inventory)
    .where(inArray(inventory.clientId, testClientIds));
  const testInventoryIds = inventoryRows.map((r) => r.id);

  console.log(`Will delete:`);
  console.log(`  • ${testOrderIds.length} test order(s) (and their shipments / ledger / billing / overrides / queue entries)`);
  console.log(`  • ${testInventoryIds.length} test inventory SKU(s) (and their ledger entries)`);
  console.log('');

  if (testOrderIds.length === 0 && testInventoryIds.length === 0) {
    console.log('Nothing to delete. Test clients exist but have no data.');
    process.exit(0);
  }

  if (isDryRun) {
    console.log('--dry-run flag set — exiting without deleting.');
    process.exit(0);
  }

  // Per user override unlock shipped data on 2026-07-21: fail before a test
  // purge could cascade through immutable shipped inventory movements.
  const [orderLedgerCount] = testOrderIds.length
    ? await db.select({ count: sql<number>`count(*)::int` }).from(inventoryLedger).where(inArray(inventoryLedger.orderId, testOrderIds))
    : [{ count: 0 }];
  const [inventoryLedgerCount] = testInventoryIds.length
    ? await db.select({ count: sql<number>`count(*)::int` }).from(inventoryLedger).where(inArray(inventoryLedger.inventoryId, testInventoryIds))
    : [{ count: 0 }];
  if (Number(orderLedgerCount?.count ?? 0) + Number(inventoryLedgerCount?.count ?? 0) > 0) {
    throw new Error('PS439_INVENTORY_LEDGER_IMMUTABLE: use a fresh isolated test client/database instead of deleting movement history');
  }

  // 4. Cascading delete in FK-safe order, wrapped in a transaction
  const result = await db.transaction(async (tx) => {
    let billing = 0;
    let ledgerByOrder = 0;
    let ledgerByInventory = 0;
    let orderOverridesDeleted = 0;
    let shipmentsDeleted = 0;
    let queueEntries = 0;
    let ordersDeleted = 0;
    let inventoryRowsDeleted = 0;

    if (testOrderIds.length > 0) {
      // Children of orders first
      const billingDel = await tx
        .delete(billingLineItems)
        .where(inArray(billingLineItems.orderId, testOrderIds))
        .returning({ id: billingLineItems.id });
      billing = billingDel.length;

      const overridesDel = await tx
        .delete(orderOverrides)
        .where(inArray(orderOverrides.orderId, testOrderIds))
        .returning({ orderId: orderOverrides.orderId });
      orderOverridesDeleted = overridesDel.length;

      const shipmentsDel = await tx
        .delete(shipments)
        .where(inArray(shipments.orderId, testOrderIds))
        .returning({ id: shipments.id });
      shipmentsDeleted = shipmentsDel.length;

      // print_queue_orders.orderId is text(stringified order id)
      const queueDel = await tx
        .delete(printQueue)
        .where(inArray(printQueue.orderId, testOrderIds.map(String)))
        .returning({ id: printQueue.id });
      queueEntries = queueDel.length;
    }

    // Also nuke any queue entries whose client_id IS the test client
    // (in case a queue row was added via different code path that
    // didn't set order_id correctly).
    const queueByClientDel = await tx
      .delete(printQueue)
      .where(inArray(printQueue.clientId, testClientIds))
      .returning({ id: printQueue.id });
    queueEntries += queueByClientDel.length;

    // Now delete the orders themselves
    if (testOrderIds.length > 0) {
      const ordersDel = await tx
        .delete(orders)
        .where(inArray(orders.clientId, testClientIds))
        .returning({ id: orders.id });
      ordersDeleted = ordersDel.length;
    }

    // Finally delete the test inventory SKU rows
    if (testInventoryIds.length > 0) {
      const inventoryDel = await tx
        .delete(inventory)
        .where(inArray(inventory.clientId, testClientIds))
        .returning({ id: inventory.id });
      inventoryRowsDeleted = inventoryDel.length;
    }

    return {
      billing,
      ledgerByOrder,
      ledgerByInventory,
      orderOverridesDeleted,
      shipmentsDeleted,
      queueEntries,
      ordersDeleted,
      inventoryRowsDeleted,
    };
  });

  console.log('━'.repeat(60));
  console.log('✅ Cleanup complete:');
  console.log(`  - billing_line_items deleted: ${result.billing}`);
  console.log(`  - inventory_ledger (by order_id):     ${result.ledgerByOrder}`);
  console.log(`  - inventory_ledger (by inventory_id): ${result.ledgerByInventory}`);
  console.log(`  - order_overrides deleted: ${result.orderOverridesDeleted}`);
  console.log(`  - shipments deleted: ${result.shipmentsDeleted}`);
  console.log(`  - print_queue_orders deleted: ${result.queueEntries}`);
  console.log(`  - orders deleted: ${result.ordersDeleted}`);
  console.log(`  - inventory rows (test SKUs) deleted: ${result.inventoryRowsDeleted}`);
  console.log('━'.repeat(60));
  console.log('');
  console.log('NOT touched:');
  console.log('  - clients (test client kept; flip is_test=false to convert to real)');
  console.log('  - packages + package_ledger (no client_id — clean manually if needed)');
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
