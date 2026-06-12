/**
 * PS-199 — canonical owner of Walmart purchaseOrderId resolution.
 *
 * The Walmart Shipping connector requires a Walmart purchaseOrderId (and the
 * raw marketplace order for boxItems / ship-to) before it can quote or buy.
 * The resolution chain lived ONLY in the legacy Vercel functions
 * (api/carriers/rates.ts + api/carriers/labels.ts) and was lost when the Rate
 * Browser moved to v4 /rates/browse — every Walmart Shipping quote in v4
 * failed with "requires a Walmart purchaseOrderId".
 *
 * OWNERSHIP (decided on the PS-199 card, recorded in ARCHITECTURE.md): the
 * LIVE Walmart Marketplace lookup is the owner of customerOrderId →
 * purchaseOrderId translation; the store_orders table is a CACHE in front of
 * it (read before the live call, upserted after a live hit). The legacy
 * Walmart pull only ever populates that cache — it is not required for
 * correctness.
 *
 * Resolution priority (faithful port of the legacy chain):
 *   ① explicit purchaseOrderId from the caller (body)
 *   ② strip the `walmart-` prefix from the order's external id
 *   ③ store_orders cache lookup by external_order_id OR customer_order_id
 *      (also recovers rawOrder + the owning store account id)
 *   ④ live Walmart Marketplace lookup by customerOrderId
 *      (lookupWalmartOrderByCustomerOrderId) — on a hit, upsert the cache
 *
 * Two modes, one owner — quote and label can never diverge:
 *   'rates'  — ④ runs only as a RESCUE when ①–③ found nothing; a final miss
 *              returns purchaseOrderId:null so the connector surfaces its
 *              clean error. The "most-recent walmart row" fallback exists
 *              ONLY when there is no real order context (Settings demo) —
 *              a real order NEVER borrows another order's PO (legacy Fix 1).
 *   'labels' — money path: ④ ALWAYS verifies live when a numeric
 *              customerOrderId candidate exists (replacing a stale cached PO
 *              on mismatch), and any live-verification failure THROWS — a
 *              label is never purchased against an unverified PO. No demo
 *              fallback. (Consumed by PS-202 when v4 owns direct labels.)
 */
import { sql as pg } from '../db/client';
import { lookupWalmartOrderByCustomerOrderId } from '../connectors/store/walmart.js';

export type WalmartPoResolutionMode = 'rates' | 'labels';

export type WalmartPoResolutionInput = {
  /** ① explicit PO from the request body, if the caller had one. */
  purchaseOrderId?: string | null;
  /** Local orders.id — enables the orders lookup AND the no-borrow rule. */
  orderId?: number | null;
  externalOrderId?: string | null;
  orderNumber?: string | null;
  /** Walmart store-account credentials for the live Marketplace lookup. */
  credentials: Record<string, unknown>;
  /** store_accounts row id quoting/buying — attribution for cache upserts. */
  storeAccountId?: number | null;
};

export type WalmartPoResolution = {
  purchaseOrderId: string | null;
  purchaseOrderSource:
    | 'none'
    | 'body.purchaseOrderId'
    | 'orders.external_order_id'
    | 'store_orders lookup'
    | 'walmart_marketplace_api'
    | 'store_orders fallback (settings demo)';
  rawOrder: unknown | null;
};

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The connector needs orderLines (boxItems) or a postal address to build a quote. */
export function walmartRawOrderUsable(rawOrder: any): boolean {
  return Boolean(
    Array.isArray(rawOrder?.orderLines?.orderLine) ||
    rawOrder?.shippingInfo?.postalAddress,
  );
}

type StoreOrderRow = {
  carrier_account_id: number | null;
  external_order_id: string;
  customer_order_id: string | null;
  raw: unknown;
};

async function readStoreOrderCache(candidates: string[]): Promise<StoreOrderRow | null> {
  const [a = '', b = '', c = ''] = candidates;
  if (!a && !b && !c) return null;
  try {
    const rows = await pg<StoreOrderRow[]>`
      SELECT carrier_account_id, external_order_id, customer_order_id, raw FROM store_orders
      WHERE provider = 'walmart'
        AND (
          external_order_id IN (${a}, ${b}, ${c})
          OR customer_order_id IN (${a}, ${b}, ${c})
        )
      ORDER BY last_fetched_at DESC NULLS LAST
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch {
    return null; // cache read is best-effort — the live lookup still rescues
  }
}

/** Cache a live Marketplace hit so the next quote/label skips the API round-trip. */
async function upsertStoreOrderCache(args: {
  purchaseOrderId: string;
  customerOrderId: string | null;
  rawOrder: unknown;
  storeAccountId: number | null;
}): Promise<void> {
  if (args.storeAccountId == null) return; // carrier_account_id is NOT NULL — no attribution, no cache write
  try {
    await pg`
      INSERT INTO store_orders (carrier_account_id, provider, external_order_id, customer_order_id, raw, last_fetched_at, updated_at)
      VALUES (${args.storeAccountId}, 'walmart', ${args.purchaseOrderId}, ${args.customerOrderId}, ${JSON.stringify(args.rawOrder ?? {})}::jsonb, now(), now())
      ON CONFLICT (provider, external_order_id) DO UPDATE SET
        customer_order_id = COALESCE(EXCLUDED.customer_order_id, store_orders.customer_order_id),
        raw = EXCLUDED.raw,
        last_fetched_at = now(),
        updated_at = now()
    `;
  } catch (err) {
    console.warn('[walmart-po] cache upsert skipped:', err instanceof Error ? err.message : err);
  }
}

export async function resolveWalmartPurchaseOrder(
  input: WalmartPoResolutionInput,
  mode: WalmartPoResolutionMode,
): Promise<WalmartPoResolution> {
  let purchaseOrderId = trimmedString(input.purchaseOrderId);
  let purchaseOrderSource: WalmartPoResolution['purchaseOrderSource'] =
    purchaseOrderId ? 'body.purchaseOrderId' : 'none';
  let rawOrder: unknown | null = null;
  let storeAccountId = input.storeAccountId ?? null;

  // Fill order identity from the local orders row when the caller only had an id.
  let externalOrderId = trimmedString(input.externalOrderId);
  let orderNumber = trimmedString(input.orderNumber);
  const orderId =
    typeof input.orderId === 'number' && Number.isFinite(input.orderId)
      ? Math.trunc(input.orderId)
      : null;
  if (orderId && (!externalOrderId || !orderNumber)) {
    try {
      const rows = await pg<Array<{ external_order_id: string | null; order_number: string | null }>>`
        SELECT external_order_id, order_number FROM orders WHERE id = ${orderId} LIMIT 1
      `;
      externalOrderId = externalOrderId ?? trimmedString(rows[0]?.external_order_id);
      orderNumber = orderNumber ?? trimmedString(rows[0]?.order_number);
    } catch { /* non-fatal; fall back to caller-provided ids */ }
  }

  // ② walmart-prefixed external id IS the purchaseOrderId.
  if (!purchaseOrderId && externalOrderId?.startsWith('walmart-')) {
    purchaseOrderId = externalOrderId.slice('walmart-'.length);
    purchaseOrderSource = 'orders.external_order_id';
  }

  // ③ store_orders cache — also recovers rawOrder + the owning account.
  const lookupA = purchaseOrderId ?? '';
  const lookupB = externalOrderId?.startsWith('walmart-')
    ? externalOrderId.slice('walmart-'.length)
    : externalOrderId ?? '';
  const lookupC = orderNumber ?? '';
  const cached = await readStoreOrderCache([lookupA, lookupB, lookupC]);
  if (cached) {
    purchaseOrderId = cached.external_order_id;
    storeAccountId = storeAccountId ?? cached.carrier_account_id ?? null;
    if (purchaseOrderSource === 'none') purchaseOrderSource = 'store_orders lookup';
    rawOrder = cached.raw ?? null;
    orderNumber = orderNumber ?? trimmedString(cached.customer_order_id);
  }

  // ④ live Marketplace lookup. Walmart's visible order number is the
  // customerOrderId (long numeric); the Shipping API needs the purchaseOrderId.
  const candidateCustomerOrderId = (() => {
    const fromRaw = trimmedString((rawOrder as any)?.customerOrderId);
    for (const candidate of [lookupC, fromRaw, lookupB, lookupA]) {
      if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
    }
    return null;
  })();
  const needsLive = mode === 'labels' ? candidateCustomerOrderId != null : !purchaseOrderId;
  if (needsLive && candidateCustomerOrderId) {
    const looked = await lookupWalmartOrderByCustomerOrderId(input.credentials, candidateCustomerOrderId);
    if (looked) {
      if (mode === 'labels' && purchaseOrderId && purchaseOrderId !== looked.purchaseOrderId) {
        console.warn('[walmart-po] live PO verification replaced cached purchaseOrderId', {
          customerOrderId: candidateCustomerOrderId,
          previousPurchaseOrderId: purchaseOrderId,
          livePurchaseOrderId: looked.purchaseOrderId,
        });
      }
      purchaseOrderId = looked.purchaseOrderId;
      purchaseOrderSource = 'walmart_marketplace_api';
      rawOrder = looked.rawOrder ?? rawOrder;
      await upsertStoreOrderCache({
        purchaseOrderId,
        customerOrderId: candidateCustomerOrderId,
        rawOrder: looked.rawOrder ?? rawOrder,
        storeAccountId,
      });
    } else if (mode === 'labels') {
      // Money path: never buy against an unverified PO.
      throw new Error(
        `Could not verify live Walmart PO# for customerOrderId ${candidateCustomerOrderId}. Label not purchased.`,
      );
    }
  }

  // Legacy Fix 1 (2026-05-12): a REAL order (orderId present) must never
  // silently borrow another order's purchaseOrderId. The most-recent-row
  // fallback exists only for the Settings demo button, rates mode only.
  if (!purchaseOrderId && !orderId && mode === 'rates') {
    try {
      const recent = await pg<Array<{ external_order_id: string; raw: unknown }>>`
        SELECT external_order_id, raw FROM store_orders
        WHERE provider = 'walmart'
        ORDER BY last_fetched_at DESC
        LIMIT 1
      `;
      if (recent[0]?.external_order_id) {
        purchaseOrderId = recent[0].external_order_id;
        purchaseOrderSource = 'store_orders fallback (settings demo)';
        rawOrder = recent[0].raw ?? null;
      }
    } catch { /* non-fatal */ }
  }

  // The connector also needs the raw marketplace order (boxItems + ship-to) —
  // re-hydrate from the cache when the PO is known but the raw is unusable.
  if (purchaseOrderId && !walmartRawOrderUsable(rawOrder)) {
    try {
      const rows = await pg<Array<{ raw: unknown }>>`
        SELECT raw FROM store_orders
        WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
        LIMIT 1
      `;
      rawOrder = rows[0]?.raw ?? rawOrder;
    } catch { /* non-fatal — the connector reports a clear error if raw is required */ }
  }

  if (mode === 'labels' && !purchaseOrderId) {
    throw new Error(
      'Walmart Shipping labels require a Walmart purchaseOrderId. Pull/refresh the Walmart order, then reopen Browse Rates from that order.',
    );
  }

  return { purchaseOrderId, purchaseOrderSource, rawOrder };
}
