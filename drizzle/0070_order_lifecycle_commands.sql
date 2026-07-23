-- PS-424: canonical order lifecycle command receipts and exact, reversible
-- fulfillment-line inventory claims. This migration is additive only. It does
-- not rewrite historical orders, shipments, inventory, or ledger rows.
CREATE TABLE IF NOT EXISTS order_lifecycle_events (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  shipment_id integer REFERENCES shipments(id),
  command_key text NOT NULL,
  transition text NOT NULL CHECK (transition IN ('shipped', 'external_shipped', 'external_classified', 'cancelled', 'void', 'external_unmark')),
  source text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  fulfilled_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS order_lifecycle_events_command_unq
  ON order_lifecycle_events (command_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_lifecycle_events_order_idx
  ON order_lifecycle_events (order_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_lifecycle_events_shipment_idx
  ON order_lifecycle_events (shipment_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_lifecycle_events_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'order_lifecycle_events is append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS order_lifecycle_events_no_update_delete ON order_lifecycle_events;
--> statement-breakpoint
CREATE TRIGGER order_lifecycle_events_no_update_delete
BEFORE UPDATE OR DELETE ON order_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION order_lifecycle_events_block_mutations();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fulfillment_line_claims (
  id serial PRIMARY KEY,
  lifecycle_event_id integer NOT NULL REFERENCES order_lifecycle_events(id),
  order_id integer NOT NULL REFERENCES orders(id),
  shipment_id integer REFERENCES shipments(id),
  line_key text NOT NULL,
  sku text,
  name text,
  quantity integer NOT NULL CHECK (quantity > 0),
  direction text NOT NULL CHECK (direction IN ('deduct', 'reverse')),
  original_claim_id integer REFERENCES fulfillment_line_claims(id),
  inventory_id integer REFERENCES inventory(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'superseded', 'reversed', 'review')),
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_line_claims_idempotency_unq
  ON fulfillment_line_claims (idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fulfillment_line_claims_event_status_idx
  ON fulfillment_line_claims (lifecycle_event_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fulfillment_line_claims_shipment_idx
  ON fulfillment_line_claims (shipment_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fulfillment_line_claims_original_idx
  ON fulfillment_line_claims (original_claim_id);
