import { sql as pg } from './client.js';

// PS-220 — runtime schema ensure for the house-margin sidecar. Mirrors
// drizzle/0049_order_competitive_rate.sql EXACTLY so the API/worker both work pre-migration
// (same pattern as ensureAddressClassificationsSchema). Idempotent + lockdown-safe: a NEW table
// only — never an ALTER/UPDATE/DELETE against the locked orders/shipments tables. Capture call
// sites await this once before their first insert.
let ensured: Promise<void> | null = null;

export async function ensureOrderCompetitiveRateSchema(): Promise<void> {
  ensured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS order_competitive_rate (
        id serial PRIMARY KEY,
        order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        shipment_id integer REFERENCES shipments(id),
        client_id integer,
        drp_cost numeric(10,2) NOT NULL,
        customer_rate numeric(10,2) NOT NULL,
        margin numeric(10,2) NOT NULL CHECK (margin >= 0),
        source text,
        source_carrier text,
        source_service text,
        source_provider_account_id integer,
        competitor_count integer NOT NULL DEFAULT 0,
        is_house_order boolean NOT NULL DEFAULT false,
        quote_fingerprint text,
        captured_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await pg`CREATE INDEX IF NOT EXISTS order_competitive_rate_order_idx ON order_competitive_rate (order_id)`;
    await pg`CREATE INDEX IF NOT EXISTS order_competitive_rate_house_idx ON order_competitive_rate (is_house_order)`;
    await pg`CREATE UNIQUE INDEX IF NOT EXISTS order_competitive_rate_realized_unq ON order_competitive_rate (order_id, shipment_id) WHERE shipment_id IS NOT NULL`;
    await pg`CREATE UNIQUE INDEX IF NOT EXISTS order_competitive_rate_projected_unq ON order_competitive_rate (order_id) WHERE shipment_id IS NULL`;
    await pg`ALTER TABLE order_competitive_rate ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    ensured = null;
    throw err;
  });
  return ensured;
}
