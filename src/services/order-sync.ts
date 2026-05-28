import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { getSettingNumber, setSetting } from './settings';
import { isExcludedStoreId } from '../config/prepship';
import {
  upsertNormalizedStoreOrders,
  type NormalizedStoreOrder,
} from './store-order-import';
import { deductInventoryForOrder } from './fulfillment-deductions';
import { importStoreOrders } from './store-connector-orchestrator';
import type { NormalizedOrder } from '../connectors/types';
import { formatShipStationV1DateParam } from '../lib/shipstation/v1-date';

const LAST_SYNC_KEY = 'order_sync.last_modified_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30 days on first run
const STATUS_CATCHUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const AWAITING_CATCHUP_LOOKBACK_MS = STATUS_CATCHUP_LOOKBACK_MS;

async function buildStoreToClientMap(): Promise<{
  byStore: Map<number, number>;
  newPairs: Array<{ storeId: number; clientId: number }>;
}> {
  const rows = await db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
  const byStore = new Map<number, number>();
  for (const c of rows) {
    for (const sid of c.storeIds ?? []) {
      if (!isExcludedStoreId(sid)) byStore.set(sid, c.id);
    }
  }
  return { byStore, newPairs: [] };
}

// Batched UPDATE that pushes the store_ids mappings discovered during the
// sync pass onto each client row. Runs once per sync (outside the hot
// loop) so the pg array-binding issue doesn't surface per-row.
async function flushNewStorePairs(
  pairs: Array<{ storeId: number; clientId: number }>
): Promise<void> {
  if (!pairs.length) return;
  const byClient = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (isExcludedStoreId(p.storeId)) continue;
    if (!byClient.has(p.clientId)) byClient.set(p.clientId, new Set());
    byClient.get(p.clientId)!.add(p.storeId);
  }
  for (const [clientId, storeIdSet] of byClient) {
    const cid = Math.trunc(clientId);
    const storeList = [...storeIdSet].map((n) => Math.trunc(n)).join(',');
    if (!storeList) continue;
    // Inline the ints as literal SQL — both sides are validated upstream
    // (storeId from SS numeric coercion, clientId from our serial PK).
    await db.execute(
      sql.raw(
        `update clients set store_ids = array(select distinct unnest(
           coalesce(store_ids, array[]::integer[]) || array[${storeList}]::integer[]
         )), updated_at = now() where id = ${cid}`
      )
    );
  }
}

// Batched upsert — writes a page of orders in a single INSERT ... ON CONFLICT
// DO UPDATE instead of N sequential round-trips. ~10x faster than the old
// per-order loop for large backfills.
//
// Preserves the same semantics as the old single-row version:
//   - isTest clients sync like v2; label creation keeps them in test mode
//   - fallbackClientId auto-attaches orders to their owner account
//   - externallyShipped is only overwritten when the incoming row
//     affirmatively sets it (preserves user-set flags on routine syncs)
function normalizedStatusToOrderStatus(status: NormalizedOrder['canonicalStatus']): string {
  return status === 'on_hold' ? 'awaiting_shipment' : status;
}

function normalizedStoreId(order: NormalizedOrder): number | null {
  const value = order.storeId == null ? null : Number(order.storeId);
  return Number.isFinite(value) ? Math.trunc(value as number) : null;
}

function toShipStationNormalizedStoreOrder(
  o: NormalizedOrder,
  args: {
    clientId: number | null;
    storeId: number | null;
  },
): NormalizedStoreOrder {
  const raw = o.rawPayload && typeof o.rawPayload === 'object'
    ? o.rawPayload as Record<string, unknown>
    : {};
  return {
    externalOrderId: o.sourceOrderId,
    source: {
      sourceProvider: o.sourceProvider,
      sourceAccountId: o.sourceAccountId,
      sourceOrderId: o.sourceOrderId,
      sourceOrderNumber: o.sourceOrderNumber,
      rawSourcePayload: raw,
    },
    orderNumber: o.sourceOrderNumber ?? o.sourceOrderId,
    orderStatus: normalizedStatusToOrderStatus(o.canonicalStatus),
    orderDate: o.orderDate ?? null,
    clientId: args.clientId,
    storeId: args.storeId,
    customerEmail: o.customerEmail ?? null,
    shipToName: o.customerName ?? null,
    shipToCity: o.shipToCity ?? null,
    shipToState: o.shipToState ?? null,
    shipToPostalCode: o.shipToPostalCode ?? null,
    carrierCode: o.carrierCode ?? null,
    serviceCode: o.serviceCode ?? null,
    weightOz: o.weightOz ?? null,
    orderTotal: o.orderTotal ?? '0',
    shippingAmount: Number.isFinite(o.shippingPaid as number) ? (o.shippingPaid as number).toFixed(2) : '0',
    items: o.items ?? [],
    raw,
    externallyShipped: o.externallyShipped === true,
  };
}

async function upsertOrdersBatch(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): Promise<number> {
  if (!ordersIn.length) return 0;

  const normalizedOrders: NormalizedStoreOrder[] = [];
  for (const o of ordersIn) {
    const storeId = normalizedStoreId(o);
    if (isExcludedStoreId(storeId)) continue;
    let clientId =
      storeId !== null ? storeToClient.byStore.get(storeId) ?? null : null;
    if (clientId === null && fallbackClientId !== null) {
      clientId = fallbackClientId;
      if (storeId !== null) {
        storeToClient.byStore.set(storeId, fallbackClientId);
        storeToClient.newPairs?.push({ storeId, clientId: fallbackClientId });
      }
    }
    normalizedOrders.push(toShipStationNormalizedStoreOrder(o, { clientId, storeId }));
  }

  return upsertNormalizedStoreOrders(normalizedOrders);

}

async function updateExistingOrderStatusesBatch(
  ordersIn: NormalizedOrder[],
  orderStatus: 'shipped' | 'cancelled'
): Promise<number> {
  const externalIds = Array.from(
    new Set(
      ordersIn
        .map((o) => o.sourceOrderId || null)
        .filter((v): v is string => Boolean(v))
    )
  );
  if (!externalIds.length) return 0;

  // v2 parity: shipped/cancelled sync is a status catch-up for orders already
  // loaded as awaiting_shipment. It must not insert shipped-only rows or
  // rewrite the original order details/date.
  let updated = 0;
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500);
    const rows = await db
      .update(orders)
      .set({ orderStatus, updatedAt: new Date() })
      .where(
        and(
          inArray(orders.externalOrderId, chunk),
          eq(orders.orderStatus, 'awaiting_shipment')
        )
      )
      .returning();
    updated += rows.length;

    if (orderStatus === 'shipped') {
      for (const row of rows) {
        try {
          // Per user override `unlock shipped data` on 2026-05-21: this
          // catch-up path is a forward-only awaiting -> shipped transition.
          // It must mirror label/shipment-sync inventory side effects so
          // orders closed by ShipStation status sync do not skip stock
          // deduction while still respecting INVENTORY_AUTO_DEDUCT.
          await deductInventoryForOrder(row, { source: 'order_sync_status' });
        } catch (err) {
          console.warn('[order-sync] inventory deduction failed:', err);
        }
      }
    }

    // Print Queue persistence: shipped/cancelled sync status does not mean a
    // warehouse operator physically printed the label. Active entries remain
    // until explicit operator confirmation or removal.
  }

  return updated;
}

export type SyncResult = {
  synced: number;
  pages: number;
  lastSyncedAt: string;
  sinceIso: string;
};

// A "SyncAccount" is a ShipStation login we pull orders from. v2-parity:
// one "main" account (env-level SHIPSTATION_API_KEY/SECRET) plus one per
// client that has its own ss_api_key stored on the clients table (e.g.
// KF Goods has its own ShipStation org).
type SyncAccount = {
  label: string;               // for the per-account watermark + logs
  apiKey: string | undefined;  // undefined → use env default
  apiSecret: string | undefined;
  storeIds: number[];
  // When the account is a per-client account (ss_api_key set on a clients
  // row), `ownerClientId` lets upsertOrder attribute orphan orders to that
  // client instead of leaving them at clientId=null.
  ownerClientId: number | null;
};

async function loadSyncAccounts(): Promise<SyncAccount[]> {
  const clientRows = await db
    .select({
      id: clients.id,
      name: clients.name,
      storeIds: clients.storeIds,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.active, true));
  const allStoreIds = [
    ...new Set(
      clientRows.flatMap((row) => row.storeIds ?? []).filter((sid) => !isExcludedStoreId(sid))
    ),
  ];
  const accounts: SyncAccount[] = [
    {
      label: 'main',
      apiKey: undefined,
      apiSecret: undefined,
      storeIds: allStoreIds,
      ownerClientId: null,
    },
  ];
  for (const r of clientRows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
        storeIds: (r.storeIds ?? []).filter((sid) => !isExcludedStoreId(sid)),
        ownerClientId: r.id,
      });
    }
  }
  return accounts;
}

function watermarkKey(accountLabel: string): string {
  return accountLabel === 'main'
    ? LAST_SYNC_KEY
    : `${LAST_SYNC_KEY}:${accountLabel}`;
}

// v2-parity: one paginated pass for a (status, since) pair. Factored out so
// the 3-pass dispatch below can reuse the batched-upsert + inter-page-delay
// + dedupe-key logic.
async function fetchOrdersPage(
  account: SyncAccount,
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>,
  args: {
    orderStatus: string;
    sinceMs: number;
    pageSize: number;
    storeId?: number;
    statusOnly?: boolean;
  },
): Promise<{ synced: number; pages: number }> {
  const sinceParam = formatShipStationV1DateParam(args.sinceMs);
  let page = 1;
  let pages = 1;
  let total = 0;

  while (true) {
    const res = await importStoreOrders('shipstation', {
      companyId: 0,
      accountId: account.label,
      credentials: {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
      },
      orderStatus: args.orderStatus,
      sinceMs: args.sinceMs,
      pageSize: args.pageSize,
      page,
      storeId: args.storeId,
      dedupeKey: `orders:list:${account.label}:${args.orderStatus}:${args.storeId ?? 'all'}:${sinceParam}:${page}:${args.pageSize}`,
    });

    pages = res.pages ?? 1;
    // Per user override unlock shipped data on 2026-05-27: this keeps the
    // existing forward-only shipped/cancelled catch-up behavior while routing
    // ShipStation order import through StoreConnector normalized output.
    total += args.statusOnly
      ? await updateExistingOrderStatusesBatch(
          res.orders,
          args.orderStatus === 'cancelled' ? 'cancelled' : 'shipped'
        )
      : await upsertOrdersBatch(
          res.orders,
          storeToClient,
          account.ownerClientId,
        );

    if (!res.orders.length || page >= pages) break;
    page += 1;
    // v2-parity: 500ms inter-page delay. Matches v1Pages helper.
    await new Promise((r) => setTimeout(r, 500));
  }

  return { synced: total, pages };
}

async function syncOrdersForAccount(
  account: SyncAccount,
  opts: {
    sinceMs?: number;
    awaitingSinceMs?: number;
    pageSize?: number;
    skipStatusPasses?: boolean;
  },
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>
): Promise<{ synced: number; pages: number; sinceIso: string }> {
  const key = watermarkKey(account.label);
  const lastSync =
    opts.sinceMs ??
    (await getSettingNumber(key)) ??
    Date.now() - DEFAULT_LOOKBACK_MS;

  // v2-parity: pageSize=500. Matches v1Pages.
  const pageSize = opts.pageSize ?? 500;
  const runStartMs = Date.now();
  const sinceIso = new Date(lastSync).toISOString();

  // v2 parity plus production recovery: ShipStation can move an order from
  // awaiting_shipment to shipped/cancelled without that old awaiting row being
  // revisited by a narrow watermark. Use a 30-day catch-up window so stale DB
  // awaiting counts converge back to ShipStation's live sidebar counts.
  const passes: Array<{ orderStatus: string; sinceMs: number }> = [
    ...(opts.skipStatusPasses
      ? []
      : [
          {
            orderStatus: 'shipped',
            sinceMs: Math.min(lastSync, runStartMs - STATUS_CATCHUP_LOOKBACK_MS),
          },
          {
            orderStatus: 'cancelled',
            sinceMs: Math.min(lastSync, runStartMs - STATUS_CATCHUP_LOOKBACK_MS),
          },
        ]),
  ];

  let total = 0;
  let maxPages = 1;
  let failed = false;
  for (const pass of passes) {
    try {
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: pass.orderStatus,
        sinceMs: pass.sinceMs,
        pageSize,
        statusOnly: true,
      });
      total += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
    } catch (err) {
      failed = true;
      // Per-status failure shouldn't kill the whole account sync.
      console.warn(
        `[order-sync] account="${account.label}" orderStatus="${pass.orderStatus}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const awaitingSinceMs =
    opts.awaitingSinceMs ?? Math.min(lastSync, runStartMs - AWAITING_CATCHUP_LOOKBACK_MS);
  const awaitingStoreIds = account.storeIds.filter((sid) => !isExcludedStoreId(sid));
  const awaitingTargets =
    awaitingStoreIds.length > 0
      ? awaitingStoreIds.map((storeId) => ({ storeId }))
      : [{ storeId: undefined as number | undefined }];

  for (const target of awaitingTargets) {
    try {
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: 'awaiting_shipment',
        sinceMs: awaitingSinceMs,
        pageSize,
        storeId: target.storeId,
      });
      total += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
    } catch (err) {
      failed = true;
      console.warn(
        `[order-sync] account="${account.label}" orderStatus="awaiting_shipment" storeId="${target.storeId ?? 'all'}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!failed) {
    await setSetting(key, String(runStartMs));
  } else {
    console.warn(
      `[order-sync] account="${account.label}" had failed pass(es); watermark not advanced`
    );
  }
  return { synced: total, pages: maxPages, sinceIso };
}

export async function syncOrders(opts: {
  sinceMs?: number;
  awaitingSinceMs?: number;
  pageSize?: number;
  skipStatusPasses?: boolean;
} = {}): Promise<SyncResult> {
  const runStartMs = Date.now();
  const storeToClient = await buildStoreToClientMap();
  const accounts = await loadSyncAccounts();

  let grandTotal = 0;
  let maxPages = 1;
  let earliestSinceIso = new Date(runStartMs).toISOString();

  for (const acct of accounts) {
    try {
      const result = await syncOrdersForAccount(acct, opts, storeToClient);
      grandTotal += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
      if (result.sinceIso < earliestSinceIso) earliestSinceIso = result.sinceIso;
    } catch (err) {
      console.error(
        `[order-sync] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
  }

  // Flush any new (storeId → clientId) mappings discovered during this
  // sync pass — one UPDATE per client, outside the hot loop.
  try {
    await flushNewStorePairs(storeToClient.newPairs);
  } catch (err) {
    console.error('[order-sync] flushNewStorePairs failed:', (err as Error).message);
  }

  return {
    synced: grandTotal,
    pages: maxPages,
    lastSyncedAt: new Date(runStartMs).toISOString(),
    sinceIso: earliestSinceIso,
  };
}

export async function getSyncStatus(options: { includeOrderCount?: boolean } = {}): Promise<{
  lastSyncedAt: string | null;
  orderCount: number;
}> {
  // Latest watermark across accounts — reflects the most-recent successful sync.
  const accounts = await loadSyncAccounts();
  let latestMs: number | null = null;
  for (const acct of accounts) {
    const ms = await getSettingNumber(watermarkKey(acct.label));
    if (ms && (latestMs === null || ms > latestMs)) latestMs = ms;
  }
  const lastSyncedAt = latestMs ? new Date(latestMs).toISOString() : null;
  if (options.includeOrderCount === false) {
    return { lastSyncedAt, orderCount: 0 };
  }
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders);
  return { lastSyncedAt, orderCount: rows[0]?.count ?? 0 };
}
