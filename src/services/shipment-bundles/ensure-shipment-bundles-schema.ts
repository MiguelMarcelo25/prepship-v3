// PS-312 (S0) — runtime schema ensure for the combined-shipment-bundle sidecar tables (mirrors
// the PS-207 billing_box_resolutions pattern). CREATE TABLE IF NOT EXISTS so the additive tables
// exist before any bundle write, without a blocking out-of-band migration. Idempotent + memoized.
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

let ensured: Promise<void> | null = null;

export async function ensureShipmentBundlesSchema(): Promise<void> {
  ensured ??= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS shipment_bundles (
        id serial PRIMARY KEY,
        client_id integer REFERENCES clients(id),
        primary_order_id integer NOT NULL REFERENCES orders(id),
        primary_shipment_id integer REFERENCES shipments(id),
        tracking_number text,
        carrier_code text,
        service_code text,
        selected_rate jsonb,
        label_url text,
        label_shipment_id text,
        package_id integer REFERENCES packages(id),
        status text NOT NULL DEFAULT 'draft',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS shipment_bundle_members (
        id serial PRIMARY KEY,
        bundle_id integer NOT NULL REFERENCES shipment_bundles(id) ON DELETE CASCADE,
        order_id integer NOT NULL REFERENCES orders(id),
        role text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT shipment_bundle_members_order_unq UNIQUE (order_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS shipment_bundles_client_idx ON shipment_bundles(client_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS shipment_bundle_members_bundle_idx ON shipment_bundle_members(bundle_id)`);
  })().catch((err) => {
    ensured = null;
    throw err;
  });
  return ensured;
}
