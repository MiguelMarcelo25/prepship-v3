import { sql } from '../db/client';
import {
  defaultCutoverSyncAnchorAt,
  normalizeShipStationStoreIds,
} from './store-source-cutover-policy';
export {
  defaultCutoverSyncAnchorAt,
  filterShipStationStoreIdsForCutover,
  normalizeShipStationStoreIds,
} from './store-source-cutover-policy';

export type StoreSourceCutoverMode = 'active' | 'paused';

export type StoreSourceCutoverSummary = {
  clientId: number;
  shopifyStoreAccountId: number;
  shipstationStoreIds: number[];
  syncAnchorAt: string;
  shipstationAwaitingCount: number;
  shipstationTotalCount: number;
  shopifyExistingCount: number;
  duplicateCandidates: StoreSourceDuplicateCandidate[];
};

export type StoreSourceDuplicateCandidate = {
  orderNumber: string;
  shipstationOrderId: number;
  shipstationSourceOrderId: string | null;
  shipstationStatus: string;
  shopifyOrderId: number;
  shopifySourceOrderId: string | null;
  shopifyStatus: string;
  shipToPostalCode: string | null;
};

export type StoreSourceCutoverRecord = {
  id: number;
  clientId: number;
  legacyProvider: string;
  legacyStoreId: number;
  targetProvider: string;
  targetStoreAccountId: number;
  mode: StoreSourceCutoverMode;
  syncAnchorAt: Date | string | null;
  dryRunSummary: Record<string, unknown> | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type StoreAccountRow = {
  id: number;
  clientId: number | null;
  provider: string;
  label: string | null;
  accountIdentifier: string | null;
  source: string | null;
  active: boolean | null;
};

let schemaEnsured: Promise<void> | null = null;

function parseDateOrDefault(value: string | Date | null | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return defaultCutoverSyncAnchorAt();
}

export async function ensureStoreSourceCutoverSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS store_source_cutovers (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id),
        legacy_provider text NOT NULL DEFAULT 'shipstation',
        legacy_store_id integer NOT NULL,
        target_provider text NOT NULL DEFAULT 'shopify',
        target_store_account_id integer NOT NULL,
        mode text NOT NULL DEFAULT 'active',
        sync_anchor_at timestamptz,
        dry_run_summary jsonb,
        created_by text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS store_source_cutovers_client_idx ON store_source_cutovers (client_id)`;
    await sql`CREATE INDEX IF NOT EXISTS store_source_cutovers_legacy_idx ON store_source_cutovers (legacy_provider, legacy_store_id)`;
    await sql`CREATE INDEX IF NOT EXISTS store_source_cutovers_target_idx ON store_source_cutovers (target_provider, target_store_account_id)`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS store_source_cutovers_identity_idx
      ON store_source_cutovers (
        legacy_provider,
        legacy_store_id,
        target_provider,
        target_store_account_id
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS store_source_cutovers_active_legacy_idx
      ON store_source_cutovers (legacy_provider, legacy_store_id)
      WHERE mode = 'active'
    `;
    await sql`ALTER TABLE store_source_cutovers ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

async function loadShopifyStoreAccount(accountId: number): Promise<StoreAccountRow> {
  const rows = await sql<Array<StoreAccountRow>>`
    SELECT
      id,
      client_id AS "clientId",
      provider,
      label,
      account_identifier AS "accountIdentifier",
      source,
      active
    FROM store_accounts
    WHERE id = ${accountId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`store_accounts row #${accountId} not found`);
  if (row.provider !== 'shopify') {
    throw new Error(`store_accounts row #${accountId} is ${row.provider}, not shopify`);
  }
  return row;
}

function assertAccountMatchesClient(account: StoreAccountRow, clientId: number): void {
  if (account.clientId != null && Number(account.clientId) !== clientId) {
    throw new Error(
      `Shopify store account #${account.id} belongs to client #${account.clientId}, not #${clientId}`,
    );
  }
}

export async function dryRunStoreSourceCutover(input: {
  clientId: number;
  shopifyStoreAccountId: number;
  shipstationStoreIds: number[];
  syncAnchorAt?: string | Date | null;
}): Promise<StoreSourceCutoverSummary> {
  await ensureStoreSourceCutoverSchema();
  const clientId = Math.trunc(input.clientId);
  const shopifyStoreAccountId = Math.trunc(input.shopifyStoreAccountId);
  const shipstationStoreIds = normalizeShipStationStoreIds(input.shipstationStoreIds);
  if (!Number.isInteger(clientId) || clientId <= 0) throw new Error('clientId is required');
  if (!Number.isInteger(shopifyStoreAccountId) || shopifyStoreAccountId <= 0) {
    throw new Error('shopifyStoreAccountId is required');
  }
  if (shipstationStoreIds.length === 0) {
    throw new Error('At least one ShipStation store ID is required');
  }

  const account = await loadShopifyStoreAccount(shopifyStoreAccountId);
  assertAccountMatchesClient(account, clientId);
  const syncAnchorAt = parseDateOrDefault(input.syncAnchorAt);

  const [countRow] = await sql<Array<{
    shipstationAwaitingCount: number;
    shipstationTotalCount: number;
    shopifyExistingCount: number;
  }>>`
    SELECT
      count(*) FILTER (
        WHERE source_provider = 'shipstation'
          AND store_id = ANY(${shipstationStoreIds}::int[])
          AND order_status = 'awaiting_shipment'
      )::int AS "shipstationAwaitingCount",
      count(*) FILTER (
        WHERE source_provider = 'shipstation'
          AND store_id = ANY(${shipstationStoreIds}::int[])
      )::int AS "shipstationTotalCount",
      count(*) FILTER (
        WHERE source_provider = 'shopify'
          AND source_account_id = ${String(shopifyStoreAccountId)}
      )::int AS "shopifyExistingCount"
    FROM orders
    WHERE client_id = ${clientId}
  `;

  const duplicateCandidates = await sql<Array<StoreSourceDuplicateCandidate>>`
    WITH ss AS (
      SELECT
        id,
        lower(order_number) AS order_number_key,
        order_number,
        source_order_id,
        order_status,
        ship_to_postal_code
      FROM orders
      WHERE client_id = ${clientId}
        AND source_provider = 'shipstation'
        AND store_id = ANY(${shipstationStoreIds}::int[])
        AND order_number IS NOT NULL
    ),
    shop AS (
      SELECT
        id,
        lower(order_number) AS order_number_key,
        order_number,
        source_order_id,
        order_status,
        ship_to_postal_code
      FROM orders
      WHERE client_id = ${clientId}
        AND source_provider = 'shopify'
        AND source_account_id = ${String(shopifyStoreAccountId)}
        AND order_number IS NOT NULL
    )
    SELECT
      ss.order_number AS "orderNumber",
      ss.id AS "shipstationOrderId",
      ss.source_order_id AS "shipstationSourceOrderId",
      ss.order_status AS "shipstationStatus",
      shop.id AS "shopifyOrderId",
      shop.source_order_id AS "shopifySourceOrderId",
      shop.order_status AS "shopifyStatus",
      coalesce(ss.ship_to_postal_code, shop.ship_to_postal_code) AS "shipToPostalCode"
    FROM ss
    JOIN shop ON shop.order_number_key = ss.order_number_key
    ORDER BY ss.id DESC
    LIMIT 50
  `;

  return {
    clientId,
    shopifyStoreAccountId,
    shipstationStoreIds,
    syncAnchorAt: syncAnchorAt.toISOString(),
    shipstationAwaitingCount: Number(countRow?.shipstationAwaitingCount ?? 0),
    shipstationTotalCount: Number(countRow?.shipstationTotalCount ?? 0),
    shopifyExistingCount: Number(countRow?.shopifyExistingCount ?? 0),
    duplicateCandidates,
  };
}

export async function applyStoreSourceCutover(input: {
  clientId: number;
  shopifyStoreAccountId: number;
  shipstationStoreIds: number[];
  syncAnchorAt?: string | Date | null;
  actor?: string | null;
}): Promise<{ cutovers: StoreSourceCutoverRecord[]; dryRun: StoreSourceCutoverSummary }> {
  const dryRun = await dryRunStoreSourceCutover(input);
  const actor = input.actor ?? null;
  const syncAnchorAt = new Date(dryRun.syncAnchorAt);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE store_accounts
      SET
        source = 'admin',
        active = true,
        sync_anchor_at = ${syncAnchorAt},
        last_sync_error = NULL,
        updated_at = NOW()
      WHERE id = ${dryRun.shopifyStoreAccountId}
        AND provider = 'shopify'
    `;

    await tx`
      UPDATE store_source_cutovers
      SET mode = 'paused', updated_by = ${actor}, updated_at = NOW()
      WHERE legacy_provider = 'shipstation'
        AND legacy_store_id = ANY(${dryRun.shipstationStoreIds}::int[])
        AND mode = 'active'
    `;

    for (const storeId of dryRun.shipstationStoreIds) {
      await tx`
        INSERT INTO store_source_cutovers (
          client_id,
          legacy_provider,
          legacy_store_id,
          target_provider,
          target_store_account_id,
          mode,
          sync_anchor_at,
          dry_run_summary,
          created_by,
          updated_by
        )
        VALUES (
          ${dryRun.clientId},
          'shipstation',
          ${storeId},
          'shopify',
          ${dryRun.shopifyStoreAccountId},
          'active',
          ${syncAnchorAt},
          ${sql.json(dryRun)},
          ${actor},
          ${actor}
        )
        ON CONFLICT (
          legacy_provider,
          legacy_store_id,
          target_provider,
          target_store_account_id
        )
        DO UPDATE SET
          client_id = EXCLUDED.client_id,
          mode = 'active',
          sync_anchor_at = EXCLUDED.sync_anchor_at,
          dry_run_summary = EXCLUDED.dry_run_summary,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;
    }
  });

  const cutovers = await listStoreSourceCutovers({
    clientId: dryRun.clientId,
    targetStoreAccountId: dryRun.shopifyStoreAccountId,
  });
  return { cutovers, dryRun };
}

export async function updateStoreSourceCutoverMode(input: {
  id: number;
  mode: StoreSourceCutoverMode;
  actor?: string | null;
}): Promise<StoreSourceCutoverRecord | null> {
  await ensureStoreSourceCutoverSchema();
  const id = Math.trunc(input.id);
  const actor = input.actor ?? null;
  return sql.begin(async (tx) => {
    const current = await tx<Array<{
      legacyProvider: string;
      legacyStoreId: number;
    }>>`
      SELECT
        legacy_provider AS "legacyProvider",
        legacy_store_id AS "legacyStoreId"
      FROM store_source_cutovers
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = current[0];
    if (!row) return null;
    if (input.mode === 'active') {
      await tx`
        UPDATE store_source_cutovers
        SET mode = 'paused', updated_by = ${actor}, updated_at = NOW()
        WHERE id <> ${id}
          AND legacy_provider = ${row.legacyProvider}
          AND legacy_store_id = ${row.legacyStoreId}
          AND mode = 'active'
      `;
    }
    const rows = await tx<Array<StoreSourceCutoverRecord>>`
      UPDATE store_source_cutovers
      SET mode = ${input.mode}, updated_by = ${actor}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        client_id AS "clientId",
        legacy_provider AS "legacyProvider",
        legacy_store_id AS "legacyStoreId",
        target_provider AS "targetProvider",
        target_store_account_id AS "targetStoreAccountId",
        mode,
        sync_anchor_at AS "syncAnchorAt",
        dry_run_summary AS "dryRunSummary",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    return rows[0] ?? null;
  });
}

export async function listStoreSourceCutovers(filters: {
  clientId?: number;
  targetStoreAccountId?: number;
  mode?: StoreSourceCutoverMode;
} = {}): Promise<StoreSourceCutoverRecord[]> {
  await ensureStoreSourceCutoverSchema();
  const rows = await sql<Array<StoreSourceCutoverRecord>>`
    SELECT
      id,
      client_id AS "clientId",
      legacy_provider AS "legacyProvider",
      legacy_store_id AS "legacyStoreId",
      target_provider AS "targetProvider",
      target_store_account_id AS "targetStoreAccountId",
      mode,
      sync_anchor_at AS "syncAnchorAt",
      dry_run_summary AS "dryRunSummary",
      created_by AS "createdBy",
      updated_by AS "updatedBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM store_source_cutovers
    WHERE (${filters.clientId ?? null}::int IS NULL OR client_id = ${filters.clientId ?? null})
      AND (${filters.targetStoreAccountId ?? null}::int IS NULL OR target_store_account_id = ${filters.targetStoreAccountId ?? null})
      AND (${filters.mode ?? null}::text IS NULL OR mode = ${filters.mode ?? null})
    ORDER BY updated_at DESC, id DESC
  `;
  return rows;
}

export async function loadActiveShipStationCutoverStoreIds(): Promise<Set<number>> {
  await ensureStoreSourceCutoverSchema();
  const rows = await sql<Array<{ legacyStoreId: number }>>`
    SELECT legacy_store_id AS "legacyStoreId"
    FROM store_source_cutovers
    WHERE legacy_provider = 'shipstation'
      AND mode = 'active'
  `;
  return new Set(rows.map((row) => Number(row.legacyStoreId)).filter((id) => Number.isInteger(id) && id > 0));
}
