ALTER TABLE store_accounts
  ADD COLUMN IF NOT EXISTS sync_anchor_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_cursor_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

CREATE INDEX IF NOT EXISTS store_accounts_shopify_sync_idx
  ON store_accounts (provider, source, active, sync_cursor_at)
  WHERE provider = 'shopify';
