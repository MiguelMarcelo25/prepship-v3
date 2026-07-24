import type { CredentialAccountBody } from '../lib/credential-accounts';
import type postgres from 'postgres';
import {
  isStoreScopedCarrierProvider,
  toSafeCarrierAccountReadModel,
  type StoreAccountIdentity,
} from './carrier-account-identity';

export type CredentialAccountTable = 'carrier_accounts' | 'store_accounts';

export type SqlLike = postgres.Sql;

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
  hasActive?: boolean;
  active?: boolean | null;
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

async function safeCredentialAccountRows(
  sql: SqlLike,
  table: CredentialAccountTable,
  rows: CredentialAccountRow[],
): Promise<CredentialAccountRow[]> {
  const needsStoreIdentity = rows.some((row) => isStoreScopedCarrierProvider(row.provider));
  const storeRows = needsStoreIdentity
    ? (await sql`
        SELECT id, client_id AS "clientId", provider, label,
               account_identifier AS "accountIdentifier", credentials, active
        FROM ${sql('store_accounts')}
        WHERE active = true
      `) as Array<StoreAccountIdentity & Record<string, unknown>>
    : [];
  return rows.map((row) => toSafeCarrierAccountReadModel(
    row as StoreAccountIdentity & Record<string, unknown>,
    storeRows,
  ));
}

export async function safeCredentialAccountRow(
  sql: SqlLike,
  table: CredentialAccountTable,
  row: CredentialAccountRow | null,
): Promise<CredentialAccountRow | null> {
  if (!row) return null;
  return (await safeCredentialAccountRows(sql, table, [row]))[0] ?? null;
}

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
      const rows = (await sql`
        SELECT
          ca.id, ca.client_id AS "clientId", ca.provider, ca.label,
          ca.account_identifier AS "accountIdentifier",
          ca.credentials, ca.source, ca.active, ca.created_at AS "createdAt",
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
      return safeCredentialAccountRows(sql, table, rows);
    }

    const rows = (await sql`
      SELECT
        ca.id, ca.client_id AS "clientId", ca.provider, ca.label,
        ca.account_identifier AS "accountIdentifier",
        ca.credentials, ca.source, ca.active, ca.created_at AS "createdAt",
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
    return safeCredentialAccountRows(sql, table, rows);
  }

  if (options.source) {
    const rows = (await sql`
      SELECT id, client_id AS "clientId", provider, label,
             account_identifier AS "accountIdentifier",
             credentials, source, active, created_at AS "createdAt"
      FROM ${sql(table)}
      WHERE source = ${options.source}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as CredentialAccountRow[];
    return safeCredentialAccountRows(sql, table, rows);
  }

  const rows = (await sql`
    SELECT id, client_id AS "clientId", provider, label,
           account_identifier AS "accountIdentifier",
           credentials, source, active, created_at AS "createdAt"
    FROM ${sql(table)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as CredentialAccountRow[];
  return safeCredentialAccountRows(sql, table, rows);
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
      ${sql.json(account.credentials as postgres.JSONValue)},
      ${account.source}
    )
    ON CONFLICT (COALESCE(client_id, -1), provider, COALESCE(account_identifier, ''))
    DO UPDATE SET
      label = EXCLUDED.label,
      credentials = EXCLUDED.credentials,
      updated_at = NOW()
    RETURNING id, client_id AS "clientId", provider, label,
              account_identifier AS "accountIdentifier",
              credentials, source, active, created_at AS "createdAt"
  `) as CredentialAccountRow[];

  return safeCredentialAccountRow(sql, table, rows[0] ?? null);
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

/**
 * PS-163: backfill the awaiting-order rate snapshot when a carrier account's display label is renamed.
 * AWAITING ORDERS ONLY (order_status = 'awaiting_shipment') — never shipped/cancelled. Updates both
 * providerAccountNickname and carrierNickname inside order_overrides.best_rate_json so the saved
 * best-rate snapshot keeps showing the account's current name. Returns the number of awaiting orders
 * touched (max of the two passes). This SQL was previously inline in the carrier-accounts PATCH handler;
 * the handler still owns WHEN to call it (only on a real label change), this owns the WHAT.
 */
export async function backfillAwaitingSnapshotNickname(
  sql: SqlLike,
  oldLabel: string,
  newLabel: string,
): Promise<number> {
  const r1 = (await sql`
    UPDATE order_overrides ovr
    SET best_rate_json = jsonb_set(
      best_rate_json,
      '{providerAccountNickname}',
      to_jsonb(${newLabel}::text)
    )
    FROM orders o
    WHERE ovr.order_id = o.id
      AND o.order_status = 'awaiting_shipment'
      AND ovr.best_rate_json->>'providerAccountNickname' = ${oldLabel}
  `) as unknown as { count?: number };
  const r2 = (await sql`
    UPDATE order_overrides ovr
    SET best_rate_json = jsonb_set(
      best_rate_json,
      '{carrierNickname}',
      to_jsonb(${newLabel}::text)
    )
    FROM orders o
    WHERE ovr.order_id = o.id
      AND o.order_status = 'awaiting_shipment'
      AND ovr.best_rate_json->>'carrierNickname' = ${oldLabel}
  `) as unknown as { count?: number };
  return Math.max(
    typeof r1.count === 'number' ? r1.count : 0,
    typeof r2.count === 'number' ? r2.count : 0,
  );
}

export async function patchCredentialAccount(
  sql: SqlLike,
  table: CredentialAccountTable,
  id: number,
  patch: CredentialAccountPatchInput,
): Promise<CredentialAccountRow | null> {
  let row: CredentialAccountRow | null = null;

  // Credentials merge ("Reconnect"): shallow-merge the supplied keys over the
  // stored credentials so unspecified fields (apiKey/email) survive when only
  // the password is re-entered. Read-merge-write the OBJECT — the same shape the
  // upsert uses (`${object}` straight into the jsonb column). Do NOT pre-stringify
  // and `|| $1::jsonb`: postgres.js double-encodes a pre-stringified value, which
  // mis-stores the object under numeric keys (0,1,2,3). Runs first so a combined
  // patch still returns the post-update row from the source/label branches below.
  if (patch.hasCredentials && patch.credentials && Object.keys(patch.credentials).length > 0) {
    const existingRows = (await sql`
      SELECT credentials FROM ${sql(table)} WHERE id = ${id} LIMIT 1
    `) as Array<{ credentials: unknown }>;
    const existingRaw = existingRows[0]?.credentials;
    const existing =
      existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
        ? (existingRaw as Record<string, unknown>)
        : {};
    // Drop purely-numeric keys — real credential fields are always named
    // (apiKey/email/password/...), so numeric keys can only be corruption
    // artifacts from the earlier double-encode bug. This self-heals affected rows.
    const cleanedExisting: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!/^\d+$/.test(key)) cleanedExisting[key] = value;
    }
    const merged: Record<string, unknown> = { ...cleanedExisting, ...patch.credentials };
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET credentials = ${sql.json(merged as postgres.JSONValue)}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                credentials, source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    row = rows[0] ?? null;
  }

  // Active toggle (hide/show in Rate Browser). Composes with the other fields;
  // assigns `row` and falls through so a combined patch still returns the row.
  if (patch.hasActive && typeof patch.active === 'boolean') {
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET active = ${patch.active}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                credentials, source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    row = rows[0] ?? row;
  }

  if (patch.hasSource && patch.hasLabel) {
    if (table === 'store_accounts' && patch.source === 'admin') {
      const rows = (await sql`
        UPDATE ${sql(table)}
        SET source = ${patch.source},
            label = ${patch.labelGoesNull ? null : patch.label},
            active = true,
            sync_anchor_at = COALESCE(sync_anchor_at, NOW()),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, client_id AS "clientId", provider, label,
                  account_identifier AS "accountIdentifier",
                  credentials, source, active, created_at AS "createdAt"
      `) as CredentialAccountRow[];
      return safeCredentialAccountRow(sql, table, rows[0] ?? row);
    }

    const rows = (await sql`
      UPDATE ${sql(table)}
      SET source = ${patch.source},
          label = ${patch.labelGoesNull ? null : patch.label},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                credentials, source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return safeCredentialAccountRow(sql, table, rows[0] ?? row);
  }

  if (patch.hasSource) {
    if (table === 'store_accounts' && patch.source === 'admin') {
      const rows = (await sql`
        UPDATE ${sql(table)}
        SET source = ${patch.source},
            active = true,
            sync_anchor_at = COALESCE(sync_anchor_at, NOW()),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, client_id AS "clientId", provider, label,
                  account_identifier AS "accountIdentifier",
                  credentials, source, active, created_at AS "createdAt"
      `) as CredentialAccountRow[];
      return safeCredentialAccountRow(sql, table, rows[0] ?? row);
    }

    const rows = (await sql`
      UPDATE ${sql(table)}
      SET source = ${patch.source}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                credentials, source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return safeCredentialAccountRow(sql, table, rows[0] ?? row);
  }

  if (patch.hasLabel) {
    const rows = (await sql`
      UPDATE ${sql(table)}
      SET label = ${patch.labelGoesNull ? null : patch.label}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, client_id AS "clientId", provider, label,
                account_identifier AS "accountIdentifier",
                credentials, source, active, created_at AS "createdAt"
    `) as CredentialAccountRow[];
    return safeCredentialAccountRow(sql, table, rows[0] ?? row);
  }

  return safeCredentialAccountRow(sql, table, row);
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
): Promise<{ clientId: number; syntheticStoreId: number; clientName: string; created: boolean }> {
  const syntheticStoreId = syntheticStoreIdForCredentialAccount(account.provider, account.accountId);

  const existing = (await sql`
    SELECT id, name FROM clients
    WHERE store_ids @> ARRAY[${syntheticStoreId}]::integer[]
    LIMIT 1
  `) as Array<{ id: number; name: string }>;

  const existingClientId = Number(existing[0]?.id);
  if (Number.isFinite(existingClientId) && existingClientId > 0) {
    return {
      clientId: existingClientId,
      syntheticStoreId,
      clientName: existing[0]!.name,
      created: false,
    };
  }

  const baseName = STORE_PROVIDER_LABELS[account.provider] ?? account.provider.toUpperCase();
  const labelMatchesProvider =
    account.label != null && new RegExp(account.provider, 'i').test(account.label);
  const clientName =
    account.label && !labelMatchesProvider ? `${baseName} - ${account.label}` : account.label || baseName;

  const inserted = (await sql`
    INSERT INTO clients (name, store_ids, active, is_test)
    VALUES (${clientName}, ARRAY[${syntheticStoreId}]::integer[], true, false)
    RETURNING id
  `) as Array<{ id: number }>;
  const clientId = Number(inserted[0]?.id);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error(
      `Synthetic store client could not be created for ${account.provider} account ${account.accountId}`,
    );
  }

  return { clientId, syntheticStoreId, clientName, created: true };
}

export async function resolveSyntheticStoreClientContext(
  sql: SqlLike,
  account: { provider: string; accountId: number; label: string | null },
): Promise<{ clientId: number; syntheticStoreId: number }> {
  // The synthetic-store mapping owns imported-order client identity.
  // store_accounts.client_id remains the submission/cutover scope and may differ.
  const context = await ensureSyntheticStoreClient(sql, account);
  return { clientId: context.clientId, syntheticStoreId: context.syntheticStoreId };
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
