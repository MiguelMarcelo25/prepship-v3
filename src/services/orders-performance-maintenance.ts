import { sql as maintenanceSql } from '../db/client.js';
import { backfillMissingOrderItems, syncOrderItemOrderFields } from './order-items';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

let ensurePromise: Promise<void> | null = null;

export function ensureOrdersPerformanceIndexes(): void {
  if (ensurePromise) return;
  ensurePromise = runEnsureOrdersPerformanceIndexes();
}

async function runEnsureOrdersPerformanceIndexes(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0021 owns
  // shipment support indexes; maintenance verifies readiness before data repair.
  await assertRuntimeSchemaReady();

  try {
    let backfilled = 0;
    let rounds = 0;
    do {
      backfilled = await backfillMissingOrderItems(5000);
      rounds += 1;
      if (backfilled > 0) {
        console.log(
          `[orders:maintenance] backfilled ${backfilled} order_items rows`
        );
      }
    } while (backfilled > 0 && rounds < 50);

    const repaired = await syncOrderItemOrderFields();
    if (repaired > 0) {
      console.log(
        `[orders:maintenance] repaired ${repaired} stale order_items fields`
      );
    }

    await maintenanceSql`ANALYZE "orders"`;
    await maintenanceSql`ANALYZE "order_items"`;
    await maintenanceSql`ANALYZE "shipments"`;
    await maintenanceSql`ANALYZE "inventory"`;
    await maintenanceSql`ANALYZE "inventory_ledger"`;
    console.log('[orders:maintenance] refreshed planner stats');
  } catch (err) {
    console.warn(
      '[orders:maintenance] analyze failed:',
      err instanceof Error ? err.message : err
    );
  }
}
