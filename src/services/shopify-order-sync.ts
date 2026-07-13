import { sql } from '../db/client';
import type {
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  StoreOrderImportInput,
} from '../connectors/types.js';
import { env } from '../lib/env.js';
import { syntheticStoreIdForCredentialAccount } from './credential-accounts.js';
import { importStoreOrders } from './store-connector-orchestrator.js';
import {
  upsertNormalizedStoreOrders,
  type NormalizedStoreOrder,
} from './store-order-import.js';

export type ShopifySyncAccount = {
  id: number;
  clientId: number | null;
  source: string | null;
  active: boolean | null;
  credentials: Record<string, unknown>;
  syncAnchorAt: Date | null;
  syncCursorAt: Date | null;
  lastSyncError?: string | null;
};

type ShopifySyncProgress = {
  syncCursorAt?: Date | null;
  lastSyncedAt?: Date | null;
  lastSyncError?: string | null;
  active?: boolean;
};

type ShopifySyncDeps = {
  importOrders?: (
    provider: string,
    input: StoreOrderImportInput,
  ) => Promise<NormalizedStoreOrderImportResult>;
  persistOrders?: (orders: NormalizedStoreOrder[]) => Promise<number>;
  updateAccountProgress?: (id: number, progress: ShopifySyncProgress) => Promise<void>;
};

type ShopifySyncResult = {
  enabled: boolean;
  accounts: number;
  synced: number;
  errors: number;
};

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function maxDate(...values: Array<Date | null | undefined>): Date | null {
  let max = 0;
  for (const value of values) {
    if (value && value.getTime() > max) max = value.getTime();
  }
  return max > 0 ? new Date(max) : null;
}

function normalizedStatusToOrderStatus(status: NormalizedOrder['canonicalStatus']): string {
  return status === 'on_hold' ? 'awaiting_shipment' : status;
}

function safeRaw(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function money(value: number | null | undefined): string {
  return Number.isFinite(value as number) ? (value as number).toFixed(2) : '0';
}

function normalizedOrderToStoreOrder(order: NormalizedOrder, account: ShopifySyncAccount): NormalizedStoreOrder {
  const raw = safeRaw(order.rawPayload);
  const storeId = syntheticStoreIdForCredentialAccount('shopify', account.id);
  return {
    externalOrderId: `shopify-${order.sourceOrderId}`,
    source: {
      sourceProvider: order.sourceProvider,
      sourceAccountId: order.sourceAccountId,
      sourceOrderId: order.sourceOrderId,
      sourceOrderNumber: order.sourceOrderNumber,
      rawSourcePayload: raw,
    },
    orderNumber: order.sourceOrderNumber ?? order.sourceOrderId,
    orderStatus: normalizedStatusToOrderStatus(order.canonicalStatus),
    orderDate: order.orderDate ?? null,
    clientId: account.clientId,
    storeId,
    customerEmail: order.customerEmail ?? null,
    shipToName: order.customerName ?? null,
    shipToCity: order.shipToCity ?? null,
    shipToState: order.shipToState ?? null,
    shipToPostalCode: order.shipToPostalCode ?? null,
    carrierCode: order.carrierCode ?? null,
    serviceCode: order.serviceCode ?? null,
    weightOz: order.weightOz ?? null,
    orderTotal: order.orderTotal ?? '0',
    shippingAmount: money(order.shippingPaid),
    items: order.items ?? [],
    raw,
    externallyShipped: order.externallyShipped === true,
  };
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403|unauthorized|forbidden|invalid token|access denied)\b/i.test(message);
}

function nextAuthError(previous: string | null | undefined): { error: string; active: boolean } {
  const match = /^auth:(\d+)$/.exec(previous ?? '');
  const count = (match ? Number(match[1]) : previous === 'auth' ? 3 : 0) + 1;
  return count >= 3
    ? { error: 'auth', active: false }
    : { error: `auth:${count}`, active: true };
}

export function isShopifySyncableAccount(account: Pick<ShopifySyncAccount, 'source' | 'active'>): boolean {
  return account.source === 'admin' && account.active === true;
}

export function shopifySyncSince(account: Pick<ShopifySyncAccount, 'syncAnchorAt' | 'syncCursorAt'>): string {
  const since = maxDate(account.syncAnchorAt, account.syncCursorAt) ?? new Date(0);
  return since.toISOString();
}

async function updateAccountProgress(id: number, progress: ShopifySyncProgress): Promise<void> {
  // Audit SY-8 (2026-07-13): the cursor write is now MONOTONIC in SQL. The old
  // plain COALESCE trusted single-writer ordering — but a deadline-abandoned
  // zombie walk (with-deadline races, it doesn't cancel) can persist a stale
  // page's maxUpdatedAt AFTER a fresh run advanced the cursor, silently
  // rewinding it. GREATEST ignores NULLs in Postgres, so a null progress value
  // still leaves the column untouched.
  await sql`
    UPDATE store_accounts
    SET
      sync_cursor_at = GREATEST(${progress.syncCursorAt ?? null}::timestamptz, sync_cursor_at),
      last_synced_at = COALESCE(${progress.lastSyncedAt ?? null}, last_synced_at),
      last_sync_error = ${progress.lastSyncError ?? null},
      active = COALESCE(${progress.active ?? null}, active),
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function loadActiveShopifySyncAccounts(): Promise<ShopifySyncAccount[]> {
  const rows = await sql<Array<{
    id: number;
    clientId: number | null;
    source: string | null;
    active: boolean | null;
    credentials: Record<string, unknown> | null;
    syncAnchorAt: Date | string | null;
    syncCursorAt: Date | string | null;
    lastSyncError: string | null;
  }>>`
    SELECT
      id,
      client_id AS "clientId",
      source,
      active,
      credentials,
      sync_anchor_at AS "syncAnchorAt",
      sync_cursor_at AS "syncCursorAt",
      last_sync_error AS "lastSyncError"
    FROM store_accounts
    WHERE provider = 'shopify'
      AND source = 'admin'
      AND active = true
    ORDER BY id
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    clientId: row.clientId == null ? null : Number(row.clientId),
    source: row.source,
    active: row.active,
    credentials: row.credentials ?? {},
    syncAnchorAt: asDate(row.syncAnchorAt),
    syncCursorAt: asDate(row.syncCursorAt),
    lastSyncError: row.lastSyncError,
  }));
}

export async function syncShopifyAccount(
  account: ShopifySyncAccount,
  deps: ShopifySyncDeps = {},
): Promise<{ synced: number }> {
  if (!isShopifySyncableAccount(account)) return { synced: 0 };

  const importOrders = deps.importOrders ?? importStoreOrders;
  const persistOrders = deps.persistOrders ?? upsertNormalizedStoreOrders;
  const recordProgress = deps.updateAccountProgress ?? updateAccountProgress;

  let synced = 0;
  let cursor: string | null = null;
  do {
    const result = await importOrders('shopify', {
      companyId: account.clientId ?? 0,
      accountId: String(account.id),
      credentials: account.credentials as Record<string, string | null | undefined>,
      sinceDate: shopifySyncSince(account),
      createdStartDate: account.syncAnchorAt?.toISOString(),
      cursor,
      limit: 50,
      storeId: syntheticStoreIdForCredentialAccount('shopify', account.id),
    });

    const normalized = result.orders.map((order) => normalizedOrderToStoreOrder(order, account));
    if (normalized.length > 0) {
      synced += await persistOrders(normalized);
    }

    const maxUpdatedAt = asDate(result.diagnostics?.maxUpdatedAt);
    if (maxUpdatedAt) {
      await recordProgress(account.id, {
        syncCursorAt: maxUpdatedAt,
        lastSyncedAt: new Date(),
        lastSyncError: null,
      });
      account.syncCursorAt = maxDate(account.syncCursorAt, maxUpdatedAt);
      account.lastSyncError = null;
    } else if (!result.cursor) {
      await recordProgress(account.id, {
        lastSyncedAt: new Date(),
        lastSyncError: null,
      });
      account.lastSyncError = null;
    }

    cursor = result.cursor ?? null;
  } while (cursor);

  return { synced };
}

export async function syncShopifyOrders(): Promise<ShopifySyncResult> {
  if (!env.SHOPIFY_SYNC_ENABLED) {
    return { enabled: false, accounts: 0, synced: 0, errors: 0 };
  }

  const accounts = await loadActiveShopifySyncAccounts();
  let synced = 0;
  let errors = 0;

  for (const account of accounts) {
    try {
      const result = await syncShopifyAccount(account);
      synced += result.synced;
    } catch (error) {
      errors += 1;
      const auth = isAuthFailure(error) ? nextAuthError(account.lastSyncError) : null;
      await updateAccountProgress(account.id, {
        lastSyncError: auth?.error ?? (error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)),
        active: auth?.active,
      });
      console.warn('[shopify-order-sync] account failed', {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { enabled: true, accounts: accounts.length, synced, errors };
}
