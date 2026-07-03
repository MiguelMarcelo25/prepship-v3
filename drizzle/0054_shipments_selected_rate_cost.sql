-- PS-370 Phase 1: one canonical selected/label shipping cost.
-- Additive, nullable column so TS (billing) and SQL (HUGRAB floor) read the
-- SAME persisted total instead of each re-deriving postage + other. NULL means
-- un-backfilled: every reader keeps its existing fallback, so this is byte-
-- neutral until the DJ-gated Phase-2 backfill. Additive schema change to a
-- lockdown table (read/type addition) — no shipped-row mutation.
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "selected_rate_cost" numeric(10, 2);
