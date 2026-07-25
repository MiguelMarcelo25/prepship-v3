-- PS-466: backend-owned, versioned Automations engine.
-- 0078 is reserved by the prerequisite PS-465 branch; PS-466 cannot merge ahead
-- of that dependency, so this forward-only migration intentionally uses 0079.

CREATE TABLE IF NOT EXISTS automation_rules (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  client_id integer REFERENCES clients(id) ON DELETE RESTRICT,
  store_id integer,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  trigger text NOT NULL CHECK (trigger IN (
    'order_imported', 'order_facts_updated', 'order_items_changed', 'address_changed',
    'before_rate', 'before_label_purchase', 'manual_reprocess'
  )),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  active_version_id integer,
  active_from timestamptz,
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  system_locked boolean NOT NULL DEFAULT false,
  provenance text NOT NULL DEFAULT 'operator' CHECK (provenance IN ('operator', 'legacy_import', 'system')),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS automation_rule_versions (
  id serial PRIMARY KEY,
  rule_id integer NOT NULL REFERENCES automation_rules(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'published', 'superseded')),
  document jsonb NOT NULL,
  document_hash text NOT NULL CHECK (length(document_hash) = 64),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  simulation_hash text,
  simulation_run_id bigint,
  created_by text NOT NULL,
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT automation_versions_rule_number_unq UNIQUE (rule_id, version_number),
  CONSTRAINT automation_versions_publish_evidence_chk CHECK (
    lifecycle <> 'published'
    OR (
      published_at IS NOT NULL
      AND published_by IS NOT NULL
      AND simulation_hash IS NOT NULL
      AND simulation_hash = document_hash
    )
  )
);

ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES automation_rule_versions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS automation_rule_conditions (
  id bigserial PRIMARY KEY,
  rule_version_id integer NOT NULL REFERENCES automation_rule_versions(id) ON DELETE CASCADE,
  parent_condition_id bigint REFERENCES automation_rule_conditions(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  node_kind text NOT NULL CHECK (node_kind IN ('group', 'predicate', 'line_any', 'line_all', 'line_none')),
  group_operator text CHECK (group_operator IN ('all', 'any', 'not')),
  field_key text,
  operator text,
  typed_value jsonb,
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 3)
);

CREATE TABLE IF NOT EXISTS automation_rule_actions (
  id bigserial PRIMARY KEY,
  rule_version_id integer NOT NULL REFERENCES automation_rule_versions(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  action_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  config jsonb NOT NULL,
  action_class text NOT NULL CHECK (action_class IN ('accumulative', 'restrictive', 'minimum', 'scalar', 'eligibility')),
  risk_class text NOT NULL CHECK (risk_class IN ('low', 'medium', 'high')),
  invalidates_rate_proof boolean NOT NULL DEFAULT false,
  CONSTRAINT automation_actions_version_position_unq UNIQUE (rule_version_id, position)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id bigserial PRIMARY KEY,
  execution_key text NOT NULL,
  order_id integer REFERENCES orders(id) ON DELETE RESTRICT,
  rule_id integer REFERENCES automation_rules(id) ON DELETE RESTRICT,
  trigger text NOT NULL,
  source_event_id text NOT NULL,
  facts_revision text NOT NULL,
  ruleset_digest text NOT NULL CHECK (length(ruleset_digest) = 64),
  engine_version text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('simulate', 'apply', 'audit_only')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'blocked', 'conflict', 'failed')),
  matched_rule_version_ids integer[] NOT NULL DEFAULT '{}',
  trace jsonb,
  trace_hash text NOT NULL CHECK (length(trace_hash) = 64),
  error_code text,
  error_summary text,
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT automation_runs_execution_unq UNIQUE (
    order_id, facts_revision, trigger, source_event_id, ruleset_digest, engine_version, mode
  ),
  CONSTRAINT automation_runs_execution_key_unq UNIQUE (execution_key)
);

CREATE TABLE IF NOT EXISTS automation_action_results (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES automation_runs(id) ON DELETE RESTRICT,
  rule_version_id integer NOT NULL REFERENCES automation_rule_versions(id) ON DELETE RESTRICT,
  action_index integer NOT NULL CHECK (action_index >= 0),
  action_type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'applied', 'skipped', 'conflict', 'failed', 'audit_only')),
  target_type text,
  target_id text,
  before_summary jsonb,
  after_summary jsonb,
  reason text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_automation_state (
  order_id integer PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  facts_revision text NOT NULL,
  ruleset_digest text NOT NULL CHECK (length(ruleset_digest) = 64),
  engine_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'current', 'blocked', 'conflict', 'failed', 'audit_only')),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_id bigint REFERENCES automation_runs(id) ON DELETE SET NULL,
  failure_code text,
  evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_outbox (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS automation_reprocess_jobs (
  id bigserial PRIMARY KEY,
  rule_id integer NOT NULL REFERENCES automation_rules(id) ON DELETE RESTRICT,
  rule_version_id integer NOT NULL REFERENCES automation_rule_versions(id) ON DELETE RESTRICT,
  preview_run_id bigint REFERENCES automation_runs(id) ON DELETE RESTRICT,
  scope jsonb NOT NULL,
  preview_hash text NOT NULL CHECK (length(preview_hash) = 64),
  status text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'confirmed', 'running', 'completed', 'failed', 'cancelled')),
  requested_by text NOT NULL,
  confirmed_by text,
  total_orders integer NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  processed_orders integer NOT NULL DEFAULT 0 CHECK (processed_orders >= 0),
  failed_orders integer NOT NULL DEFAULT 0 CHECK (failed_orders >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS automation_rules_scope_status_idx
  ON automation_rules (client_id, store_id, status, priority, position);
CREATE INDEX IF NOT EXISTS automation_rules_active_version_idx
  ON automation_rules (active_version_id) WHERE active_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_rules_activation_idx
  ON automation_rules (status, active_from, client_id, store_id);
CREATE INDEX IF NOT EXISTS automation_versions_rule_lifecycle_idx
  ON automation_rule_versions (rule_id, lifecycle, version_number DESC);
CREATE INDEX IF NOT EXISTS automation_conditions_version_parent_idx
  ON automation_rule_conditions (rule_version_id, parent_condition_id, position);
CREATE INDEX IF NOT EXISTS automation_actions_version_idx
  ON automation_rule_actions (rule_version_id, position);
CREATE INDEX IF NOT EXISTS automation_runs_order_trigger_idx
  ON automation_runs (order_id, trigger, started_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_rule_status_idx
  ON automation_runs (rule_id, status, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_execution_key_idx
  ON automation_runs (execution_key);
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_idempotency_unq
  ON automation_action_results (idempotency_key);
CREATE INDEX IF NOT EXISTS automation_action_results_run_idx
  ON automation_action_results (run_id, action_index);
CREATE INDEX IF NOT EXISTS order_automation_state_status_idx
  ON order_automation_state (status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS automation_outbox_event_key_unq
  ON automation_outbox (event_key);
CREATE INDEX IF NOT EXISTS automation_outbox_ready_idx
  ON automation_outbox (status, available_at, id) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS automation_reprocess_jobs_status_idx
  ON automation_reprocess_jobs (status, created_at);

-- Per user override unlock shipped data on 2026-07-25: terminal order status
-- changes may enqueue audit-only automation evidence, but the trigger never
-- rewrites orders/shipments and runtime handlers remain awaiting-only.
-- Durable canonical fact events. Provider adapters and React never decide when
-- a rule runs; committed order/item/packing fact changes enter one outbox.
CREATE OR REPLACE FUNCTION enqueue_automation_order_fact_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order_id integer;
  event_trigger text;
  emitted_event_key text;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    event_trigger := CASE WHEN TG_OP = 'INSERT' THEN 'order_imported' ELSE 'order_facts_updated' END;
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    target_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
    event_trigger := 'order_items_changed';
  ELSE
    target_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
    event_trigger := 'address_changed';
  END IF;
  emitted_event_key := concat('automation-facts:', TG_TABLE_NAME, ':', target_order_id, ':', txid_current(), ':', event_trigger);
  INSERT INTO automation_outbox(event_key, event_type, aggregate_type, aggregate_id, payload)
  VALUES (
    emitted_event_key,
    'order_facts_changed',
    'order',
    target_order_id::text,
    jsonb_build_object('orderId', target_order_id, 'trigger', event_trigger, 'sourceEventId', emitted_event_key)
  )
  ON CONFLICT (event_key) DO NOTHING;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS automation_orders_fact_event ON orders;
CREATE TRIGGER automation_orders_fact_event
  AFTER INSERT OR UPDATE OF client_id, store_id, source_provider, order_status,
    order_total, shipping_amount, ship_to_state, ship_to_postal_code, weight_oz
  ON orders FOR EACH ROW EXECUTE FUNCTION enqueue_automation_order_fact_event();

DROP TRIGGER IF EXISTS automation_order_items_fact_event ON order_items;
CREATE TRIGGER automation_order_items_fact_event
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION enqueue_automation_order_fact_event();

DROP TRIGGER IF EXISTS automation_order_overrides_fact_event ON order_overrides;
CREATE TRIGGER automation_order_overrides_fact_event
  AFTER INSERT OR DELETE OR UPDATE OF residential, rate_weight_oz, rate_dims_l,
    rate_dims_w, rate_dims_h, selected_package_id, recipient_override
  ON order_overrides FOR EACH ROW EXECUTE FUNCTION enqueue_automation_order_fact_event();

CREATE OR REPLACE FUNCTION automation_rule_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle = 'published' THEN
    RAISE EXCEPTION 'published automation rule versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_rule_versions_immutable_guard ON automation_rule_versions;
CREATE TRIGGER automation_rule_versions_immutable_guard
  BEFORE UPDATE OR DELETE ON automation_rule_versions
  FOR EACH ROW EXECUTE FUNCTION automation_rule_version_immutable();

CREATE OR REPLACE FUNCTION automation_rule_version_child_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_version_id integer;
  parent_lifecycle text;
BEGIN
  parent_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.rule_version_id ELSE NEW.rule_version_id END;
  SELECT lifecycle INTO parent_lifecycle FROM automation_rule_versions WHERE id = parent_version_id;
  IF parent_lifecycle = 'published' THEN
    RAISE EXCEPTION 'published automation rule version children are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_rule_conditions_immutable_guard ON automation_rule_conditions;
CREATE TRIGGER automation_rule_conditions_immutable_guard
  BEFORE INSERT OR UPDATE OR DELETE ON automation_rule_conditions
  FOR EACH ROW EXECUTE FUNCTION automation_rule_version_child_immutable();

DROP TRIGGER IF EXISTS automation_rule_actions_immutable_guard ON automation_rule_actions;
CREATE TRIGGER automation_rule_actions_immutable_guard
  BEFORE INSERT OR UPDATE OR DELETE ON automation_rule_actions
  FOR EACH ROW EXECUTE FUNCTION automation_rule_version_child_immutable();
