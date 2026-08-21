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
  CREATE TABLE clients (
    id serial PRIMARY KEY,
    name text,
    store_ids integer[],
    ss_api_key text,
    ss_api_secret text,
    ss_api_key_v2 text,
    rate_source_client_id integer,
    active boolean NOT NULL DEFAULT true,
    is_test boolean NOT NULL DEFAULT false
  );
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    client_id integer REFERENCES clients(id),
    source_provider text,
    source_account_id text,
    source_order_id text,
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
  -- Replacement shipment insertion resolves a package reference before attaching the
  -- immutable vessel. Mirror the canonical package shape so the harness cannot accept a
  -- package code that production would reject (or vice versa).
  CREATE TABLE packages (
    id serial PRIMARY KEY,
    name text NOT NULL,
    type text NOT NULL DEFAULT 'box',
    length real NOT NULL DEFAULT 0,
    width real NOT NULL DEFAULT 0,
    height real NOT NULL DEFAULT 0,
    tare_weight_oz real NOT NULL DEFAULT 0,
    source text NOT NULL DEFAULT 'custom',
    carrier_code text,
    package_code text,
    domestic boolean,
    international boolean,
    stock_qty integer NOT NULL DEFAULT 0,
    reorder_level integer NOT NULL DEFAULT 10,
    unit_cost numeric(10,2),
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- The shipped command deducts through applyInventoryMovementInTransaction, so the
  -- ledger and its idempotency index are part of the schema under test: the whole point
  -- is that a replacement-scoped key does NOT collide with the order-scoped one.
  -- Mirrors src/db/schema/inventory.ts. NOTE: there is no quantity column — stock is
  -- DERIVED from inventory_ledger, so a test asserting a balance must sum the ledger.
  CREATE TABLE inventory (
    id serial PRIMARY KEY,
    client_id integer REFERENCES clients(id),
    sku text NOT NULL,
    name text,
    image_url text,
    reorder_level integer NOT NULL DEFAULT 0,
    weight_oz real DEFAULT 0,
    length real, width real, height real,
    parent_sku_id integer,
    base_unit_qty integer NOT NULL DEFAULT 1,
    units_per_pack integer NOT NULL DEFAULT 1,
    cu_ft_override real,
    package_id integer,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE inventory_ledger (
    id serial PRIMARY KEY,
    inventory_id integer NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    type text NOT NULL,
    qty integer NOT NULL,
    order_id integer REFERENCES orders(id),
    client_id integer REFERENCES clients(id),
    sku text,
    source_entity text,
    source_id text,
    note text,
    created_by text,
    effective_at timestamptz,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- The identity that makes a replacement-scoped key provably distinct from the
  -- order-scoped one: two different keys must both be insertable.
  CREATE UNIQUE INDEX inventory_ledger_idempotency_key_unq
    ON inventory_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
  -- 0075's second replay identity matters independently of the explicit key. Two frozen
  -- replacement items may legitimately map to the same SKU/inventory row, so the integration
  -- harness must include the production constraint that caught shipment-only source ids.
  CREATE UNIQUE INDEX inventory_ledger_source_identity_unq
    ON inventory_ledger (source_entity, source_id, inventory_id, type)
    WHERE source_entity IS NOT NULL AND source_id IS NOT NULL;
  -- Mirrors src/db/schema/billing.ts billingLineItems IN FULL. Drizzle emits every declared
  -- column on an insert, so a table missing one fails exactly as production would — which is
  -- how the missing return_id surfaced here rather than in a deploy.
  CREATE TABLE billing_line_items (
    id serial PRIMARY KEY,
    client_id integer NOT NULL,
    order_id integer,
    order_number text,
    shipment_id integer,
    return_id integer,
    replacement_id integer,
    ship_date timestamptz,
    billing_effective_date timestamptz,
    billing_policy_version text,
    line_type text NOT NULL,
    description text NOT NULL,
    qty numeric(10,2) NOT NULL DEFAULT 1,
    unit_cost numeric(10,2) NOT NULL,
    total_cost numeric(10,2) NOT NULL,
    package_id integer,
    source_finalization_id text,
    billing_adjustment_id text,
    invoiced boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- A closed period. Mirrors src/db/schema/billing.ts billingFinalizations for the columns
  -- the frozen-line join reads. Present because the reconciler identifies a finalized line
  -- by JOINING here on the effective date, not by a column on the line — the distinction
  -- that made the original predicate unmatchable and undetectable by source text.
  -- Append-only receipts owned outside PS-502. Present because an AC-16 hold points at
  -- one by foreign key: a hold whose evidence cannot be resolved is an unfalsifiable claim,
  -- so the pointer is a real reference rather than a loose integer.
  CREATE TABLE order_lifecycle_events (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id),
    command_key text NOT NULL,
    transition text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE webhook_events (
    id serial PRIMARY KEY,
    provider text NOT NULL DEFAULT 'test',
    source_order_id text,
    related_order_id integer REFERENCES orders(id),
    canonical_status text,
    status text NOT NULL DEFAULT 'processed',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- The customer-money policy. The AC-10 freeze reads markup and hugrab override from here to
  -- turn a carrier receipt into what the client is actually charged; without it the freeze
  -- cannot decide anything and the fence has nothing to accept.
  -- Reference rates for the customer-money floor. Absent, the whole policy read fails and
  -- every replacement label would be recorded as unpriceable.
  CREATE TABLE order_overrides (
    order_id integer PRIMARY KEY REFERENCES orders(id),
    ref_usps_rate numeric(10,2),
    ref_ups_rate numeric(10,2)
  );
  CREATE TABLE billing_config (
    client_id integer PRIMARY KEY REFERENCES clients(id),
    active boolean NOT NULL DEFAULT true,
    billing_mode text NOT NULL DEFAULT 'markup',
    pick_pack_fee numeric(10,2) NOT NULL DEFAULT 0,
    shipping_markup_pct numeric(10,2) NOT NULL DEFAULT 0,
    shipping_markup_flat numeric(10,2) NOT NULL DEFAULT 0,
    hugrab_shipping_rate_override_enabled boolean NOT NULL DEFAULT false,
    hugrab_shipping_rate_override_threshold numeric(10,2),
    hugrab_shipping_rate_override_amount numeric(10,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE settings (
    key text PRIMARY KEY,
    value text
  );
  CREATE TABLE billing_finalizations (
    id text PRIMARY KEY,
    client_id integer NOT NULL REFERENCES clients(id),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    line_count integer NOT NULL DEFAULT 0,
    order_count integer NOT NULL DEFAULT 0,
    subtotal numeric(12,2) NOT NULL DEFAULT 0,
    finalized_by text NOT NULL DEFAULT 'test',
    finalized_by_email text,
    finalized_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE billing_credit_notes (
    id text PRIMARY KEY,
    finalization_id text NOT NULL REFERENCES billing_finalizations(id) ON DELETE RESTRICT,
    client_id integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    adjustment_kind text NOT NULL DEFAULT 'credit',
    adjustment_source text NOT NULL DEFAULT 'manual',
    source_order_id integer REFERENCES orders(id) ON DELETE RESTRICT,
    reason text NOT NULL,
    replacement_id integer,
    posting_version text NOT NULL DEFAULT 'legacy_credit_v1',
    effective_date timestamptz,
    billing_policy_version text,
    idempotency_key text NOT NULL UNIQUE,
    created_by text NOT NULL,
    created_by_email text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Migration 0102 extends this pre-existing reporting cache. Keep the prerequisite at its
  -- 0029 shape so the PS-502 migration is exercised verbatim rather than pre-baking its columns.
  CREATE TABLE billing_summary_metrics (
    client_id integer NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    order_count integer NOT NULL DEFAULT 0,
    pick_pack_total numeric(14, 2) NOT NULL DEFAULT 0,
    additional_total numeric(14, 2) NOT NULL DEFAULT 0,
    package_total numeric(14, 2) NOT NULL DEFAULT 0,
    shipping_total numeric(14, 2) NOT NULL DEFAULT 0,
    storage_total numeric(14, 2) NOT NULL DEFAULT 0,
    grand_total numeric(14, 2) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, period_from, period_to)
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
  'drizzle/0101_ps502_replacement_original_order_holds.sql',
  'drizzle/0102_billing_summary_metrics_replacement_totals.sql',
  'drizzle/0103_ps502_replacement_financial_actions.sql',
] as const;

/** A shipped original: 3 x SKU-A at line 0, 2 x SKU-B at line 1. */
export const PS_502_SEED_ITEMS_JSON =
  '[{"sku":"SKU-A","name":"Widget A","quantity":3},{"sku":"SKU-B","name":"Widget B","quantity":2},{"sku":"SKU-C","name":"Widget C","quantity":99}]';

/**
 * Seeded THROUGH orders.items so the sync trigger produces order_items, exactly as production
 * does. Inserting order_items by hand would test a table the trigger owns.
 */
export const PS_502_SEED_SQL = `
  -- Client 1 owns both polling (V1) and purchase (V2) credentials. Keeping the two values
  -- visibly different prevents a test from treating a V1 account id as authority for the
  -- V2 credential that actually bought replacement postage.
  INSERT INTO clients (
    id, name, ss_api_key, ss_api_secret, ss_api_key_v2, active, is_test
  ) VALUES
    (1, 'Acme', 'ps502-v1-key', 'ps502-v1-secret', 'ps502-v2-fixture', true, false),
    (2, 'Offline Test Client', 'ps502-test-v1-key', 'ps502-test-v1-secret',
      'ps502-test-v2-key', true, true),
    (3, 'V1 Only Client', 'ps502-v1-only-key', 'ps502-v1-only-secret', null, true, false);
  INSERT INTO packages (id, name, package_code, length, width, height, stock_qty)
    VALUES (1, 'Fixture Box A', 'box-a', 10, 8, 6, 100);
  -- 18% markup, so the frozen CUSTOMER amount is provably different from the carrier cost
  -- the provider receipt carries. A zero-markup fixture would let a fence that returned
  -- selectedRateCost pass by coincidence.
  INSERT INTO billing_config (client_id, shipping_markup_pct) VALUES (1, 18.00);
  INSERT INTO orders (id, client_id, order_number, order_status, items)
    VALUES (1321, 1, '1321', 'shipped', '${PS_502_SEED_ITEMS_JSON}'::jsonb);
`;
