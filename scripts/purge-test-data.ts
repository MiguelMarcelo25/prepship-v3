/**
 * Purge all order/inventory-owned operational data for clients.is_test=true.
 *
 * Dry run:
 *   tsx scripts/purge-test-data.ts --dry-run
 *
 * Live run:
 *   tsx scripts/purge-test-data.ts
 *
 * The HTTP route and this operator command intentionally delegate to the same
 * backend service. Test-client configuration remains available for reseeding.
 */

import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client';
import { clients } from '../src/db/schema/clients';
import { inventory } from '../src/db/schema/inventory';
import { orders } from '../src/db/schema/orders';
import { purgeAllTestClientData } from '../src/services/test-data-purge';

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const testClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.isTest, true));

  if (testClients.length === 0) {
    console.log('No clients flagged is_test=true. Nothing to purge.');
    return;
  }

  if (isDryRun) {
    const clientIds = testClients.map((client) => client.id);
    const [testOrders, testInventory] = await Promise.all([
      db.select({ id: orders.id }).from(orders).where(inArray(orders.clientId, clientIds)),
      db.select({ id: inventory.id }).from(inventory).where(inArray(inventory.clientId, clientIds)),
    ]);
    console.log(JSON.stringify({
      dryRun: true,
      clients: testClients,
      rootRows: { orders: testOrders.length, inventory: testInventory.length },
      note: 'No rows were changed. A live purge also removes all related test-only operational records.',
    }, null, 2));
    return;
  }

  // Per user override unlock shipped data on 2026-07-25: the canonical
  // service independently proves test ownership before deleting any row.
  const result = await purgeAllTestClientData();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[test-data-purge] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
