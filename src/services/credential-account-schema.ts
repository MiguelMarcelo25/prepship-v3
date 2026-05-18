import type { CredentialAccountTable, SqlLike } from './credential-accounts';

const ensuredTables = new Set<CredentialAccountTable>();
let legacyStoreRowsMigrated = false;

async function runStatements(
  sql: SqlLike,
  label: string,
  statements: string[],
): Promise<void> {
  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt);
    } catch (err) {
      console.warn(
        `[${label}] runtime schema fallback statement failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function ensureCredentialAccountRuntimeSchema(
  sql: SqlLike,
  table: CredentialAccountTable,
): Promise<void> {
  if (ensuredTables.has(table)) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${table} (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      provider TEXT NOT NULL,
      label TEXT,
      account_identifier TEXT,
      credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'admin',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_client_provider_account_idx
      ON ${table} (
        COALESCE(client_id, -1),
        provider,
        COALESCE(account_identifier, '')
      )`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  ];

  if (table === 'carrier_accounts') {
    statements.push(
      `CREATE TABLE IF NOT EXISTS carrier_account_clients (
        carrier_account_id INTEGER NOT NULL,
        client_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (carrier_account_id, client_id),
        CONSTRAINT carrier_account_clients_account_fk
          FOREIGN KEY (carrier_account_id) REFERENCES carrier_accounts(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS carrier_account_clients_client_idx
        ON carrier_account_clients(client_id)`,
      `ALTER TABLE carrier_account_clients ENABLE ROW LEVEL SECURITY`,
    );
  }

  await runStatements(sql, `${table}:schema`, statements);
  ensuredTables.add(table);
}

export async function migrateLegacyStoreCredentialRows(sql: SqlLike): Promise<void> {
  if (legacyStoreRowsMigrated) return;
  await runStatements(sql, 'store-accounts:migration', [
    `INSERT INTO store_accounts (id, client_id, provider, label, account_identifier,
                          credentials, source, active, created_at, updated_at)
      SELECT id, client_id, provider, label, account_identifier,
            credentials, source, active, created_at, updated_at
      FROM carrier_accounts
      WHERE provider IN (
        'walmart','amazon','amazon_shipping','ebay','shopify','etsy',
        'tiktok_shop','woocommerce','bigcommerce'
      )
      ON CONFLICT (
        COALESCE(client_id, -1), provider, COALESCE(account_identifier, '')
      ) DO NOTHING`,
    `DELETE FROM carrier_accounts
      WHERE provider IN (
        'walmart','amazon','amazon_shipping','ebay','shopify','etsy',
        'tiktok_shop','woocommerce','bigcommerce'
      )`,
    `SELECT setval('store_accounts_id_seq',
      GREATEST(COALESCE((SELECT MAX(id) FROM store_accounts), 0) + 1, 1),
      false)`,
  ]);
  legacyStoreRowsMigrated = true;
}
