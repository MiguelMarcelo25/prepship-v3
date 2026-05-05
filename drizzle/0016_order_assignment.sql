-- Order assignment columns. Admin assigns an awaiting order to a worker
-- user; workers see only their own assigned orders. user_id is the Supabase
-- auth UUID; email is mirrored for display + audit.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "assigned_to_user_id" text,
  ADD COLUMN IF NOT EXISTS "assigned_to_email"   text,
  ADD COLUMN IF NOT EXISTS "assigned_at"         timestamp with time zone;

CREATE INDEX IF NOT EXISTS "orders_assigned_user_idx"
  ON "orders" ("assigned_to_user_id");
