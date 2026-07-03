import { sql } from 'drizzle-orm';
import { db } from './client.js';

// PS-373 (slice 2) — runtime schema ensure for the frozen storage-proof sidecar.
// Mirrors drizzle/0055_billing_storage_proof.sql EXACTLY so the billing generate
// path can freeze the proof pre-migration (same belt-and-suspenders pattern as
// the shipment-bundles / selected-rate-cost ensures). Idempotent + memoized +
// lockdown-safe: CREATE TABLE IF NOT EXISTS on an ADDITIVE sidecar only — never
// an ALTER/DROP/UPDATE of any order/shipment/billing table.
let ensured: Promise<void> | null = null;

export async function ensureBillingStorageProofSchema(): Promise<void> {
  ensured ??= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS billing_storage_proof (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL,
        days_in_month integer NOT NULL,
        monthly_rate_per_cu_ft numeric(10, 4) NOT NULL,
        daily_rate_per_cu_ft numeric(18, 10) NOT NULL,
        total_cu_ft_days numeric(18, 6) NOT NULL,
        amount numeric(10, 2) NOT NULL,
        sku_count integer NOT NULL,
        exception_count integer NOT NULL,
        proof jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_storage_proof_client_period_unq UNIQUE (client_id, period_start, period_end)
      )
    `);
  })().catch((err) => {
    ensured = null;
    throw err;
  });
  return ensured;
}
