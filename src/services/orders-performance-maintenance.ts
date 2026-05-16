import postgres from 'postgres';
import { env } from '../lib/env';

const INDEX_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_status_date_id_idx"
     ON "orders" ("order_status", "order_date" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_store_status_date_idx"
     ON "orders" ("store_id", "order_status", "order_date" DESC)
     WHERE "store_id" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_dashboard_sales_date_idx"
     ON "orders" ("order_date" DESC)
     WHERE "order_status" <> 'cancelled'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_dashboard_sales_client_date_idx"
     ON "orders" ("client_id", "order_date" DESC)
     WHERE "order_status" <> 'cancelled'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "inventory_active_updated_idx"
     ON "inventory" ("active", "updated_at" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "inventory_client_active_updated_idx"
     ON "inventory" ("client_id", "active", "updated_at" DESC)
     WHERE "client_id" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "inventory_ledger_inv_type_idx"
     ON "inventory_ledger" ("inventory_id", "type")`,
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
      await maintenanceSql`ANALYZE "orders"`;
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
