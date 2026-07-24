-- PS-465: canonical order hazmat declarations and immutable shipment snapshots.
-- Per user override unlock shipped data on 2026-07-25: additive sidecars only;
-- this migration does not backfill or mutate orders, shipments, or historical labels.

CREATE TABLE IF NOT EXISTS public.order_hazmat_declarations (
  order_id integer PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL DEFAULT 1,
  revision integer NOT NULL,
  status text NOT NULL,
  limited_quantity boolean,
  contains_battery boolean,
  dry_ice boolean,
  dry_ice_weight_value numeric(12, 4),
  dry_ice_weight_unit text,
  emergency_contact_name text,
  emergency_contact_phone text,
  usps_category text,
  usps_package_level boolean,
  regulated_content_type text,
  semantic_hash text NOT NULL,
  created_by_user_id text,
  created_by_email text,
  updated_by_user_id text,
  updated_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_hazmat_declarations_schema_version_chk CHECK (schema_version > 0),
  CONSTRAINT order_hazmat_declarations_revision_chk CHECK (revision > 0),
  CONSTRAINT order_hazmat_declarations_status_chk CHECK (status IN ('clear', 'active')),
  CONSTRAINT order_hazmat_declarations_semantic_hash_chk CHECK (semantic_hash ~ '^hz_[a-f0-9]{64}$'),
  CONSTRAINT order_hazmat_declarations_dry_ice_weight_chk CHECK (
    (dry_ice IS TRUE AND dry_ice_weight_value IS NOT NULL AND dry_ice_weight_value > 0 AND dry_ice_weight_unit IS NOT NULL)
    OR (dry_ice IS DISTINCT FROM TRUE AND dry_ice_weight_value IS NULL AND dry_ice_weight_unit IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS order_hazmat_declarations_status_idx
  ON public.order_hazmat_declarations (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.order_hazmat_materials (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES public.order_hazmat_declarations(order_id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  un_na_number text,
  proper_shipping_name text,
  technical_name text,
  hazard_class text,
  subsidiary_hazard_class text,
  packing_group text,
  amount numeric(12, 4),
  amount_unit text,
  quantity integer,
  packaging_instruction text,
  packaging_instruction_section text,
  packaging_type text,
  transport_mean text,
  transport_category text,
  regulation_authority text,
  regulation_level text,
  radioactive boolean,
  reportable_quantity boolean,
  additional_description text,
  CONSTRAINT order_hazmat_materials_sequence_chk CHECK (sequence > 0),
  CONSTRAINT order_hazmat_materials_quantity_chk CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT order_hazmat_materials_amount_chk CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT order_hazmat_materials_packing_group_chk CHECK (packing_group IS NULL OR packing_group IN ('i', 'ii', 'iii'))
);

CREATE UNIQUE INDEX IF NOT EXISTS order_hazmat_materials_order_sequence_unq
  ON public.order_hazmat_materials (order_id, sequence);

CREATE INDEX IF NOT EXISTS order_hazmat_materials_order_idx
  ON public.order_hazmat_materials (order_id);

CREATE TABLE IF NOT EXISTS public.shipment_hazmat_snapshots (
  shipment_id integer PRIMARY KEY REFERENCES public.shipments(id) ON DELETE RESTRICT,
  external_operation_id integer REFERENCES public.external_operations(id) ON DELETE RESTRICT,
  snapshot_schema_version smallint NOT NULL,
  order_declaration_revision integer NOT NULL,
  snapshot_hash text NOT NULL,
  summary_is_hazmat boolean NOT NULL,
  summary_profile text NOT NULL,
  snapshot_json jsonb NOT NULL,
  reviewed_by_user_id text,
  reviewed_by_email text,
  reviewed_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT now(),
  capture_kind text NOT NULL,
  CONSTRAINT shipment_hazmat_snapshots_schema_version_chk CHECK (snapshot_schema_version > 0),
  CONSTRAINT shipment_hazmat_snapshots_revision_chk CHECK (order_declaration_revision > 0),
  CONSTRAINT shipment_hazmat_snapshots_hash_chk CHECK (snapshot_hash ~ '^hz_[a-f0-9]{64}$'),
  CONSTRAINT shipment_hazmat_snapshots_active_chk CHECK (summary_is_hazmat IS TRUE),
  CONSTRAINT shipment_hazmat_snapshots_profile_chk CHECK (
    summary_profile IN (
      'shipstation_usps',
      'shipstation_ups_dry_ice',
      'shipstation_ups_dangerous_goods',
      'ups_direct',
      'walmart'
    )
  ),
  CONSTRAINT shipment_hazmat_snapshots_capture_kind_chk CHECK (capture_kind IN ('provider_purchase', 'test_label'))
);

CREATE INDEX IF NOT EXISTS shipment_hazmat_snapshots_operation_idx
  ON public.shipment_hazmat_snapshots (external_operation_id);

CREATE INDEX IF NOT EXISTS shipment_hazmat_snapshots_profile_idx
  ON public.shipment_hazmat_snapshots (summary_profile, captured_at DESC);

CREATE OR REPLACE FUNCTION public.shipment_hazmat_snapshots_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shipment_hazmat_snapshots is append-only';
END;
$$;

DROP TRIGGER IF EXISTS shipment_hazmat_snapshots_no_update_delete
  ON public.shipment_hazmat_snapshots;
CREATE TRIGGER shipment_hazmat_snapshots_no_update_delete
  BEFORE UPDATE OR DELETE ON public.shipment_hazmat_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.shipment_hazmat_snapshots_block_mutations();

DROP TRIGGER IF EXISTS shipment_hazmat_snapshots_no_truncate
  ON public.shipment_hazmat_snapshots;
CREATE TRIGGER shipment_hazmat_snapshots_no_truncate
  BEFORE TRUNCATE ON public.shipment_hazmat_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.shipment_hazmat_snapshots_block_mutations();
