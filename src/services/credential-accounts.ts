import type { CredentialAccountBody } from '../lib/credential-accounts';

export type CredentialAccountTable = 'carrier_accounts' | 'store_accounts';

export type SqlLike = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  (identifier: string): unknown;
  unsafe: (query: string) => Promise<unknown>;
  begin: (fn: (trx: SqlLike) => Promise<void>) => Promise<void>;
};

export type CredentialAccountRow = Record<string, unknown>;

export type CredentialAccountListOptions = {
  source?: string | null;
  includeAssignments?: boolean;
  limit?: number;
};

export type CarrierAssignmentResult = {
  id: number;
  assignedClientIds: number[];
  promotedFromPortal?: boolean;
  source?: string;
};

export type CredentialAccountSnapshot = {
  label: string | null;
  source: string;
};

export type CredentialAccountPatchInput = {
  hasSource: boolean;
  source: string | null;
  hasLabel: boolean;
  label: string | null;
  labelGoesNull: boolean;
  hasCredentials?: boolean;
  credentials?: Record<string, unknown> | null;
};

const SYNTHETIC_STORE_OFFSETS: Record<string, number> = {
  walmart: 9_000_000,
  amazon: 9_100_000,
  shopify: 9_200_000,
  etsy: 9_300_000,
  tiktok_shop: 9_400_000,
  ebay: 9_500_000,
  woocommerce: 9_600_000,
  bigcommerce: 9_700_000,
};

const STORE_PROVIDER_LABELS: Record<string, string> = {
  walmart: 'Walmart Marketplace',
  amazon: 'Amazon Marketplace',
  ebay: 'eBay',
  shopify: 'Shopify',
  etsy: 'Etsy',
  tiktok_shop: 'TikTok Shop',
  woocommerce: 'WooCommerce',
  bigcommerce: 'BigCommerce',
};

export function normalizeAssignedClientIds(body: Record<string, unknown>): number[] {
  const rawIds = Array.isArray(body?.clientIds) ? body.clientIds : [];
  return Array.from(
    new Set(
      rawIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

export function syntheticStoreIdForCredentialAccount(provider: string, accountId: number): number {
  const offset = SYNTHETIC_STORE_OFFSETS[provider] ?? 9_900_000;
  return offset + accountId;
}

export async function listCredentialAccounts(
  sql: SqlLike,
  table: CredentialAccountTable,
  options: CredentialAccountListOptions = {},
): Promise<CredentialAccountRow[]> {
  const limit = Number.isFinite(options.limit) && options.limit && options.limit > 0
    ? options.limit
    : 200;

  if (options.includeAssignments) {
    if (options.source) {
      return (await sql`
        SELECT
          ca.id, ca.client_id AS "clientId", ca.provider, ca.label,
          ca.account_identifier AS "accountIdentifier",
          ca.source, ca.active, ca.created_at AS "createdAt",
          COALESCE(
            (
              SELECT array_agg(cac.client_id ORDER BY cac.client_id)
              FROM carrier_account_clients cac
              WHERE cac.carrier_account_id = ca.id
            ),
            '{}'::int[]
          ) AS "assignedClientIds"
        FROM ${sql(table)} ca
        WHERE ca.source = ${options.source}
        ORDER BY ca.created_at DESC
        LIMIT ${limit}
      `) as CredentialAccountRow[];
    }

    return (await sql`
      SELECT
        ca.id, ca.client_id AS "clientId", ca.provider, ca.label,
        ca.account_identifier AS "accountIdentifier",
        ca.source, ca.active, ca.created_at AS "createdAt",
        COALESCE(
          (
            SELECT array_agg(cac.client_id ORDER BY cac.client_id)
            FROM carrier_account_clients cac
            WHERE cac.carrier_account_id = ca.id
          ),
          '{}'::int[]
        ) AS "assignedClientIds"
      FROM ${sql(table)} ca
      ORDER BY ca.created_at DESC
      LIMIT ${limit}
    `) as CredentialAccountRow[];
  }

  if (options.source) {
    return (await sql`
      SELECT id, client_id AS "clientId", provider, label,
             account_identifier AS "accountIdentifier",
             source, active, created_at AS "createdAt"
      FROM ${sql(table)}
      WHERE source = ${options.source}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as CredentialAccountRow[];
  }

  return (await sql`
    SELECT id, client_id AS "clientId", provider, label,
           account_identifier AS "accountIdentifier",
           source, active, created_at AS "createdAt"
    FROM ${sql(table)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as CredentialAccountRow[];
}

export async function upsertCredentialAccount(
  sql: SqlLike,
  table: CredentialAccountTable,
  account: CredentialAccountBody,
): Promise<CredentialAccountRow | null> {
  const rows = (await sql`
    INSERT INTO ${sql(table)} (client_id, provider, label, account_identifier, credentials, source)
    VALUES (
      ${account.clientId},
      ${account.provider},
      ${account.label},
      ${account.accountIdentifier},
      ${account.credentials},
      ${account.source}
    )
    ON CONFLICT (COALESCE(client_id, -1), provider, COALESCE(account_identifier, ''))
    DO UPDATE SET
      label = EXCLUDED.label,
      credentials = EXCLUDED.credentials,
      updated_at = NOW()
    RETURNING id, client_id AS "clientId", provider, label,
              account_identifier AS "accountIdentifier",
              source, active, created_at AS "createdAt"
  `) as CredentialAccountRow[];

  return rows[0] ?? null;
}

export async function getCredentialAccountStoredCredentialKeys(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number | null | undefined,
): Promise<string[]> {
  if (id == null || !Number.isFinite(id)) return [];

  const rows = (await sql`
    SELECT credentials FROM ${sql(table)} WHERE id = ${id}
  `) as Array<{ credentials: unknown }>;

  const stored = rows[0]?.credentials;
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? Object.keys(stored as Record<string, unknown>).sort()
    : [];
}

export async function getCredentialAccountProvider(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number,
): Promise<string | null> {
  const rows = (await sql`
    SELECT provider FROM ${sql(table)} WHERE id = ${id} LIMIT 1
  `) as Array<{ provider: string }>;
  return rows[0]?.provider ?? null;
}

export async function deleteCredentialAccount(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number,
): Promise<number | null> {
  const rows = (await sql`
    DELETE FROM ${sql(table)}
    WHERE id = ${id}
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

export async function getCredentialAccountSnapshot(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number,
): Promise<CredentialAccountSnapshot | null> {
  const rows = (await sql`
    SELECT label, source FROM ${sql(table)} WHERE id = ${id} LIMIT 1
  `) as CredentialAccountSnapshot[];
  return rows[0] ?? null;
}

export async function patchCredentialAccount(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number,
  patch: CredentialAccountPatchInput,
): Promise<CredentialAccountRow | null> {
  let row: CredentialAccountRow | null = null;

  // Credentials merge ("Reconnect"): shallow-merge the supplied keys over the
  // stored JSONB (|| operator), so unspecified fields (apiKey/email) survive
  // when only the password is re-entered. Runs first so a combined patch still
  // returns the post-update row from the source/label branches below.
  if (patch.hasCredentials && patch.credentials && Object.keys(patch.credentials).length > 0) {
    const mergeJson = JSON.stringify(patch.credentials);
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET credentials = COALESCE(credentials, '{}'::jsonb) || ${mergeJson}::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    row = rows[0] ?? null;
  }

  if (patch.hasSource && patch.hasLabel) {
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET source = ${patch.source},
          label = ${patch.labelGoesNull ? null : patch.label},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return rows[0] ?? row;
  }

  if (patch.hasSource) {
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET source = ${patch.source}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return rows[0] ?? row;
  }

  if (patch.hasLabel) {
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET label = ${patch.labelGoesNull ? null : patch.label}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return rows[0] ?? row;
  }

  return row;
}

export async function replaceCarrierAccountClientAssignments(
  sql: SqlLike,
  id: number,
  clientIds: number[],
  options: { promotePortal?: boolean } = {},
): Promise<CarrierAssignmentResult | null> {
  const existsRows = (await sql`
    SELECT id, source FROM ${sql('carrier_accounts')} WHERE id = ${id} LIMIT 1
  `) as Array<{ id: number; source: string }>;

  if (existsRows.length === 0) return null;

  const currentSource = existsRows[0]?.source ?? 'admin';
  const wasPortal = currentSource === 'portal';

  await sql.begin(async (trx) => {
    await trx`DELETE FROM carrier_account_clients WHERE carrier_account_id = ${id}`;
    if (clientIds.length > 0) {
      await trx`
        INSERT INTO carrier_account_clients (carrier_account_id, client_id)
        SELECT ${id}, unnest(${clientIds}::int[])
        ON CONFLICT (carrier_account_id, client_id) DO NOTHING
      `;
    }

    if (options.promotePortal) {
      await trx`
        UPDATE ${trx('carrier_accounts')} SET source = 'admin', updated_at = NOW()
        WHERE id = ${id} AND source = 'portal'
      `;
    }
  });

  const refreshed = (await sql`
    SELECT client_id FROM carrier_account_clients
    WHERE carrier_account_id = ${id}
    ORDER BY client_id
  `) as Array<{ client_id: number }>;

  return {
    id,
    assignedClientIds: refreshed.map((row) => row.client_id),
    promotedFromPortal: options.promotePortal ? wasPortal : undefined,
    source: options.promotePortal && wasPortal ? 'admin' : currentSource,
  };
}

export async function ensureSyntheticStoreClient(
  sql: SqlLike,
  account: { provider: string; accountId: number; label: string | null },
): Promise<{ syntheticStoreId: number; clientName: string; created: boolean } | null> {
  const syntheticStoreId = syntheticStoreIdForCredentialAccount(account.provider, account.accountId);

  const existing = (await sql`
    SELECT id FROM clients
    WHERE store_ids @> ARRAY[${syntheticStoreId}]::integer[]
    LIMIT 1
  `) as Array<{ id: number }>;

  if (existing.length > 0) {
    return null;
  }

  const baseName = STORE_PROVIDER_LABELS[account.provider] ?? account.provider.toUpperCase();
  const labelMatchesProvider =
    account.label != null && new RegExp(account.provider, 'i').test(account.label);
  const clientName =
    account.label && !labelMatchesProvider ? `${baseName} - ${account.label}` : account.label || baseName;

  await sql`
    INSERT INTO clients (name, store_ids, active, is_test)
    VALUES (${clientName}, ARRAY[${syntheticStoreId}]::integer[], true, false)
  `;

  return { syntheticStoreId, clientName, created: true };
}

export async function deleteSyntheticStoreClientForAccount(
  sql: SqlLike,
  account: { provider: string; accountId: number },
): Promise<number | null> {
  const syntheticStoreId = syntheticStoreIdForCredentialAccount(account.provider, account.accountId);
  const rows = (await sql`
    DELETE FROM clients
    WHERE store_ids = ARRAY[${syntheticStoreId}]::integer[]
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}
