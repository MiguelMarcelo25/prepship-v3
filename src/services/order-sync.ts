import { eq, sql } from 'drizzle-orm';
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

async function buildStoreToClientMap(): Promise<{
  byStore: Map<number, number>;
  testClients: Set<number>;
  newPairs: Array<{ storeId: number; clientId: number }>;
}> {
  const rows = await db
    .select({ id: clients.id, storeIds: clients.storeIds, isTest: clients.isTest })
    .from(clients);
  const byStore = new Map<number, number>();
  const testClients = new Set<number>();
  for (const c of rows) {
    for (const sid of c.storeIds ?? []) byStore.set(sid, c.id);
    if (c.isTest) testClients.add(c.id);
  }
  return { byStore, testClients, newPairs: [] };
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
//   • isTest clients are filtered out before the insert (never hit the DB)
//   • fallbackClientId auto-attaches orders to their owner account
//   • externallyShipped is only overwritten when the incoming row
//     affirmatively sets it (preserves user-set flags on routine syncs)
async function upsertOrdersBatch(
  ordersIn: SSOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    testClients: Set<number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): Promise<number> {
  if (!ordersIn.length) return 0;

  type Row = typeof orders.$inferInsert;
  const rows: Row[] = [];

  for (const o of ordersIn) {
    const storeId = o.advancedOptions?.storeId ?? null;
    let clientId =
      storeId !== null ? storeToClient.byStore.get(storeId) ?? null : null;
    if (clientId === null && fallbackClientId !== null) {
      clientId = fallbackClientId;
      if (storeId !== null) {
        storeToClient.byStore.set(storeId, fallbackClientId);
        storeToClient.newPairs?.push({ storeId, clientId: fallbackClientId });
      }
    }
    if (clientId !== null && storeToClient.testClients.has(clientId)) continue;

    rows.push({
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
        orderStatus: sql`excluded.order_status`,
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

  return rows.length;
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
  // When the account is a per-client account (ss_api_key set on a clients
  // row), `ownerClientId` lets upsertOrder attribute orphan orders to that
  // client instead of leaving them at clientId=null.
  ownerClientId: number | null;
};

async function loadSyncAccounts(): Promise<SyncAccount[]> {
  const accounts: SyncAccount[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined, ownerClientId: null },
  ];
  const rows = await db
    .select({
      id: clients.id,
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

async function syncOrdersForAccount(
  account: SyncAccount,
  opts: { sinceMs?: number; pageSize?: number },
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>
): Promise<{ synced: number; pages: number; sinceIso: string }> {
  const key = watermarkKey(account.label);
  const lastSync =
    opts.sinceMs ??
    (await getSettingNumber(key)) ??
    Date.now() - DEFAULT_LOOKBACK_MS;

  // v2-parity: pageSize=500 (v4 used 250). Matches apps/api/src/common/shipstation/client.ts:247
  // v1Pages helper. Halves round-trip count for the same data volume.
  const pageSize = opts.pageSize ?? 500;
  const runStartMs = Date.now();
  const sinceIso = new Date(lastSync).toISOString();
  const sinceParam = formatSSDate(lastSync);

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
      apiKey: account.apiKey,
      apiSecret: account.apiSecret,
      dedupeKey: `orders:list:${account.label}:${sinceParam}:${page}:${pageSize}`,
    });

    pages = res.pages;

    // One INSERT per page (~500 orders) instead of per-row round-trips —
    // turns a ~45 min backfill into a ~5 min one.
    total += await upsertOrdersBatch(
      res.orders,
      storeToClient,
      account.ownerClientId
    );

    if (!res.orders.length || page >= res.pages) break;
    page += 1;
    // v2-parity: 500ms inter-page delay. Matches apps/api/src/common/shipstation/client.ts:268
    // v1Pages. Keeps the token bucket healthy over long backfills.
    await new Promise((r) => setTimeout(r, 500));
  }

  await setSetting(key, String(runStartMs));
  return { synced: total, pages, sinceIso };
}

export async function syncOrders(opts: {
  sinceMs?: number;
  pageSize?: number;
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

export async function getSyncStatus(): Promise<{
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
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders);
  return { lastSyncedAt, orderCount: rows[0]?.count ?? 0 };
}
