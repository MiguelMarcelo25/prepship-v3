import postgres from 'postgres';
import { env } from '../lib/env';
import { backfillMissingOrderItems } from './order-items';

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "order_items" (
      "id" serial PRIMARY KEY,
      "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
      "line_index" integer NOT NULL DEFAULT 0,
      "sku" text NOT NULL,
      "name" text,
      "quantity" numeric(12, 3) NOT NULL DEFAULT 0,
      "unit_price" numeric(12, 2) NOT NULL DEFAULT 0,
      "line_total" numeric(12, 2) NOT NULL DEFAULT 0,
      "image_url" text,
      "client_id" integer REFERENCES "clients"("id"),
      "store_id" integer,
      "order_status" text NOT NULL,
      "order_date" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS "analytics_cache" (
      "cache_key" text PRIMARY KEY,
      "payload" jsonb NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
];

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
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "order_items_order_line_idx"
     ON "order_items" ("order_id", "line_index")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_order_id_idx"
     ON "order_items" ("order_id")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_sku_idx"
     ON "order_items" ("sku")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_lower_sku_idx"
     ON "order_items" (lower("sku"))`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_date_idx"
     ON "order_items" ("order_date")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_client_date_idx"
     ON "order_items" ("client_id", "order_date")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_store_date_idx"
     ON "order_items" ("store_id", "order_date")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_active_date_idx"
     ON "order_items" ("order_date")
     WHERE "order_status" <> 'cancelled'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_active_client_date_idx"
     ON "order_items" ("client_id", "order_date")
     WHERE "order_status" <> 'cancelled'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_active_sku_date_idx"
     ON "order_items" ("sku", "order_date")
     WHERE "order_status" <> 'cancelled'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "analytics_cache_expires_idx"
     ON "analytics_cache" ("expires_at")`,
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
    for (const statement of TABLE_STATEMENTS) {
      const startedAt = Date.now();
      try {
        await maintenanceSql.unsafe(statement);
        console.log(
          `[orders:maintenance] ensured table in ${Date.now() - startedAt}ms`
        );
      } catch (err) {
        console.error(
          '[orders:maintenance] table ensure failed:',
          err instanceof Error ? err.message : err
        );
        return;
      }
    }

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
