import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { clients } from '../db/schema/clients';
import { ssV1Request } from '../lib/shipstation/v1-client';
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

async function upsertShipment(s: SSShipment) {
  // Find the matching order row by externalOrderId.
  const [order] = await db
    .select({ id: orders.id, clientId: orders.clientId })
    .from(orders)
    .where(eq(orders.externalOrderId, String(s.orderId)))
    .limit(1);

  // Skip entirely if this shipment belongs to a test-flagged client.
  // Test clients never get real ShipStation shipment rows written to them.
  if (order?.clientId) {
    const [cli] = await db
      .select({ isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, order.clientId))
      .limit(1);
    if (cli?.isTest) return { inserted: false, matched: true };
  }

  const values = {
    orderId: order?.id ?? null,
    clientId: order?.clientId ?? null,
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

  // Find an existing shipment row by labelShipmentId to avoid duplicates.
  const [existing] = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(eq(shipments.labelShipmentId, s.shipmentId))
    .limit(1);

  if (existing) {
    await db.update(shipments).set(values).where(eq(shipments.id, existing.id));
    return { inserted: false, matched: order != null };
  }

  await db.insert(shipments).values(values);
  return { inserted: true, matched: order != null };
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
};

async function loadShipmentSyncAccounts(): Promise<ShipmentSyncAccount[]> {
  const accounts: ShipmentSyncAccount[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined },
  ];
  const rows = await db
    .select({
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.active, true));
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
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
  const pageSize = opts.pageSize ?? 250;
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

        for (const s of res.shipments) {
          const result = await upsertShipment(s);
          totalFetched += 1;
          if (result.inserted) totalInserted += 1;
          else totalUpdated += 1;
          if (result.matched) totalMatched += 1;

          if (result.matched) {
            const [order] = await db
              .select({ id: orders.id, status: orders.orderStatus })
              .from(orders)
              .where(eq(orders.externalOrderId, String(s.orderId)))
              .limit(1);
            if (order && order.status === 'awaiting_shipment') {
              shippedOrderIds.push(order.id);
            }
          }
        }

        if (!res.shipments.length || page >= res.pages) break;
        page += 1;
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
