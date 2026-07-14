-- Audit 3.4: credential table cutover is deployment work, never request work.
-- Idempotent for databases where the legacy handler already moved these rows.

INSERT INTO store_accounts (
  id, client_id, provider, label, account_identifier,
  credentials, source, active, created_at, updated_at
)
SELECT
  id, client_id, provider, label, account_identifier,
  credentials, source, active, created_at, updated_at
FROM carrier_accounts
WHERE provider IN (
  'walmart', 'amazon', 'amazon_shipping', 'ebay', 'shopify',
  'etsy', 'tiktok_shop', 'woocommerce', 'bigcommerce'
)
ON CONFLICT (
  COALESCE(client_id, -1), provider, COALESCE(account_identifier, '')
) DO NOTHING;

DELETE FROM carrier_accounts
WHERE provider IN (
  'walmart', 'amazon', 'amazon_shipping', 'ebay', 'shopify',
  'etsy', 'tiktok_shop', 'woocommerce', 'bigcommerce'
);

SELECT setval(
  'store_accounts_id_seq',
  GREATEST(COALESCE((SELECT MAX(id) FROM store_accounts), 0) + 1, 1),
  false
);
