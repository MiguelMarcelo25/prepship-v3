-- PS-289 - multi-package shipment group sidecars.
-- LOCKDOWN-SAFE: additive tables only. No ALTER/UPDATE/DELETE against orders or shipments.
-- The existing shipments table remains the durable per-label record; package rows may reference a
-- shipment only after a future per-package label workflow creates that shipment.

CREATE TABLE IF NOT EXISTS shipment_groups (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id integer REFERENCES clients(id),
  order_number text,
  group_key text NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  package_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipment_groups_group_key_unq
  ON shipment_groups (group_key);
CREATE INDEX IF NOT EXISTS shipment_groups_order_idx
  ON shipment_groups (order_id);
CREATE INDEX IF NOT EXISTS shipment_groups_client_status_idx
  ON shipment_groups (client_id, status);

CREATE TABLE IF NOT EXISTS shipment_group_packages (
  id serial PRIMARY KEY,
  shipment_group_id integer NOT NULL REFERENCES shipment_groups(id) ON DELETE CASCADE,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id integer REFERENCES clients(id),
  package_key text NOT NULL,
  package_sequence integer NOT NULL,
  label_idempotency_key text NOT NULL,
  weight_oz real,
  dims_l real,
  dims_w real,
  dims_h real,
  items jsonb,
  status text NOT NULL DEFAULT 'planned',
  shipment_id integer REFERENCES shipments(id),
  tracking_number text,
  label_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipment_group_packages_key_unq
  ON shipment_group_packages (shipment_group_id, package_key);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_group_packages_sequence_unq
  ON shipment_group_packages (shipment_group_id, package_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_group_packages_label_idempotency_unq
  ON shipment_group_packages (label_idempotency_key);
CREATE INDEX IF NOT EXISTS shipment_group_packages_order_idx
  ON shipment_group_packages (order_id);
CREATE INDEX IF NOT EXISTS shipment_group_packages_shipment_idx
  ON shipment_group_packages (shipment_id);
