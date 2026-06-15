-- PS-276 (slice 2): additive per-address residential/commercial validation cache.
-- Mirrors src/services/shipping-workflow/address-classification-cache.ts
-- ensureAddressClassificationsSchema() so the worker + API both work pre-migration
-- (same runtime-ensure pattern as 0042_shipment_tracking_status / 0044_audit_log).
-- Additive only: no shipped/cancelled data, no shipments writes, no column drops.
CREATE TABLE IF NOT EXISTS address_classifications (
  address_key text PRIMARY KEY,
  business boolean,
  provider_classification text,
  provider text,
  dpv_confirmation text,
  zip_plus4 text,
  carrier_route text,
  raw jsonb,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS address_classifications_expires_idx ON address_classifications (expires_at);

-- Backend connects as the postgres owner (bypasses RLS); enabling RLS with no policy
-- keeps the Supabase Data API locked out by default (project_supabase_rls_model).
ALTER TABLE address_classifications ENABLE ROW LEVEL SECURITY;
