/**
 * PS-502 — the schema both test lanes build on.
 *
 * Shared deliberately. The PGlite lane and the PG17 lane must exercise the SAME schema, or a
 * behaviour proven in one says nothing about the other, and the divergence would be invisible
 * until a case passed in the fast lane and failed only under real concurrency.
 *
 * The prerequisite tables are minimal but COMPLETE for what the commands touch: Drizzle emits
 * every declared column on an insert, so a table missing one fails exactly as a real database
 * would. The PS-502 migrations themselves are then applied VERBATIM from drizzle/, so the
 * schema under test is the schema that ships — CHECK constraints, partial unique indexes and
 * FK delete actions included.
 */

/** Tables the PS-502 migrations reference, plus the ones the commands read and write. */
export const PS_502_PREREQUISITE_DDL = `
  -- Only so 0025_order_items_sync_trigger.sql can be applied VERBATIM: it indexes this table.
  CREATE TABLE analytics_cache (id serial PRIMARY KEY, expires_at timestamptz);
  CREATE TABLE clients (id serial PRIMARY KEY, name text);
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    client_id integer REFERENCES clients(id),
    order_number text NOT NULL,
    order_status text NOT NULL DEFAULT 'awaiting_shipment',
    store_id integer,
    order_date timestamptz,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE order_items (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_index integer NOT NULL DEFAULT 0,
    sku text NOT NULL,
    name text,
    quantity numeric(12,3) NOT NULL DEFAULT '0',
    unit_price numeric(12,2) NOT NULL DEFAULT '0',
    line_total numeric(12,2) NOT NULL DEFAULT '0',
    image_url text,
    client_id integer,
    store_id integer,
    order_status text NOT NULL DEFAULT 'shipped',
    order_date timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX order_items_order_line_idx ON order_items (order_id, line_index);
  -- Mirrors src/db/schema/shipments.ts in full. Drizzle emits EVERY declared column on an
  -- insert, so a table missing one fails the same way a real database would.
  CREATE TABLE shipments (
    id serial PRIMARY KEY,
    order_id integer REFERENCES orders(id),
    client_id integer REFERENCES clients(id),
    order_number text, carrier_code text, service_code text, tracking_number text,
    ship_date timestamptz, create_date timestamptz,
    weight_oz real, dims_l real, dims_w real, dims_h real,
    cost numeric(10,2), other_cost numeric(10,2) NOT NULL DEFAULT '0',
    selected_rate_cost numeric(10,2),
    label_url text, label_created_at timestamptz, label_format text, label_carrier text,
    label_service text, label_tracking text, label_cost numeric(10,2),
    label_ship_date timestamptz, label_provider integer, label_shipment_id integer,
    selected_rate_json jsonb, selected_pid integer, selected_package_id text,
    provider_account_id integer, provider_account_nickname text, carrier_provider text,
    carrier_account_id text, label_provider_key text,
    confirmation_provider text, confirmation_status text,
    confirmation_attempts integer NOT NULL DEFAULT 0, confirmation_last_error text,
    marketplace_confirmed_at timestamptz,
    voided boolean NOT NULL DEFAULT false, source text,
    is_return boolean NOT NULL DEFAULT false,
    return_for_shipment_id integer, return_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE billing_line_items (
    id serial PRIMARY KEY,
    order_id integer,
    shipment_id integer,
    line_type text NOT NULL,
    description text,
    replacement_id integer
  );
  CREATE TABLE billing_credit_notes (
    id text PRIMARY KEY,
    finalization_id text,
    reason text NOT NULL,
    replacement_id integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * Applied verbatim, in order.
 *
 * 0025 is the REAL order_items sync trigger — without it the AC-14 case never performs the
 * DELETE-and-reinsert it claims to survive. 0098 alters FKs 0097 created, so order matters.
 */
export const PS_502_MIGRATIONS = [
  'drizzle/0025_order_items_sync_trigger.sql',
  'drizzle/0096_ps502_replacements.sql',
  'drizzle/0097_ps502_replacement_billing.sql',
  'drizzle/0098_ps502_replacement_financial_restrict.sql',
  'drizzle/0099_ps502_replacement_request_signature.sql',
  'drizzle/0100_ps502_replacement_operational_state.sql',
] as const;

/** A shipped original: 3 x SKU-A at line 0, 2 x SKU-B at line 1. */
export const PS_502_SEED_ITEMS_JSON =
  '[{"sku":"SKU-A","name":"Widget A","quantity":3},{"sku":"SKU-B","name":"Widget B","quantity":2}]';

/**
 * Seeded THROUGH orders.items so the sync trigger produces order_items, exactly as production
 * does. Inserting order_items by hand would test a table the trigger owns.
 */
export const PS_502_SEED_SQL = `
  INSERT INTO clients (id, name) VALUES (1, 'Acme');
  INSERT INTO orders (id, client_id, order_number, order_status, items)
    VALUES (1321, 1, '1321', 'shipped', '${PS_502_SEED_ITEMS_JSON}'::jsonb);
`;
