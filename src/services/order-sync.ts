import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { shipments } from '../db/schema/shipments';
import { getSettingNumber, setSetting } from './settings';
import { isExcludedStoreId } from '../config/prepship';
import {
  upsertNormalizedStoreOrders,
  type NormalizedStoreOrder,
} from './store-order-import';
import {
  buildOrderSourceIdentity,
  legacyExternalOrderIdForSource,
  orderSourceIdentitiesPredicate,
  orderSourceIdentityKey,
  orderSourceIdentityOrLegacyPredicate,
  type OrderSourceIdentity,
} from './order-source-identity';
import { deductInventoryForOrder } from './fulfillment-deductions';
import { importStoreOrders } from './store-connector-orchestrator';
import type { NormalizedOrder } from '../connectors/types';
import { formatShipStationV1DateParam } from '../lib/shipstation/v1-date';
import {
  type SyncRunBudget,
  createSyncRunBudget,
  syncRunBudgetExhausted,
  syncRunBudgetTimeExhausted,
} from '../lib/sync-run-budget';

const LAST_SYNC_KEY = 'order_sync.last_modified_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30 days on first run
const STATUS_CATCHUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const AWAITING_CATCHUP_LOOKBACK_MS = STATUS_CATCHUP_LOOKBACK_MS;
// Per user override unlock shipped data on 2026-07-07: keep the order/status
// sync lane fresh enough to import ShipStation split children without
// reopening existing shipped/cancelled rows.
const DEFAULT_ORDER_SYNC_PAGE_SIZE = 100;
// Per user override unlock shipped data on 2026-07-02: background order sync
// must finish and release the shared ShipStation lane. Slow provider calls are
// retried on the next 3-minute tick instead of burning the 10-minute job guard.
const BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS = 25_000;

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
    const storeIds = [...storeIdSet].map((n) => Math.trunc(n));
    // PS-254 (Card 9): PIN the integer invariant that makes this sql.raw injection-safe,
    // instead of trusting only the upstream comment. A non-integer (e.g. NaN from a future
    // coercion change) can never be spliced into the SQL — we skip the row instead. We keep
    // sql.raw (not parameterized arrays) on purpose: it sidesteps the pg array-binding issue.
    if (!Number.isInteger(cid) || !storeIds.every(Number.isInteger)) continue;
    const storeList = storeIds.join(',');
    if (!storeList) continue;
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

function buildNormalizedStoreOrders(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): NormalizedStoreOrder[] {
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
  return normalizedOrders;
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
  const normalizedOrders = buildNormalizedStoreOrders(ordersIn, storeToClient, fallbackClientId);
  return upsertNormalizedStoreOrders(normalizedOrders);

}

async function upsertMissingShippedOrdersBatch(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null,
): Promise<number> {
  const normalizedOrders = buildNormalizedStoreOrders(ordersIn, storeToClient, fallbackClientId);
  const keyedOrders = normalizedOrders
    .map((order) => {
      const identity = buildOrderSourceIdentity(order.source);
      return identity ? { order, identity, legacyExternalOrderId: order.externalOrderId ?? legacyExternalOrderIdForSource(identity) } : null;
    })
    .filter((entry): entry is { order: NormalizedStoreOrder; identity: OrderSourceIdentity; legacyExternalOrderId: string } => entry !== null);
  if (!keyedOrders.length) return 0;

  const existingPredicate = orderSourceIdentityOrLegacyPredicate({
    identities: keyedOrders.map((entry) => entry.identity),
    legacyExternalOrderIds: keyedOrders.map((entry) => entry.legacyExternalOrderId),
    includeUnqualifiedShipStationLegacy: true,
  });
  if (!existingPredicate) return 0;
  const existingRows = await db
    .select({
      externalOrderId: orders.externalOrderId,
      sourceProvider: orders.sourceProvider,
      sourceAccountId: orders.sourceAccountId,
      sourceOrderId: orders.sourceOrderId,
    })
    .from(orders)
    .where(existingPredicate);
  const existingSourceKeys = new Set<string>();
  const existingLegacyExternalIds = new Set<string>();
  for (const row of existingRows) {
    const identity = buildOrderSourceIdentity(row);
    if (identity) existingSourceKeys.add(orderSourceIdentityKey(identity));
    if (row.externalOrderId) existingLegacyExternalIds.add(row.externalOrderId);
  }

  const missingEntries = keyedOrders.filter(
    (entry) =>
      !existingSourceKeys.has(orderSourceIdentityKey(entry.identity)) &&
      !existingLegacyExternalIds.has(entry.legacyExternalOrderId)
  );
  if (!missingEntries.length) return 0;
  const missingOrders = missingEntries.map((entry) => entry.order);

  // Per user override `unlock shipped data` on 2026-05-29: shipped ShipStation
  // orders that were created and shipped before PrepShip saw the awaiting row
  // must be imported so Inventory History can deduct from real order items.
  // This is insert-only for missing shipped rows; existing shipped/cancelled
  // protections and the inventory auto-deduct kill switch remain in force.
  await upsertNormalizedStoreOrders(missingOrders);

  const insertedPredicate = orderSourceIdentitiesPredicate(missingEntries.map((entry) => entry.identity));
  if (!insertedPredicate) return 0;
  const insertedRows = await db
    .select()
    .from(orders)
    .where(insertedPredicate);

  let shipmentsLinked = 0;
  let shippedHydrated = 0;
  for (const row of insertedRows) {
    if (row.orderStatus !== 'shipped') continue;
    shippedHydrated += 1;
    const linked = await db
      .update(shipments)
      .set({ orderId: row.id, clientId: row.clientId, updatedAt: new Date() })
      .where(
        and(
          isNull(shipments.orderId),
          eq(shipments.orderNumber, row.orderNumber)
        )
      )
      .returning({ id: shipments.id });
    shipmentsLinked += linked.length;
    try {
      await deductInventoryForOrder(row, { source: 'order_sync_status' });
    } catch (err) {
      console.warn('[order-sync] inventory deduction failed for imported shipped order:', err);
    }
  }

  // Observability (PS-046): redacted counts only — no order numbers, no PII,
  // no raw provider payloads. Lets the operator/runbook confirm the
  // never-imported-while-awaiting recovery path is actually healing orphans.
  if (insertedRows.length) {
    console.log(
      `[order-sync] hydrated ${insertedRows.length} missing order(s) ` +
        `(${shippedHydrated} shipped), linked ${shipmentsLinked} orphan shipment(s)`,
    );
  }

  return insertedRows.length;
}

// Per user override unlock shipped data on 2026-06-10: status catch-up now covers the non-awaiting,
// non-shipped ShipStation states (on_hold / awaiting_payment / pending_fulfillment) in addition to
// shipped/cancelled, so PrepShip's awaiting list converges to ShipStation's — orders SS puts On Hold /
// Pending no longer rot in PrepShip's "Awaiting Shipment". Only 'shipped' triggers inventory deduction.
type CatchUpOrderStatus =
  | 'shipped'
  | 'cancelled'
  | 'on_hold'
  | 'awaiting_payment'
  | 'pending_fulfillment';

async function updateExistingOrderStatusesBatch(
  ordersIn: NormalizedOrder[],
  orderStatus: CatchUpOrderStatus
): Promise<number> {
  const identities = ordersIn
    .map((order) => buildOrderSourceIdentity(order))
    .filter((identity): identity is OrderSourceIdentity => identity !== null);
  if (!identities.length) return 0;

  // v2 parity: shipped/cancelled sync is a status catch-up for orders already
  // loaded as awaiting_shipment. It must not insert shipped-only rows or
  // rewrite the original order details/date.
  let updated = 0;
  for (let i = 0; i < identities.length; i += 250) {
    const chunk = identities.slice(i, i + 250);
    const identityPredicate = orderSourceIdentityOrLegacyPredicate({
      identities: chunk,
      legacyExternalOrderIds: chunk.map(legacyExternalOrderIdForSource),
      includeUnqualifiedShipStationLegacy: true,
    });
    if (!identityPredicate) continue;
    const rows = await db
      .update(orders)
      .set({ orderStatus, updatedAt: new Date() })
      .where(
        and(
          // Per user override unlock shipped data on 2026-07-06: PS-388
          // narrows status catch-up matching to the composite source identity,
          // with external_order_id fallback only for legacy/unqualified rows.
          identityPredicate,
          // Transition from ANY non-terminal state to the ShipStation-reported status. Terminal rows
          // (shipped/cancelled) are NEVER overwritten here — they stay locked/preserved (and the import
          // upsert preserves them too). `ne` skips no-op rewrites (e.g. on_hold -> on_hold). This lets
          // awaiting->on_hold AND a later on_hold->shipped both converge.
          notInArray(orders.orderStatus, ['shipped', 'cancelled']),
          ne(orders.orderStatus, orderStatus)
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
export type SyncAccount = {
  label: string;               // for the per-account watermark + logs
  apiKey: string | undefined;  // undefined → use env default
  apiSecret: string | undefined;
  storeIds: number[];
  // When the account is a per-client account (ss_api_key set on a clients
  // row), `ownerClientId` lets upsertOrder attribute orphan orders to that
  // client instead of leaving them at clientId=null.
  ownerClientId: number | null;
};

type SyncClientRow = {
  id: number;
  name: string;
  storeIds: number[] | null;
  ssApiKey: string | null;
  ssApiSecret: string | null;
};

export function buildSyncAccountsFromClientRows(
  clientRows: SyncClientRow[],
): SyncAccount[] {
  // Per user override unlock shipped data on 2026-07-07: per-client
  // ShipStation credential stores must be pulled only through their owning
  // account, otherwise main sync repeats work and can starve awaiting imports.
  const mainStoreIds = [
    ...new Set(
      clientRows.flatMap((row) =>
        row.ssApiKey && row.ssApiSecret
          ? []
          : (row.storeIds ?? []).filter((sid) => !isExcludedStoreId(sid))
      )
    ),
  ];
  const accounts: SyncAccount[] = [
    {
      label: 'main',
      apiKey: undefined,
      apiSecret: undefined,
      storeIds: mainStoreIds,
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
  return buildSyncAccountsFromClientRows(clientRows);
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
  budget: SyncRunBudget = createSyncRunBudget(),
): Promise<{ synced: number; pages: number }> {
  const sinceParam = formatShipStationV1DateParam(args.sinceMs);
  let page = 1;
  let pages = 1;
  let total = 0;
  let pagesThisPass = 0;

  while (!syncRunBudgetTimeExhausted(budget)) {
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
      timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
    });

    pages = res.pages ?? 1;
    // Per user override unlock shipped data on 2026-05-27: this keeps the
    // existing forward-only shipped/cancelled catch-up behavior while routing
    // ShipStation order import through StoreConnector normalized output.
    if (args.statusOnly) {
      total += await updateExistingOrderStatusesBatch(
        res.orders,
        args.orderStatus as CatchUpOrderStatus,
      );
      if (args.orderStatus === 'shipped') {
        total += await upsertMissingShippedOrdersBatch(
          res.orders,
          storeToClient,
          account.ownerClientId,
        );
      }
    } else {
      total += await upsertOrdersBatch(
        res.orders,
        storeToClient,
        account.ownerClientId,
      );
    }

    pagesThisPass += 1;
    if (!res.orders.length || page >= pages) break;
    // PS-265: bound the per-pass pages + run wall-clock so the orders handler finishes UNDER
    // its ~10-min deadline (stops the kill-mid-walk / no-progress / re-pull-same-backlog loop).
    // The window is a fixed lookback re-scanned every run, so a partial pass is re-attempted
    // next run — nothing is permanently skipped.
    if (syncRunBudgetExhausted(budget, pagesThisPass)) break;
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
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>,
  budget: SyncRunBudget = createSyncRunBudget(),
): Promise<{ synced: number; pages: number; sinceIso: string }> {
  const key = watermarkKey(account.label);
  const lastSync =
    opts.sinceMs ??
    (await getSettingNumber(key)) ??
    Date.now() - DEFAULT_LOOKBACK_MS;

  // Smaller default pages keep the background worker below its 10-minute guard
  // while still letting explicit backfills request a larger page size.
  const pageSize = opts.pageSize ?? DEFAULT_ORDER_SYNC_PAGE_SIZE;
  const runStartMs = Date.now();
  const sinceIso = new Date(lastSync).toISOString();

  // v2 parity plus production recovery: ShipStation can move an order from
  // awaiting_shipment to shipped/cancelled without that old awaiting row being
  // revisited by a narrow watermark. Use a 30-day catch-up window so stale DB
  // awaiting counts converge back to ShipStation's live sidebar counts.
  let total = 0;
  let maxPages = 1;
  let failed = false;

  // PS-265: the awaiting_shipment pass (the new orders operators ship TODAY) runs FIRST so a
  // large historical status catch-up can never starve it under the run budget.
  const awaitingSinceMs =
    opts.awaitingSinceMs ?? Math.min(lastSync, runStartMs - AWAITING_CATCHUP_LOOKBACK_MS);
  const awaitingStoreIds = account.storeIds.filter((sid) => !isExcludedStoreId(sid));
  const awaitingTargets =
    awaitingStoreIds.length > 0
      ? awaitingStoreIds.map((storeId) => ({ storeId }))
      : [{ storeId: undefined as number | undefined }];

  for (const target of awaitingTargets) {
    if (syncRunBudgetTimeExhausted(budget)) break;
    try {
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: 'awaiting_shipment',
        sinceMs: awaitingSinceMs,
        pageSize,
        storeId: target.storeId,
      }, budget);
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

  // Status catch-up passes run AFTER awaiting and only while run-budget time remains. The
  // window is a fixed 30-day lookback re-scanned every run (idempotent), so a partial pass
  // is re-attempted next run — this just stops the orders handler from overrunning its deadline.
  const catchupSinceMs = Math.min(lastSync, runStartMs - STATUS_CATCHUP_LOOKBACK_MS);
  const passes: Array<{ orderStatus: string; sinceMs: number }> = [
    ...(opts.skipStatusPasses
      ? []
      : [
          { orderStatus: 'shipped', sinceMs: catchupSinceMs },
          { orderStatus: 'cancelled', sinceMs: catchupSinceMs },
          // Per user override unlock shipped data on 2026-06-10: pull the non-awaiting/non-shipped SS
          // states so PrepShip's awaiting list matches ShipStation's sidebar. These move awaiting ->
          // on_hold / awaiting_payment / pending_fulfillment (NO inventory side effect); they auto-revert
          // to awaiting via the import upsert when ShipStation un-holds them, and still convert to
          // shipped/cancelled via those passes (the widened WHERE catches them).
          { orderStatus: 'on_hold', sinceMs: catchupSinceMs },
          { orderStatus: 'awaiting_payment', sinceMs: catchupSinceMs },
          { orderStatus: 'pending_fulfillment', sinceMs: catchupSinceMs },
        ]),
  ];

  for (const pass of passes) {
    // PS-265: stop starting status catch-up passes once the run is out of time budget; the
    // fixed 30-day window is re-scanned next run, so nothing is permanently skipped.
    if (syncRunBudgetTimeExhausted(budget)) break;
    try {
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: pass.orderStatus,
        sinceMs: pass.sinceMs,
        pageSize,
        statusOnly: true,
      }, budget);
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
  // PS-265: one run-wide budget bounds the WHOLE orders handler (all accounts + passes) under
  // its ~10-min deadline, so it returns and advances watermarks instead of being killed
  // mid-walk with no progress (the loop that re-pulled the same backlog and drained nothing).
  const budget = createSyncRunBudget();
  const storeToClient = await buildStoreToClientMap();
  const accounts = await loadSyncAccounts();

  let grandTotal = 0;
  let maxPages = 1;
  let earliestSinceIso = new Date(runStartMs).toISOString();

  for (const acct of accounts) {
    try {
      const result = await syncOrdersForAccount(acct, opts, storeToClient, budget);
      grandTotal += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
      if (result.sinceIso < earliestSinceIso) earliestSinceIso = result.sinceIso;
    } catch (err) {
      console.error(
        `[order-sync] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
    // PS-265: stop starting new accounts once the run is out of time budget; their watermarks
    // are unchanged, so they resume on the next run (fair round-robin across runs).
    if (syncRunBudgetTimeExhausted(budget)) break;
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
