import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { clients } from '../db/schema/clients';
import { ssV1Request } from '../lib/shipstation/v1-client';
import { ssRequest } from '../lib/shipstation/client';
import { getSettingNumber, setSetting } from './settings';

const LAST_SYNC_KEY = 'shipment_sync.last_created_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 7; // 7 days on first run

type SSShipment = {
  shipmentId: number;
  orderId: number;
  orderKey?: string | null;
  orderNumber?: string | null;
  userId?: string | null;
  customerEmail?: string | null;
  createDate?: string | null;
  shipDate?: string | null;
  shipmentCost?: number | null;
  insuranceCost?: number | null;
  trackingNumber?: string | null;
  isReturnLabel?: boolean | null;
  batchNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  packageCode?: string | null;
  confirmation?: string | null;
  warehouseId?: number | null;
  voided?: boolean | null;
  voidDate?: string | null;
  marketplaceNotified?: boolean | null;
  notifyErrorMessage?: string | null;
  shipTo?: Record<string, unknown> | null;
  weight?: { value: number; units: string } | null;
  dimensions?: { length: number; width: number; height: number } | null;
  advancedOptions?: { storeId?: number | null } | null;
  shipmentItems?: unknown[] | null;
  labelData?: string | null;
  formData?: string | null;
};

type SSShipmentsList = {
  shipments: SSShipment[];
  total: number;
  page: number;
  pages: number;
};

function formatSSDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function toOunces(w?: SSShipment['weight']): number | null {
  if (!w || typeof w.value !== 'number') return null;
  switch ((w.units ?? '').toLowerCase()) {
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

function toNumeric(n?: number | null): string | null {
  return Number.isFinite(n as number) ? (n as number).toFixed(2) : null;
}

type ShipmentValues = typeof shipments.$inferInsert;

function shipmentValues(
  s: SSShipment,
  orderId: number | null,
  clientId: number | null
): ShipmentValues {
  return {
    orderId,
    clientId,
    orderNumber: s.orderNumber ?? null,
    carrierCode: s.carrierCode ?? null,
    serviceCode: s.serviceCode ?? null,
    trackingNumber: s.trackingNumber ?? null,
    shipDate: s.shipDate ? new Date(s.shipDate) : null,
    createDate: s.createDate ? new Date(s.createDate) : null,
    weightOz: toOunces(s.weight),
    dimsL: s.dimensions?.length ?? null,
    dimsW: s.dimensions?.width ?? null,
    dimsH: s.dimensions?.height ?? null,
    cost: toNumeric(s.shipmentCost),
    labelTracking: s.trackingNumber ?? null,
    labelCarrier: s.carrierCode ?? null,
    labelService: s.serviceCode ?? null,
    labelShipDate: s.shipDate ? new Date(s.shipDate) : null,
    labelShipmentId: s.shipmentId,
    voided: Boolean(s.voided),
    source: 'shipstation',
    isReturn: Boolean(s.isReturnLabel),
    updatedAt: new Date(),
  };
}

// Batched upsert — one page of shipments becomes (at most) four DB
// round-trips total instead of 5 per shipment. ~10x faster than the
// old per-row loop.
//
// Flow:
//   1. Pre-fetch every matching order in one query (by externalOrderId IN ...)
//   2. Pre-fetch every isTest client flag in one query
//   3. Pre-fetch every existing shipment (by labelShipmentId IN ...)
//   4. Split into inserts (new) + updates (existing), then run them
//      in parallel with a small concurrency cap for the updates.
async function upsertShipmentsBatch(pageShipments: SSShipment[]): Promise<{
  inserted: number;
  updated: number;
  matched: number;
  shippedOrderIds: number[];
}> {
  if (!pageShipments.length) {
    return { inserted: 0, updated: 0, matched: 0, shippedOrderIds: [] };
  }

  const externalIds = [...new Set(pageShipments.map((s) => String(s.orderId)))];
  const labelIds = [...new Set(pageShipments.map((s) => s.shipmentId))];

  // 1. Orders lookup
  const orderRows = externalIds.length
    ? await db
        .select({
          id: orders.id,
          clientId: orders.clientId,
          externalOrderId: orders.externalOrderId,
          status: orders.orderStatus,
        })
        .from(orders)
        .where(inArray(orders.externalOrderId, externalIds))
    : [];
  const orderByExt = new Map<
    string,
    { id: number; clientId: number | null; status: string }
  >();
  for (const o of orderRows) {
    if (o.externalOrderId) {
      orderByExt.set(o.externalOrderId, {
        id: o.id,
        clientId: o.clientId ?? null,
        status: o.status,
      });
    }
  }

  // 2. Test clients lookup — single query for all unique client IDs we saw
  const clientIds = [
    ...new Set(orderRows.map((o) => o.clientId).filter((id): id is number => id !== null)),
  ];
  const testClientSet = new Set<number>();
  if (clientIds.length) {
    const cliRows = await db
      .select({ id: clients.id, isTest: clients.isTest })
      .from(clients)
      .where(inArray(clients.id, clientIds));
    for (const c of cliRows) if (c.isTest) testClientSet.add(c.id);
  }

  // 3. Existing shipments lookup
  const existingRows = labelIds.length
    ? await db
        .select({ id: shipments.id, labelShipmentId: shipments.labelShipmentId })
        .from(shipments)
        .where(inArray(shipments.labelShipmentId, labelIds))
    : [];
  const existingByLabel = new Map<number, number>();
  for (const r of existingRows) {
    if (r.labelShipmentId !== null) existingByLabel.set(r.labelShipmentId, r.id);
  }

  // Build insert / update batches
  const toInsert: ShipmentValues[] = [];
  const toUpdate: Array<{ id: number; values: ShipmentValues }> = [];
  let matched = 0;
  const shippedOrderIds: number[] = [];

  for (const s of pageShipments) {
    const ord = orderByExt.get(String(s.orderId));
    // Test-client guard: skip entirely if matched order's client is isTest
    if (ord?.clientId && testClientSet.has(ord.clientId)) continue;

    if (ord) {
      matched += 1;
      if (ord.status === 'awaiting_shipment') shippedOrderIds.push(ord.id);
    }

    const values = shipmentValues(s, ord?.id ?? null, ord?.clientId ?? null);
    const existingId = existingByLabel.get(s.shipmentId);
    if (existingId !== undefined) {
      toUpdate.push({ id: existingId, values });
    } else {
      toInsert.push(values);
    }
  }

  // 4a. Single INSERT for all new rows (chunk to 500 to stay below pg param limits)
  let inserted = 0;
  const chunkSize = 500;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize);
    if (chunk.length) {
      await db.insert(shipments).values(chunk);
      inserted += chunk.length;
    }
  }

  // 4b. Parallel UPDATEs (no single-statement way to update N rows with
  // different values; use limited concurrency to avoid pooler saturation).
  // Supabase's default pgbouncer pool tops out at 15 shared connections —
  // 3-at-a-time leaves headroom for other API traffic + the 3-min scheduler.
  const updateConcurrency = 3;
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += updateConcurrency) {
    const batch = toUpdate.slice(i, i + updateConcurrency);
    await Promise.all(
      batch.map((u) =>
        db.update(shipments).set(u.values).where(eq(shipments.id, u.id))
      )
    );
    updated += batch.length;
  }

  return { inserted, updated, matched, shippedOrderIds };
}

export type ShipmentSyncResult = {
  fetched: number;
  inserted: number;
  updated: number;
  matchedOrders: number;
  orphaned: number; // shipments with no matching order row
  ordersMarkedShipped: number;
  pages: number;
  lastSyncedAt: string;
  sinceIso: string;
};

type ShipmentSyncAccount = {
  label: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  // v2-parity: V2 key is used for the /v2/shipments enrichment pass (which
  // fills in providerAccountId). null when a client has no V2 key set —
  // enrichment skips that account. Main account uses env.SHIPSTATION_API_KEY_V2.
  apiKeyV2: string | null;
};

async function loadShipmentSyncAccounts(): Promise<ShipmentSyncAccount[]> {
  // Main account's V2 key comes from env; ssRequest already falls back to
  // env.SHIPSTATION_API_KEY_V2 when apiKey is undefined, so we mirror that
  // explicitly here so the enrichment pass knows whether it can run for main.
  const { env } = await import('../lib/env');
  const accounts: ShipmentSyncAccount[] = [
    {
      label: 'main',
      apiKey: undefined,
      apiSecret: undefined,
      apiKeyV2: env.SHIPSTATION_API_KEY_V2 ?? null,
    },
  ];
  const rows = await db
    .select({
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
      ssApiKeyV2: clients.ssApiKeyV2,
    })
    .from(clients)
    .where(eq(clients.active, true));
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
        apiKeyV2: r.ssApiKeyV2 ?? null,
      });
    }
  }
  return accounts;
}

function shipWatermarkKey(label: string): string {
  return label === 'main' ? LAST_SYNC_KEY : `${LAST_SYNC_KEY}:${label}`;
}

/**
 * Pull shipments from ShipStation v1 that were created after the last sync.
 * Upsert each into our shipments table and — when the matching order is
 * still in "awaiting_shipment" — flip it to "shipped".
 *
 * Iterates every active ShipStation account (env-main + per-client
 * ss_api_key) so multi-org setups (e.g. DR Prepper + KFG) both land in
 * our local shipments table. Runs ONE pass per account.
 */
export async function syncShipments(
  opts: { sinceMs?: number; pageSize?: number } = {}
): Promise<ShipmentSyncResult> {
  // v2-parity: pageSize=500 matches v2's v1Pages helper default.
  const pageSize = opts.pageSize ?? 500;
  const runStartMs = Date.now();

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalMatched = 0;
  let maxPages = 1;
  let earliestSinceIso = new Date(runStartMs).toISOString();
  const shippedOrderIds: number[] = [];

  const accounts = await loadShipmentSyncAccounts();
  for (const acct of accounts) {
    try {
      const key = shipWatermarkKey(acct.label);
      const lastSync =
        opts.sinceMs ??
        (await getSettingNumber(key)) ??
        Date.now() - DEFAULT_LOOKBACK_MS;
      const sinceIso = new Date(lastSync).toISOString();
      if (sinceIso < earliestSinceIso) earliestSinceIso = sinceIso;
      const sinceParam = formatSSDate(lastSync);

      let page = 1;
      while (true) {
        const q = new URLSearchParams({
          createDateStart: sinceParam,
          pageSize: String(pageSize),
          page: String(page),
          sortBy: 'CreateDate',
          sortDir: 'ASC',
        });

        const res = await ssV1Request<SSShipmentsList>(
          `/shipments?${q.toString()}`,
          {
            apiKey: acct.apiKey,
            apiSecret: acct.apiSecret,
            dedupeKey: `shipments:list:${acct.label}:${sinceParam}:${page}:${pageSize}`,
          }
        );
        if (res.pages > maxPages) maxPages = res.pages;

        // One batched upsert per page (pre-fetches orders + clients + existing
        // shipments, splits into bulk INSERT + parallel UPDATEs). Per-row loop
        // was the bottleneck — this is ~10x faster.
        const batch = await upsertShipmentsBatch(res.shipments);
        totalFetched += res.shipments.length;
        totalInserted += batch.inserted;
        totalUpdated += batch.updated;
        totalMatched += batch.matched;
        shippedOrderIds.push(...batch.shippedOrderIds);

        if (!res.shipments.length || page >= res.pages) break;
        page += 1;
        // v2-parity: 500ms inter-page delay.
        await new Promise((r) => setTimeout(r, 500));
      }

      // v2-parity: enrichment pass. v1's /shipments endpoint doesn't expose
      // the numeric `carrierId` (provider account ID) — v2 runs a V2
      // `/v2/shipments` page over the same time window and backfills
      // `shipments.providerAccountId` by matching on tracking number.
      // Mirrors apps/api/src/modules/shipments/application/shipment-services.ts:132.
      try {
        const enriched = await enrichProviderAccountIds(acct, lastSync);
        if (enriched > 0) {
          console.log(
            `[shipment-sync] enriched providerAccountId on ${enriched} shipments for "${acct.label}"`
          );
        }
      } catch (err) {
        // Best-effort enrichment — never block the V1 sync on V2 failures.
        console.warn(
          `[shipment-sync] V2 enrichment failed for "${acct.label}":`,
          (err as Error).message
        );
      }

      await setSetting(key, String(runStartMs));
    } catch (err) {
      console.error(
        `[shipment-sync] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
  }

  let ordersMarkedShipped = 0;
  if (shippedOrderIds.length) {
    const uniqueIds = Array.from(new Set(shippedOrderIds));
    const result = await db.execute<{ updated: number }>(sql`
      with u as (
        update orders
           set order_status = 'shipped', updated_at = now()
         where id = any(${uniqueIds})
           and order_status = 'awaiting_shipment'
         returning 1
      )
      select count(*)::int as updated from u
    `);
    ordersMarkedShipped = result[0]?.updated ?? 0;
  }

  const fetched = totalFetched;
  const inserted = totalInserted;
  const updated = totalUpdated;
  const matchedOrders = totalMatched;
  const pages = maxPages;
  const sinceIso = earliestSinceIso;

  return {
    fetched,
    inserted,
    updated,
    matchedOrders,
    orphaned: fetched - matchedOrders,
    ordersMarkedShipped,
    pages,
    lastSyncedAt: new Date(runStartMs).toISOString(),
    sinceIso,
  };
}

export async function getShipmentSyncStatus(): Promise<{
  lastSyncedAt: string | null;
  shipmentCount: number;
}> {
  const ms = await getSettingNumber(LAST_SYNC_KEY);
  const lastSyncedAt = ms ? new Date(ms).toISOString() : null;
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shipments);
  return { lastSyncedAt, shipmentCount: rows[0]?.count ?? 0 };
}

// v2-parity: V2 shipments enrichment. The V1 /shipments endpoint doesn't
// expose ShipStation's numeric carrier id (the "provider account" that billing
// reconciliation keys on). v2 runs a second V2 `/v2/shipments` pass over the
// same window and backfills `shipments.providerAccountId` + the nickname by
// matching on tracking_number (unique per SS shipment).
//
// Source: apps/api/src/modules/labels/data/shipstation-shipping-gateway.ts:293-314
// + apps/api/src/modules/shipments/application/shipment-services.ts:132.
async function enrichProviderAccountIds(
  acct: { label: string; apiKeyV2: string | null },
  sinceMs: number,
): Promise<number> {
  if (!acct.apiKeyV2) return 0; // No V2 key → can't enrich this account
  const createdAtStart = new Date(sinceMs).toISOString();
  let page = 1;
  let totalUpdated = 0;
  const maxPages = 20; // safety cap — v2 doesn't cap explicitly but 20*500=10k is plenty

  type V2ShipmentRow = {
    shipment_id?: string;
    carrier_id?: string; // "se-12345"
    tracking_number?: string | null;
    external_order_id?: string | null;
  };

  while (page <= maxPages) {
    const qs = new URLSearchParams({
      page_size: '500',
      page: String(page),
      sort_dir: 'DESC',
      created_at_start: createdAtStart,
    });
    let payload: { shipments?: V2ShipmentRow[]; pages?: number };
    try {
      payload = await ssRequest<{ shipments?: V2ShipmentRow[]; pages?: number }>(
        `/v2/shipments?${qs.toString()}`,
        {
          apiKey: acct.apiKeyV2,
          dedupeKey: `v2-shipments:enrich:${acct.label}:${createdAtStart}:${page}`,
        },
      );
    } catch (err) {
      console.warn(
        `[shipment-sync] V2 enrichment page ${page} failed for "${acct.label}":`,
        (err as Error).message,
      );
      break;
    }

    const rows = Array.isArray(payload?.shipments) ? payload.shipments : [];
    if (!rows.length) break;

    for (const row of rows) {
      const tracking = row.tracking_number ?? null;
      if (!tracking) continue;
      const carrierIdStr = typeof row.carrier_id === 'string' ? row.carrier_id : null;
      if (!carrierIdStr) continue;
      const numericCarrierId = Number.parseInt(
        carrierIdStr.replace(/^se-/, ''),
        10,
      );
      if (!Number.isFinite(numericCarrierId)) continue;
      // Only update rows where providerAccountId is null — don't clobber
      // an ID that was set during label creation.
      const result = await db
        .update(shipments)
        .set({ providerAccountId: numericCarrierId, updatedAt: new Date() })
        .where(
          sql`${shipments.trackingNumber} = ${tracking} and ${shipments.providerAccountId} is null`,
        )
        .returning({ id: shipments.id });
      totalUpdated += result.length;
    }

    const totalPages = payload.pages ?? 1;
    if (page >= totalPages || rows.length < 500) break;
    page += 1;
    // v2-parity: gentle inter-page pause
    await new Promise((r) => setTimeout(r, 500));
  }

  return totalUpdated;
}
