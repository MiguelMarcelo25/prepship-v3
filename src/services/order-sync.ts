import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { printQueue } from '../db/schema/print-queue';
import { ssV1Request } from '../lib/shipstation/v1-client';
import { getSettingNumber, setSetting } from './settings';
import { isExcludedStoreId } from '../config/prepship';
import { replaceOrderItemsForExternalOrderIds } from './order-items';
import { buildShipStationOrderSource } from './normalized-order-persistence';
import { deductInventoryForOrder } from './fulfillment-deductions';

const LAST_SYNC_KEY = 'order_sync.last_modified_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30 days on first run
const STATUS_CATCHUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const AWAITING_CATCHUP_LOOKBACK_MS = STATUS_CATCHUP_LOOKBACK_MS;

type SSOrder = {
  orderId: number;
  orderNumber: string;
  orderKey?: string;
  orderStatus: string;
  orderDate?: string;
  modifyDate?: string;
  customerEmail?: string | null;
  shipTo?: {
    name?: string;
    company?: string | null;
    street1?: string;
    street2?: string | null;
    street3?: string | null;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    phone?: string | null;
    residential?: boolean | null;
  };
  weight?: { value: number; units: 'ounces' | 'pounds' | 'grams'; WeightUnits?: number };
  carrierCode?: string | null;
  serviceCode?: string | null;
  orderTotal?: number | null;
  shippingAmount?: number | null;
  items?: unknown[];
  externallyFulfilled?: boolean | null;
  externally_shipped?: boolean | null;
  advancedOptions?: {
    storeId?: number | null;
    nonMachinable?: boolean | null;
  } | null;
};

// Derive ShipStation's "externally shipped" / "externally fulfilled" signal
// from any of three flag names the platform has used over the years. Returns
// true only when affirmatively set — callers treat a falsy result as "don't
// touch the DB value" so the sync doesn't clobber a user-set flag.
function externallyShippedFromRaw(o: SSOrder): boolean {
  return Boolean(
    o.externallyFulfilled === true ||
      o.externally_shipped === true ||
      o.advancedOptions?.nonMachinable === true
  );
}

type SSOrdersList = {
  orders: SSOrder[];
  total: number;
  page: number;
  pages: number;
};

function toOunces(w?: SSOrder['weight']): number | null {
  if (!w || typeof w.value !== 'number') return null;
  switch (w.units) {
    case 'ounces':
      return w.value;
    case 'pounds':
      return w.value * 16;
    case 'grams':
      return w.value / 28.3495;
    default:
      return w.value;
  }
}

function formatSSDate(ms: number): string {
  // yyyy-MM-dd HH:mm:ss in UTC
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseShipStationDate(value?: string): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // ShipStation V1 returns timestamps like "2026-04-23T21:35:42.0000000"
  // with no timezone. Treat those as UTC so local dev and Render do not write
  // different order_date values into the shared DB.
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = new Date(hasZone ? trimmed : `${trimmed}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumericString(n?: number | null): string {
  return Number.isFinite(n as number) ? (n as number).toFixed(2) : '0';
}

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
async function upsertOrdersBatch(
  ordersIn: SSOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): Promise<number> {
  if (!ordersIn.length) return 0;

  type Row = typeof orders.$inferInsert;
  const rows: Row[] = [];

  for (const o of ordersIn) {
    const storeId = o.advancedOptions?.storeId ?? null;
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
    const source = buildShipStationOrderSource({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      storeId,
      raw: o as unknown as Record<string, unknown>,
    });
    rows.push({
      externalOrderId: String(o.orderId),
      sourceProvider: source.sourceProvider,
      sourceAccountId: source.sourceAccountId,
      sourceOrderId: source.sourceOrderId,
      sourceOrderNumber: source.sourceOrderNumber,
      rawSourcePayload: source.rawSourcePayload,
      orderNumber: o.orderNumber,
      orderStatus: o.orderStatus,
      orderDate: parseShipStationDate(o.orderDate),
      clientId,
      storeId,
      customerEmail: o.customerEmail ?? null,
      shipToName: o.shipTo?.name ?? null,
      shipToCity: o.shipTo?.city ?? null,
      shipToState: o.shipTo?.state ?? null,
      shipToPostalCode: o.shipTo?.postalCode ?? null,
      carrierCode: o.carrierCode ?? null,
      serviceCode: o.serviceCode ?? null,
      weightOz: toOunces(o.weight),
      orderTotal: toNumericString(o.orderTotal),
      shippingAmount: toNumericString(o.shippingAmount),
      items: (o.items as unknown[]) ?? [],
      raw: o as unknown as Record<string, unknown>,
      externallyShipped: externallyShippedFromRaw(o),
      updatedAt: new Date(),
    });
  }

  if (!rows.length) return 0;

  // EXCLUDED-based ON CONFLICT DO UPDATE. The externally_shipped CASE
  // preserves any already-true DB value when the incoming row is false
  // (matches the old per-row logic).
  await db
    .insert(orders)
    .values(rows)
    .onConflictDoUpdate({
      target: orders.externalOrderId,
      set: {
        orderNumber: sql`excluded.order_number`,
        sourceProvider: sql`excluded.source_provider`,
        sourceAccountId: sql`excluded.source_account_id`,
        sourceOrderId: sql`excluded.source_order_id`,
        sourceOrderNumber: sql`excluded.source_order_number`,
        rawSourcePayload: sql`excluded.raw_source_payload`,
        // ─── SHIPPED-STATUS RACE PROTECTION ─────────────────────────────
        // Once an order is locally marked 'shipped' or 'cancelled' (via
        // labels.ts createLabelV2 → markOrderShipped), it must NOT be
        // downgraded back to 'awaiting_shipment' by a subsequent sync.
        // Why this matters: when we print a label, our local UPDATE flips
        // status to 'shipped' instantly, and a background v1 mark-shipped
        // call tells ShipStation. ShipStation typically takes 30-60
        // seconds to reflect that change in its read APIs. Any sync run
        // in that window pulls the order back as 'awaiting_shipment' and
        // the previous unconditional `excluded.order_status` overwrote
        // our local 'shipped' — leaving the user looking at a print
        // queue that won't clear, and causing the inventory ledger to
        // double-deduct on a repeat print.
        //
        // The CASE statement below preserves our local terminal state
        // when ShipStation reports the order as still awaiting; in every
        // other transition path (awaiting → shipped via SS, awaiting →
        // cancelled, or shipped → cancelled), we accept ShipStation's
        // view as the source of truth.
        //
        // Per user override `unlock shipped data` on 2026-05-06.
        orderStatus: sql`case
          when ${orders.orderStatus} in ('shipped', 'cancelled')
            and excluded.order_status = 'awaiting_shipment'
            then ${orders.orderStatus}
          else excluded.order_status
        end`,
        orderDate: sql`excluded.order_date`,
        clientId: sql`excluded.client_id`,
        storeId: sql`excluded.store_id`,
        customerEmail: sql`excluded.customer_email`,
        shipToName: sql`excluded.ship_to_name`,
        shipToCity: sql`excluded.ship_to_city`,
        shipToState: sql`excluded.ship_to_state`,
        shipToPostalCode: sql`excluded.ship_to_postal_code`,
        carrierCode: sql`excluded.carrier_code`,
        serviceCode: sql`excluded.service_code`,
        weightOz: sql`excluded.weight_oz`,
        orderTotal: sql`excluded.order_total`,
        shippingAmount: sql`excluded.shipping_amount`,
        items: sql`excluded.items`,
        raw: sql`excluded.raw`,
        externallyShipped: sql`case when excluded.externally_shipped = true then true else orders.externally_shipped end`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  await replaceOrderItemsForExternalOrderIds(
    rows
      .map((row) => row.externalOrderId)
      .filter((id): id is string => Boolean(id))
  );

  return rows.length;
}

async function updateExistingOrderStatusesBatch(
  ordersIn: SSOrder[],
  orderStatus: 'shipped' | 'cancelled'
): Promise<number> {
  const externalIds = Array.from(
    new Set(
      ordersIn
        .map((o) => (o.orderId == null ? null : String(o.orderId)))
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

    // Auto-cleanup print queue: any orders we just flipped to
    // shipped/cancelled should have their pending queue entries
    // removed so the queue panel doesn't show stale entries
    // pointing at orders that no longer need printing.
    // Fire-and-forget (try/catch) — sync must not fail because of
    // a queue cleanup hiccup.
    if (rows.length > 0) {
      try {
        const orderIdsForCleanup = rows.map((r) => String(r.id));
        const removed = await db
          .delete(printQueue)
          .where(inArray(printQueue.orderId, orderIdsForCleanup))
          .returning({ id: printQueue.id });
        if (removed.length > 0) {
          console.info(
            `[order-sync] removed ${removed.length} queue entries for orders flipped to ${orderStatus}`
          );
        }
      } catch (err) {
        console.warn(
          `[order-sync] queue cleanup failed (non-fatal):`,
          err instanceof Error ? err.message : err
        );
      }
    }
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
  const sinceParam = formatSSDate(args.sinceMs);
  let page = 1;
  let pages = 1;
  let total = 0;

  while (true) {
    const q = new URLSearchParams({
      orderStatus: args.orderStatus,
      modifyDateStart: sinceParam,
      pageSize: String(args.pageSize),
      page: String(page),
      sortBy: 'ModifyDate',
      sortDir: 'ASC',
    });
    if (args.storeId !== undefined) q.set('storeId', String(args.storeId));

    const res = await ssV1Request<SSOrdersList>(`/orders?${q.toString()}`, {
      apiKey: account.apiKey,
      apiSecret: account.apiSecret,
      dedupeKey: `orders:list:${account.label}:${args.orderStatus}:${args.storeId ?? 'all'}:${sinceParam}:${page}:${args.pageSize}`,
    });

    pages = res.pages;
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

    if (!res.orders.length || page >= res.pages) break;
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
