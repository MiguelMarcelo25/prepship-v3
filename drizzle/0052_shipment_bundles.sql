-- PS-312 - combined shipment bundle sidecars (multiple orders -> ONE physical shipment/label).
-- LOCKDOWN-SAFE: additive tables only. No ALTER/UPDATE/DELETE against orders or shipments.
-- The existing shipments table remains the durable per-label record; bundle + member rows only
-- REFERENCE orders/shipments read-only. The existing one-order<->one-shipment path is untouched.

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
);

CREATE INDEX IF NOT EXISTS shipment_bundles_client_idx
  ON shipment_bundles (client_id);
CREATE INDEX IF NOT EXISTS shipment_bundles_primary_order_idx
  ON shipment_bundles (primary_order_id);

CREATE TABLE IF NOT EXISTS shipment_bundle_members (
  id serial PRIMARY KEY,
  bundle_id integer NOT NULL REFERENCES shipment_bundles(id) ON DELETE CASCADE,
  order_id integer NOT NULL REFERENCES orders(id),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_bundle_members_order_unq UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS shipment_bundle_members_bundle_idx
  ON shipment_bundle_members (bundle_id);
