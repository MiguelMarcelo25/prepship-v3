-- PS-487 AC-4/AC-7 — admin-corrected return billing date.
--
-- Additive and nullable. NULL means "no correction", and the billing contract falls
-- back to returns.created_at, so every existing row keeps its current behaviour and no
-- backfill is required.
--
-- The original system-creation timestamp is deliberately NOT touched: AC-7 requires it
-- as audit evidence alongside the corrected day, so a correction must never overwrite
-- the record of when the return actually entered the system.
ALTER TABLE "returns"
  ADD COLUMN IF NOT EXISTS "billing_date_override" timestamp with time zone;
--> statement-breakpoint
-- Who corrected it and why. AC-7 also wants the DJ approval reference when the affected
-- period was finalized; that rides in the return_activity_events detail payload, which
-- already exists and is append-only.
ALTER TABLE "returns"
  ADD COLUMN IF NOT EXISTS "billing_date_override_by" text;
--> statement-breakpoint
ALTER TABLE "returns"
  ADD COLUMN IF NOT EXISTS "billing_date_override_reason" text;
