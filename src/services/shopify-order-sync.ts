import { sql } from '../db/client';
import type {
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  StoreOrderImportInput,
} from '../connectors/types.js';
import { env } from '../lib/env.js';
import { resolveSyntheticStoreClientContext } from './credential-accounts.js';
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

type ShopifySyncStatusRow = {
  id: number;
  label: string | null;
  lastSyncedAt: Date | string | null;
  lastSyncError: string | null;
};

export type ShopifyOrderSyncStatus = {
  enabled: boolean;
  health: 'disabled' | 'idle' | 'healthy' | 'stale' | 'error';
  accountCount: number;
  lastSyncedAt: string | null;
  accounts: Array<{
    accountId: number;
    displayName: string;
    state: 'fresh' | 'stale' | 'never_synced' | 'failed';
    lastSyncedAt: string | null;
    ageSeconds: number | null;
  }>;
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
  resolveClientContext?: (
    account: Pick<ShopifySyncAccount, 'id'>,
  ) => Promise<{ clientId: number; syntheticStoreId: number }>;
  // Audit SY-3/SY-8 (2026-07-13): cooperative cancellation. The pg-boss deadline
  // races and abandons handlers — without a checkpoint an abandoned walk kept
  // importing pages (and writing cursors) while its lane lock was already
  // released and a fresh run started. Checked between pages.
  signal?: AbortSignal;
};

type ShopifySyncResult = {
  enabled: boolean;
  accounts: number;
  attemptedAccounts: number;
  synced: number;
  errors: number;
};

function throwIfShopifySyncAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

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

function normalizedOrderToStoreOrder(
  order: NormalizedOrder,
  context: { clientId: number; syntheticStoreId: number },
): NormalizedStoreOrder {
  const raw = safeRaw(order.rawPayload);
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
    clientId: context.clientId,
    storeId: context.syntheticStoreId,
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

export function buildShopifyOrderSyncStatus(
  rows: ShopifySyncStatusRow[],
  options: { enabled?: boolean; nowMs?: number; freshMs?: number } = {},
): ShopifyOrderSyncStatus {
  const enabled = options.enabled ?? env.SHOPIFY_SYNC_ENABLED;
  const nowMs = options.nowMs ?? Date.now();
  const freshMs = options.freshMs ?? 15 * 60_000;
  const accounts = rows.map((row) => {
    const syncedAt = asDate(row.lastSyncedAt);
    const ageMs = syncedAt ? Math.max(0, nowMs - syncedAt.getTime()) : null;
    return {
      accountId: Number(row.id),
      displayName: row.label?.trim() || `Shopify account ${row.id}`,
      state: row.lastSyncError
        ? 'failed' as const
        : syncedAt === null
          ? 'never_synced' as const
          : ageMs !== null && ageMs > freshMs
            ? 'stale' as const
            : 'fresh' as const,
      lastSyncedAt: syncedAt?.toISOString() ?? null,
      ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    };
  });
  const oldestSyncMs = accounts.reduce<number | null>((oldest, account) => {
    const value = asDate(account.lastSyncedAt)?.getTime() ?? null;
    if (value === null) return oldest;
    return oldest === null ? value : Math.min(oldest, value);
  }, null);
  const health: ShopifyOrderSyncStatus['health'] = !enabled
    ? 'disabled'
    : accounts.length === 0
      ? 'idle'
      : accounts.some((account) => account.state === 'failed')
        ? 'error'
        : accounts.some((account) => account.state !== 'fresh')
          ? 'stale'
          : 'healthy';
  return {
    enabled,
    health,
    accountCount: accounts.length,
    lastSyncedAt: oldestSyncMs === null ? null : new Date(oldestSyncMs).toISOString(),
    accounts,
  };
}

export async function getShopifyOrderSyncStatus(): Promise<ShopifyOrderSyncStatus> {
  const rows = await sql<ShopifySyncStatusRow[]>`
    SELECT
      id,
      label,
      last_synced_at AS "lastSyncedAt",
      last_sync_error AS "lastSyncError"
    FROM store_accounts
    WHERE provider = 'shopify'
      AND source = 'admin'
      AND active = true
    ORDER BY id
  `;
  return buildShopifyOrderSyncStatus(rows);
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
      sync_cursor_at = GREATEST(${progress.syncCursorAt?.toISOString() ?? null}::timestamptz, sync_cursor_at),
      last_synced_at = COALESCE(${progress.lastSyncedAt?.toISOString() ?? null}::timestamptz, last_synced_at),
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

// Audit SY-8 (2026-07-13): page budget for one account's walk within one run.
const SHOPIFY_SYNC_MAX_PAGES_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.SHOPIFY_SYNC_MAX_PAGES_PER_RUN ?? '40', 10) || 40,
);

export async function syncShopifyAccount(
  account: ShopifySyncAccount,
  deps: ShopifySyncDeps = {},
): Promise<{ synced: number }> {
  if (!isShopifySyncableAccount(account)) return { synced: 0 };

  const importOrders = deps.importOrders ?? importStoreOrders;
  const persistOrders = deps.persistOrders ?? upsertNormalizedStoreOrders;
  const recordProgress = deps.updateAccountProgress ?? updateAccountProgress;
  const resolveClientContext = deps.resolveClientContext
    ?? ((syncAccount: Pick<ShopifySyncAccount, 'id'>) => resolveSyntheticStoreClientContext(sql, {
      provider: 'shopify',
      accountId: syncAccount.id,
      label: null,
    }));
  const clientContext = await resolveClientContext(account);
  throwIfShopifySyncAborted(deps.signal);

  let synced = 0;
  let cursor: string | null = null;
  let pagesWalked = 0;
  do {
    throwIfShopifySyncAborted(deps.signal);
    const result = await importOrders('shopify', {
      companyId: clientContext.clientId,
      accountId: String(account.id),
      credentials: account.credentials as Record<string, string | null | undefined>,
      sinceDate: shopifySyncSince(account),
      createdStartDate: account.syncAnchorAt?.toISOString(),
      cursor,
      limit: 50,
      storeId: clientContext.syntheticStoreId,
      signal: deps.signal,
    });

    throwIfShopifySyncAborted(deps.signal);
    const normalized = result.orders.map((order) => normalizedOrderToStoreOrder(order, clientContext));
    if (normalized.length > 0) {
      throwIfShopifySyncAborted(deps.signal);
      synced += await persistOrders(normalized);
    }

    throwIfShopifySyncAborted(deps.signal);
    const maxUpdatedAt = asDate(result.diagnostics?.maxUpdatedAt);
    if (maxUpdatedAt) {
      throwIfShopifySyncAborted(deps.signal);
      await recordProgress(account.id, {
        syncCursorAt: maxUpdatedAt,
        lastSyncedAt: new Date(),
        lastSyncError: null,
      });
      account.syncCursorAt = maxDate(account.syncCursorAt, maxUpdatedAt);
      account.lastSyncError = null;
    } else if (!result.cursor) {
      throwIfShopifySyncAborted(deps.signal);
      await recordProgress(account.id, {
        lastSyncedAt: new Date(),
        lastSyncError: null,
      });
      account.lastSyncError = null;
    }

    cursor = result.cursor ?? null;
    pagesWalked += 1;
    // Audit SY-8 (2026-07-13): budget + cancellation checkpoints on what was an
    // UNBOUNDED do/while — a large backlog walk exceeded the 10-min job deadline
    // and kept walking as a zombie. 40 pages x 50 orders = 2,000 orders/run; the
    // per-page cursor persist (GREATEST-guarded) resumes the remainder next tick.
  } while (cursor && !deps.signal?.aborted && pagesWalked < SHOPIFY_SYNC_MAX_PAGES_PER_RUN);

  return { synced };
}

export async function syncShopifyOrders(signal?: AbortSignal): Promise<ShopifySyncResult> {
  if (!env.SHOPIFY_SYNC_ENABLED) {
    return { enabled: false, accounts: 0, attemptedAccounts: 0, synced: 0, errors: 0 };
  }

  const accounts = await loadActiveShopifySyncAccounts();
  let synced = 0;
  let errors = 0;
  let attemptedAccounts = 0;

  for (const account of accounts) {
    if (signal?.aborted) break; // audit SY-3: stop cleanly between accounts
    attemptedAccounts += 1;
    try {
      const result = await syncShopifyAccount(account, { signal });
      synced += result.synced;
    } catch (error) {
      throwIfShopifySyncAborted(signal);
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

  return { enabled: true, accounts: accounts.length, attemptedAccounts, synced, errors };
}
