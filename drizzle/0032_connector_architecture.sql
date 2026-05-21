-- PS-006 connector architecture foundation.
-- Non-destructive schema additions only. The shipped-data override phrase
-- `unlock shipped data` was provided by the user on 2026-05-21.

CREATE TABLE IF NOT EXISTS connector_accounts (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  client_id bigint,
  provider text NOT NULL,
  account_name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('store', 'carrier', 'inventory', 'catalog')),
  credentials_ref text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_accounts_company_provider_name_idx
  ON connector_accounts (company_id, provider, account_name);

CREATE TABLE IF NOT EXISTS connector_sync_state (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  connector_account_id bigint NOT NULL REFERENCES connector_accounts(id),
  provider text NOT NULL,
  sync_type text NOT NULL,
  cursor text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_sync_state_unique_idx
  ON connector_sync_state (company_id, connector_account_id, provider, sync_type);

CREATE TABLE IF NOT EXISTS connector_events (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  connector_account_id bigint,
  provider text NOT NULL,
  event_type text NOT NULL,
  source_event_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_account_id text,
  ADD COLUMN IF NOT EXISTS source_order_id text,
  ADD COLUMN IF NOT EXISTS source_order_number text,
  ADD COLUMN IF NOT EXISTS raw_source_payload jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS orders_source_unique_idx
  ON orders (source_provider, source_account_id, source_order_id)
  WHERE source_provider IS NOT NULL
    AND source_account_id IS NOT NULL
    AND source_order_id IS NOT NULL;

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS carrier_provider text,
  ADD COLUMN IF NOT EXISTS carrier_account_id text,
  ADD COLUMN IF NOT EXISTS label_provider_key text,
  ADD COLUMN IF NOT EXISTS confirmation_provider text,
  ADD COLUMN IF NOT EXISTS confirmation_status text;
