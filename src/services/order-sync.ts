import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { ssV1Request } from '../lib/shipstation/v1-client';
import { getSettingNumber, setSetting } from './settings';

const LAST_SYNC_KEY = 'order_sync.last_modified_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30 days on first run

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

function toNumericString(n?: number | null): string {
  return Number.isFinite(n as number) ? (n as number).toFixed(2) : '0';
}

async function buildStoreToClientMap(): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
  const map = new Map<number, number>();
  for (const c of rows) {
    for (const sid of c.storeIds ?? []) map.set(sid, c.id);
  }
  return map;
}

async function upsertOrder(
  o: SSOrder,
  storeToClient: Map<number, number>
) {
  const storeId = o.advancedOptions?.storeId ?? null;
  const clientId = storeId !== null ? storeToClient.get(storeId) ?? null : null;
  const externallyShipped = externallyShippedFromRaw(o);
  const values = {
    externalOrderId: String(o.orderId),
    orderNumber: o.orderNumber,
    orderStatus: o.orderStatus,
    orderDate: o.orderDate ? new Date(o.orderDate) : null,
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
    externallyShipped,
    updatedAt: new Date(),
  };

  // Base SET for the upsert. externallyShipped is only included when the
  // ShipStation payload AFFIRMATIVELY sets a flag — otherwise the existing
  // DB value is preserved (protects user-set flags from being clobbered
  // back to false on a routine sync).
  const updateSet: Record<string, unknown> = {
    orderNumber: values.orderNumber,
    orderStatus: values.orderStatus,
    orderDate: values.orderDate,
    clientId: values.clientId,
    storeId: values.storeId,
    customerEmail: values.customerEmail,
    shipToName: values.shipToName,
    shipToCity: values.shipToCity,
    shipToState: values.shipToState,
    shipToPostalCode: values.shipToPostalCode,
    carrierCode: values.carrierCode,
    serviceCode: values.serviceCode,
    weightOz: values.weightOz,
    orderTotal: values.orderTotal,
    shippingAmount: values.shippingAmount,
    items: values.items,
    raw: values.raw,
    updatedAt: values.updatedAt,
  };
  if (externallyShipped) updateSet.externallyShipped = true;

  await db
    .insert(orders)
    .values(values)
    .onConflictDoUpdate({
      target: orders.externalOrderId,
      set: updateSet,
    });
}

export type SyncResult = {
  synced: number;
  pages: number;
  lastSyncedAt: string;
  sinceIso: string;
};

export async function syncOrders(opts: {
  sinceMs?: number;
  pageSize?: number;
} = {}): Promise<SyncResult> {
  const lastSync =
    opts.sinceMs ??
    (await getSettingNumber(LAST_SYNC_KEY)) ??
    Date.now() - DEFAULT_LOOKBACK_MS;

  const pageSize = opts.pageSize ?? 250;
  const runStartMs = Date.now();
  const sinceIso = new Date(lastSync).toISOString();
  const sinceParam = formatSSDate(lastSync);
  const storeToClient = await buildStoreToClientMap();

  let page = 1;
  let pages = 1;
  let total = 0;

  while (true) {
    const q = new URLSearchParams({
      modifyDateStart: sinceParam,
      pageSize: String(pageSize),
      page: String(page),
      sortBy: 'ModifyDate',
      sortDir: 'ASC',
    });

    const res = await ssV1Request<SSOrdersList>(`/orders?${q.toString()}`, {
      dedupeKey: `orders:list:${sinceParam}:${page}:${pageSize}`,
    });

    pages = res.pages;

    for (const o of res.orders) {
      await upsertOrder(o, storeToClient);
      total += 1;
    }

    if (!res.orders.length || page >= res.pages) break;
    page += 1;
  }

  await setSetting(LAST_SYNC_KEY, String(runStartMs));
  return {
    synced: total,
    pages,
    lastSyncedAt: new Date(runStartMs).toISOString(),
    sinceIso,
  };
}

export async function getSyncStatus(): Promise<{
  lastSyncedAt: string | null;
  orderCount: number;
}> {
  const ms = await getSettingNumber(LAST_SYNC_KEY);
  const lastSyncedAt = ms ? new Date(ms).toISOString() : null;
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders);
  return { lastSyncedAt, orderCount: rows[0]?.count ?? 0 };
}
