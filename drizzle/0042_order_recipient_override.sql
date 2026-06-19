ALTER TABLE public.order_overrides
ADD COLUMN IF NOT EXISTS recipient_override jsonb;
