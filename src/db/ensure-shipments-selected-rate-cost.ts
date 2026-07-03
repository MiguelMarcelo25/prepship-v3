import { sql as pg } from './client.js';

// PS-370 Phase 1 — runtime schema ensure for the persisted selected/label cost.
// Mirrors drizzle/0054_shipments_selected_rate_cost.sql EXACTLY so the API + worker
// both work pre-migration (same belt-and-suspenders pattern as the shipment-bundles
// / order-competitive-rate ensures). Idempotent + lockdown-safe: an ADDITIVE nullable
// column ONLY — never an UPDATE/DELETE against the locked shipments rows, and never a
// drop/type change. Capture call sites await this once before their first insert that
// writes the column.
let ensured: Promise<void> | null = null;

export async function ensureShipmentsSelectedRateCostColumn(): Promise<void> {
  ensured ??= (async () => {
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS selected_rate_cost numeric(10, 2)`;
  })().catch((err) => {
    ensured = null;
    throw err;
  });
  return ensured;
}
