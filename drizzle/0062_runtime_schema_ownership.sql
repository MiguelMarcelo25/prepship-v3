-- Audit 3.3: migrations own stable runtime schema. API/worker boot now verifies
-- these objects and fails before serving work when migrations lag.
-- Per user override unlock shipped data on 2026-07-14: label/print sidecars move
-- from purchase-time DDL to additive migration ownership; no order/shipment rows
-- are updated and no existing column is dropped or changed.

CREATE TABLE IF NOT EXISTS direct_carrier_rate_cache (
  account_id integer NOT NULL,
  source_table text NOT NULL,
  carrier_code text NOT NULL,
  service_code text NOT NULL,
  request_key text NOT NULL,
  amount numeric,
  rate_json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, source_table, carrier_code, service_code, request_key)
);
CREATE INDEX IF NOT EXISTS direct_carrier_rate_cache_lookup_idx
  ON direct_carrier_rate_cache (account_id, source_table, request_key, updated_at DESC);
ALTER TABLE direct_carrier_rate_cache ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rate_limiter_state (
  key text PRIMARY KEY,
  tokens double precision NOT NULL,
  capacity double precision NOT NULL,
  tokens_per_sec double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rate_limiter_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS billing_fee_waivers (
  order_id integer PRIMARY KEY,
  decision text NOT NULL,
  reviewer text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  original_prep_amount numeric(10, 2),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_fee_waivers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS billing_manual_overrides (
  order_id integer NOT NULL,
  client_id integer NOT NULL,
  line_type text NOT NULL,
  amount numeric(10, 2) NOT NULL,
  reviewer text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_manual_overrides_line_type_chk
    CHECK (line_type IN ('pick_pack', 'additional_unit', 'shipping')),
  CONSTRAINT billing_manual_overrides_order_line_unq
    UNIQUE (order_id, line_type)
);
CREATE INDEX IF NOT EXISTS billing_manual_overrides_client_order_idx
  ON billing_manual_overrides (client_id, order_id);
ALTER TABLE billing_manual_overrides ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS label_purchase_locks (
  order_id integer PRIMARY KEY,
  token text NOT NULL,
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS label_purchase_locks_expires_at_idx
  ON label_purchase_locks (expires_at);
ALTER TABLE label_purchase_locks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS label_purchase_intents (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  provider text NOT NULL,
  request_fingerprint text,
  state text NOT NULL DEFAULT 'provider_pending',
  shipment_id integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS label_purchase_intents_unresolved_idx
  ON label_purchase_intents (order_id)
  WHERE state IN ('provider_pending', 'reconcile_required');
ALTER TABLE label_purchase_intents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS print_queue_send_jobs (
  job_id text PRIMARY KEY,
  job_type text NOT NULL DEFAULT 'batch_send',
  status text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  client_id integer,
  client_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  current integer NOT NULL DEFAULT 0,
  queued integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  message text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_queue_send_jobs_updated_at_idx
  ON print_queue_send_jobs (updated_at DESC);
ALTER TABLE print_queue_send_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS print_queue_batch_job_items (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL,
  order_id integer NOT NULL,
  client_id integer,
  state text NOT NULL,
  blocked_reason text,
  error_message text,
  queue_entry_id text,
  tracking_number text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, order_id)
);
CREATE INDEX IF NOT EXISTS print_queue_batch_job_items_job_idx
  ON print_queue_batch_job_items (job_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS print_queue_batch_job_items_state_idx
  ON print_queue_batch_job_items (state);
ALTER TABLE print_queue_batch_job_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs (
  job_id text PRIMARY KEY,
  file_name text,
  pdf_bytes bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS print_queue_pdf_chunks (
  job_id text NOT NULL,
  chunk_number integer NOT NULL,
  file_name text,
  label_count integer NOT NULL DEFAULT 0,
  file_size integer NOT NULL DEFAULT 0,
  entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  successful_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'done',
  error_message text,
  pdf_bytes bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, chunk_number)
);
ALTER TABLE print_queue_merged_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_queue_pdf_chunks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rate_browse_jobs (
  job_id text PRIMARY KEY,
  request_key text,
  order_id integer,
  priority text NOT NULL DEFAULT 'manual',
  status text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  total_carriers integer NOT NULL DEFAULT 0,
  completed_carriers integer NOT NULL DEFAULT 0,
  successful_carriers integer NOT NULL DEFAULT 0,
  failed_carriers integer NOT NULL DEFAULT 0,
  rates_count integer NOT NULL DEFAULT 0,
  message text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS rate_browse_jobs_request_active_idx
  ON rate_browse_jobs (request_key, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS rate_browse_jobs_order_updated_idx
  ON rate_browse_jobs (order_id, updated_at DESC);
ALTER TABLE rate_browse_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rate_browse_job_provider_statuses (
  job_id text NOT NULL,
  provider_key text NOT NULL,
  carrier_id text,
  account_id text,
  carrier_code text,
  carrier_name text,
  source text NOT NULL DEFAULT 'unknown',
  status text NOT NULL,
  rate_count integer NOT NULL DEFAULT 0,
  duration_ms integer,
  limiter_wait_ms integer,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, provider_key)
);
CREATE INDEX IF NOT EXISTS rate_browse_job_provider_statuses_status_idx
  ON rate_browse_job_provider_statuses (job_id, status, updated_at DESC);
ALTER TABLE rate_browse_job_provider_statuses ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS worker_status_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  worker_service text,
  worker_pid integer,
  event_type text NOT NULL,
  job_name text,
  staleness_level text,
  details jsonb
);
CREATE INDEX IF NOT EXISTS worker_status_events_created_at_idx
  ON worker_status_events (created_at DESC);
ALTER TABLE worker_status_events ENABLE ROW LEVEL SECURITY;
