import postgres from 'postgres';
import { env } from '../lib/env';
import { backfillMissingOrderItems, syncOrderItemOrderFields } from './order-items';

const INDEX_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "shipments_order_latest_idx"
     ON "shipments" ("order_id", "id" DESC)
     WHERE "order_id" IS NOT NULL AND coalesce("voided", false) = false`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "shipments_order_number_latest_idx"
     ON "shipments" ("order_number", "id" DESC)
     WHERE "order_number" IS NOT NULL AND "order_id" IS NULL AND coalesce("voided", false) = false`,
];

let ensurePromise: Promise<void> | null = null;

export function ensureOrdersPerformanceIndexes(): void {
  if (ensurePromise) return;
  ensurePromise = runEnsureOrdersPerformanceIndexes();
}

async function runEnsureOrdersPerformanceIndexes(): Promise<void> {
  const maintenanceSql = postgres(env.DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    for (const statement of INDEX_STATEMENTS) {
      const startedAt = Date.now();
      try {
        await maintenanceSql.unsafe(statement);
        console.log(
          `[orders:maintenance] ensured index in ${Date.now() - startedAt}ms`
        );
      } catch (err) {
        console.error(
          '[orders:maintenance] index ensure failed:',
          err instanceof Error ? err.message : err
        );
        return;
      }
    }

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
  } finally {
    await maintenanceSql.end({ timeout: 5 });
  }
}
