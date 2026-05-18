ALTER TABLE "rate_cache"
ADD COLUMN IF NOT EXISTS "diagnostics" jsonb DEFAULT '[]'::jsonb;
