-- ============================================================================
-- 0039 — Covering indexes for app foreign keys (advisor: Unindexed foreign keys)
-- ============================================================================
-- Two app-owned FKs had no covering index, so the advisor flags them: joins and
-- ON DELETE/UPDATE checks on the parent (packages) must seq-scan the child.
--
--   billing_line_items.package_id            -> packages(id)
--   client_combo_package_defaults.package_id -> packages(id)
--
-- Created CONCURRENTLY + IF NOT EXISTS so the build does not block writes and is
-- safe to re-run. CONCURRENTLY cannot run inside a transaction block.
--
-- (The pgboss.* unindexed-FK advisories are intentionally left to the pg-boss
-- library; orders/shipments FKs are already covered and under the code lockdown.)
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_line_items_package_id_idx
  ON public.billing_line_items (package_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS client_combo_package_defaults_package_id_idx
  ON public.client_combo_package_defaults (package_id);
