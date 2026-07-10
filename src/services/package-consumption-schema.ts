/**
 * Per user override unlock shipped data on 2026-07-11: runtime-safe PS-413
 * additive schema readiness. No shipment/order mutation.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

let readiness: Promise<void> | null = null;

export function ensurePackageConsumptionSchema(): Promise<void> {
  if (readiness) return readiness;
  readiness = (async () => {
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS shipment_id integer`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS order_id integer`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS source text`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS source_account_id text`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS provider_shipment_id text`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS effective_at timestamptz`);
    await db.execute(sql`ALTER TABLE package_ledger ADD COLUMN IF NOT EXISTS idempotency_key text`);
    await db.execute(sql`DO $ps413$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'package_ledger_package_id_packages_id_fk'
            AND confdeltype = 'c'
        ) THEN
          ALTER TABLE package_ledger DROP CONSTRAINT package_ledger_package_id_packages_id_fk;
          ALTER TABLE package_ledger
            ADD CONSTRAINT package_ledger_package_id_packages_id_fk
            FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT;
        END IF;
      END
    $ps413$`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS package_ledger_shipment_idx ON package_ledger (shipment_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS package_ledger_order_idx ON package_ledger (order_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS package_ledger_effective_at_idx ON package_ledger (effective_at)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS package_ledger_idempotency_key_unq
      ON package_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS package_consumption_reviews (
      id serial PRIMARY KEY,
      shipment_id integer NOT NULL,
      order_id integer,
      source text NOT NULL,
      source_account_id text,
      provider_shipment_id text,
      effective_at timestamptz NOT NULL,
      idempotency_key text NOT NULL,
      reason text NOT NULL,
      selected_package_ref text,
      dims_l real,
      dims_w real,
      dims_h real,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS package_consumption_reviews_idempotency_unq
      ON package_consumption_reviews (idempotency_key)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS package_consumption_reviews_status_idx
      ON package_consumption_reviews (status, effective_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS package_consumption_reviews_shipment_idx
      ON package_consumption_reviews (shipment_id)`);
    await db.execute(sql`ALTER TABLE package_consumption_reviews ENABLE ROW LEVEL SECURITY`);
  })().catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}
