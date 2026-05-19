import type { CredentialAccountTable, SqlLike } from './credential-accounts';

const ensuredTables = new Set<CredentialAccountTable>();
let legacyStoreRowsMigrated = false;

const CARRIER_ACCOUNT_RELATIONS = [
  'carrier_accounts',
  'carrier_accounts_client_provider_account_idx',
  'carrier_account_clients',
  'carrier_account_clients_pkey',
  'carrier_account_clients_client_idx',
];

const STORE_ACCOUNT_RELATIONS = [
  'store_accounts',
  'store_accounts_client_provider_account_idx',
];

const CARRIER_ACCOUNT_CONSTRAINTS = [
  'carrier_account_clients_account_fk',
];

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

  const requiredRelations = table === 'carrier_accounts'
    ? CARRIER_ACCOUNT_RELATIONS
    : STORE_ACCOUNT_RELATIONS;

  const values = requiredRelations.map((relation) => `('${relation}')`).join(', ');
  const missing = (await sql.unsafe(`
    SELECT relation_name
    FROM (VALUES ${values}) AS expected(relation_name)
    WHERE to_regclass('public.' || relation_name) IS NULL
    ORDER BY relation_name
  `)) as Array<{ relation_name: string }>;

  if (missing.length > 0) {
    const names = missing.map((row) => row.relation_name).join(', ');
    throw new Error(
      `${table}: credential account migrations are missing relations: ${names}. ` +
        'Run drizzle/0015_amusing_namorita.sql, drizzle/0027_credential_accounts_source_of_truth.sql, ' +
        'and drizzle/0031_credential_accounts_rls.sql before using credential account routes.',
    );
  }

  if (table === 'carrier_accounts') {
    const constraintValues = CARRIER_ACCOUNT_CONSTRAINTS
      .map((constraint) => `('${constraint}')`)
      .join(', ');
    const missingConstraints = (await sql.unsafe(`
      SELECT constraint_name
      FROM (VALUES ${constraintValues}) AS expected(constraint_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND c.conname = expected.constraint_name
      )
      ORDER BY constraint_name
    `)) as Array<{ constraint_name: string }>;

    if (missingConstraints.length > 0) {
      const names = missingConstraints.map((row) => row.constraint_name).join(', ');
      throw new Error(
        `${table}: credential account migrations are missing constraints: ${names}. ` +
          'Run drizzle/0027_credential_accounts_source_of_truth.sql before using credential account routes.',
      );
    }
  }

  const rlsTables = table === 'carrier_accounts'
    ? ['carrier_accounts', 'carrier_account_clients']
    : ['store_accounts'];
  const rlsValues = rlsTables.map((relation) => `('${relation}')`).join(', ');
  const insecure = (await sql.unsafe(`
    SELECT table_name
    FROM (VALUES ${rlsValues}) AS expected(table_name)
    JOIN pg_class c ON c.oid = ('public.' || expected.table_name)::regclass
    WHERE c.relrowsecurity IS NOT TRUE
    ORDER BY table_name
  `)) as Array<{ table_name: string }>;

  if (insecure.length > 0) {
    const names = insecure.map((row) => row.table_name).join(', ');
    console.warn(
      `${table}: credential account tables are missing row-level security: ${names}. ` +
        'Run drizzle/0031_credential_accounts_rls.sql before using credential account routes.',
    );
  }

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
