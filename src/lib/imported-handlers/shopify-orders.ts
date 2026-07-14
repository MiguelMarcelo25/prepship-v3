// Pull recent Shopify orders and persist them into store_orders + canonical
// orders. The Shopify connector owns API calls and payload normalization; this
// handler owns the authenticated Settings action and persistence delegation.

import type postgres from 'postgres';
import { sql } from '../../db/client.js';
import { assertStoreOrdersSchemaReady } from '../../services/store-orders-schema';
import { sendInternalServerError } from '../safe-error';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../auth/verify-supabase-jwt';
import { corsHeaders } from '../http/cors';
import { importStoreOrders } from '../../services/store-connector-orchestrator';
import { buildNormalizedOrderSource } from '../../services/normalized-order-persistence';
import { upsertNormalizedStoreOrders } from '../../services/store-order-import';
import {
  ensureSyntheticStoreClient,
  syntheticStoreIdForCredentialAccount,
  type SqlLike,
} from '../../services/credential-accounts';
import {
  readNodeJsonBody,
  type NodeStyleRequest,
  type NodeStyleResponse,
} from '../node-handler.js';

function toPacificClockfaceZ(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}Z`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceOrderNumber(order: any): string {
  return String(order.sourceOrderNumber ?? order.sourceOrderId ?? '').trim();
}

function externalOrderId(order: any): string {
  return `shopify-${String(order.sourceOrderId)}`;
}

function shipToForStoreOrder(order: any): Record<string, unknown> {
  const raw = asRecord(order.rawPayload);
  const shipping = asRecord(raw.shipping_address ?? raw.shippingAddress);
  return {
    name: order.customerName ?? shipping.name ?? null,
    addressLine1: shipping.address1 ?? null,
    addressLine2: shipping.address2 ?? null,
    city: order.shipToCity ?? shipping.city ?? null,
    state: order.shipToState ?? shipping.province_code ?? shipping.province ?? null,
    postalCode: order.shipToPostalCode ?? shipping.zip ?? null,
    country: shipping.country_code ?? shipping.country ?? null,
    phone: shipping.phone ?? null,
    email: order.customerEmail ?? raw.email ?? null,
  };
}

function totalsForStoreOrder(order: any): Record<string, unknown> {
  return {
    total: order.orderTotal ?? null,
    shipping: order.shippingPaid ?? null,
    currency: asRecord(order.rawPayload).currency ?? null,
  };
}

function shipmentStatusFor(order: any): string {
  if (order.canonicalStatus === 'shipped') return 'shipped';
  if (order.canonicalStatus === 'cancelled') return 'cancelled';
  return 'unshipped';
}

async function clientContextForStore(sql: SqlLike, account: {
  provider: string;
  accountId: number;
  label: string | null;
}): Promise<{ clientId: number | null; syntheticStoreId: number }> {
  await ensureSyntheticStoreClient(sql, account);
  const syntheticStoreId = syntheticStoreIdForCredentialAccount(account.provider, account.accountId);
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM clients
    WHERE store_ids @> ARRAY[${syntheticStoreId}]::integer[]
    LIMIT 1
  `;
  return { clientId: rows[0]?.id ?? null, syntheticStoreId };
}

export default async function handler(
  req: NodeStyleRequest,
  res: NodeStyleResponse,
): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'POST, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const token = extractBearerToken(req.headers?.authorization || req.headers?.Authorization);
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token' }); return; }

  const body = await readNodeJsonBody(req);
  const accountId = body?.storeAccountId != null
    ? Number(body.storeAccountId)
    : (body?.carrierAccountId != null ? Number(body.carrierAccountId) : NaN);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'storeAccountId is required' });
    return;
  }

  const defaultStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceDate = typeof body?.sinceDate === 'string' && body.sinceDate ? body.sinceDate : defaultStart;
  const limit = Math.min(Math.max(Number(body?.limit ?? 50), 1), 250);

  // Per user override unlock shipped data on 2026-07-14: marketplace import
  // semantics are unchanged; this typed adapter now uses the shared DB pool.
  try {
    await assertStoreOrdersSchemaReady(sql, '[carriers/shopify/orders]');
  } catch (err) {
    console.error(
      '[carriers/shopify/orders] store_orders schema readiness failed:',
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({ ok: false, error: 'Store orders schema is not ready' });
    return;
  }

  try {
    const rows = await sql<Array<{ provider: string; credentials: unknown; label: string | null }>>`
      SELECT provider, credentials, label FROM store_accounts WHERE id = ${accountId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: `store_accounts row #${accountId} not found` });
      return;
    }
    if (row.provider !== 'shopify') {
      res.status(400).json({ error: `Expected shopify provider, got ${row.provider}` });
      return;
    }

    const creds = row.credentials && typeof row.credentials === 'object'
      ? (row.credentials as Record<string, unknown>)
      : {};
    let imported;
    try {
      imported = await importStoreOrders('shopify', {
        companyId: 0,
        accountId: String(accountId),
        credentials: creds as Record<string, string | null | undefined>,
        sinceDate,
        limit,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const { clientId, syntheticStoreId } = await clientContextForStore(sql, {
      provider: 'shopify',
      accountId,
      label: row.label,
    });

    let inserted = 0;
    let updated = 0;
    let reconciledOrders = 0;
    let skippedSyntheticMirrors = 0;
    let mirroredOrders = 0;

    for (const order of imported.orders as any[]) {
      const orderNumber = sourceOrderNumber(order);
      const rawParam = { source: 'shopify', accountId, ...asRecord(order.rawPayload) };
      const orderDate = order.orderDate instanceof Date && Number.isFinite(order.orderDate.getTime())
        ? new Date(toPacificClockfaceZ(order.orderDate))
        : null;
      const items = Array.isArray(order.items) ? order.items : [];
      const result = await sql<Array<{ inserted: boolean }>>`
        INSERT INTO store_orders (
          carrier_account_id, provider, external_order_id, customer_order_id,
          order_date, source_status, ship_to, items, totals, raw,
          shipment_status, first_fetched_at, last_fetched_at, updated_at
        )
        VALUES (
          ${accountId}, 'shopify', ${String(order.sourceOrderId)}, ${orderNumber || String(order.sourceOrderId)},
          ${orderDate}, ${String(order.canonicalStatus)},
          ${sql.json(shipToForStoreOrder(order) as postgres.JSONValue)},
          ${sql.json(items as postgres.JSONValue)},
          ${sql.json(totalsForStoreOrder(order) as postgres.JSONValue)},
          ${sql.json(rawParam as postgres.JSONValue)},
          ${shipmentStatusFor(order)}, NOW(), NOW(), NOW()
        )
        ON CONFLICT (provider, external_order_id) DO UPDATE SET
          customer_order_id = EXCLUDED.customer_order_id,
          order_date = COALESCE(EXCLUDED.order_date, store_orders.order_date),
          source_status = EXCLUDED.source_status,
          ship_to = EXCLUDED.ship_to,
          items = EXCLUDED.items,
          totals = EXCLUDED.totals,
          raw = EXCLUDED.raw,
          shipment_status = EXCLUDED.shipment_status,
          last_fetched_at = NOW(),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `;
      if (result[0]?.inserted) inserted += 1; else updated += 1;

      try {
        // Shopify order numbers such as "#1001" are shop-local and collide
        // easily. Do not let a global order_number match block a direct
        // Shopify import; the source identity below is the canonical key.
        mirroredOrders += await upsertNormalizedStoreOrders([{
          source: buildNormalizedOrderSource({
            sourceProvider: 'shopify',
            sourceAccountId: String(accountId),
            sourceOrderId: order.sourceOrderId,
            sourceOrderNumber: orderNumber || String(order.sourceOrderId),
            raw: rawParam,
          }),
          externalOrderId: externalOrderId(order),
          orderNumber: orderNumber || String(order.sourceOrderId),
          orderStatus: order.canonicalStatus,
          orderDate,
          clientId,
          storeId: syntheticStoreId,
          customerEmail: order.customerEmail ?? null,
          shipToName: order.customerName ?? null,
          shipToCity: order.shipToCity ?? null,
          shipToState: order.shipToState ?? null,
          shipToPostalCode: order.shipToPostalCode ?? null,
          carrierCode: order.carrierCode ?? null,
          serviceCode: order.serviceCode ?? null,
          weightOz: order.weightOz ?? null,
          orderTotal: String(order.orderTotal ?? '0'),
          shippingAmount: String(order.shippingPaid ?? '0'),
          items,
          raw: rawParam,
          externallyShipped: order.externallyShipped === true,
        }]);
      } catch (mirrorErr) {
        console.warn(
          '[carriers/shopify/orders] mirror to orders table failed for',
          order.sourceOrderId,
          mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
        );
      }
    }

    res.status(200).json({
      ok: true,
      fetched: imported.orders.length,
      inserted,
      updated,
      mirroredOrders,
      reconciledOrders,
      skippedSyntheticMirrors,
      sample: (imported.orders as any[]).slice(0, 5).map((order) => ({
        orderId: order.sourceOrderId,
        orderNumber: order.sourceOrderNumber,
        status: order.canonicalStatus,
        recipient: order.customerName,
      })),
      windowStart: sinceDate,
      cursor: imported.cursor ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendInternalServerError(res, 'carriers/shopify/orders', err);
  }
}
