// @ts-nocheck
// Vercel serverless function: pull recent orders from eBay Sell API and
// persist them into store_orders + the canonical orders table so they
// appear in Awaiting Shipment.
//
// Imports through the eBay StoreConnector, which owns OAuth and the
// /sell/fulfillment/v1/order provider call. eBay's response shape is richer
// than Walmart's:
// per-line items with title + sku, structured shipTo address, full
// pricing summary. We map directly into the same store_orders + orders
// shape used for Walmart so the rest of the app doesn't have to know
// which marketplace an order came from.
//
// Auth: Supabase JWT.
// POST body: { storeAccountId: number, sinceDate?: ISO, limit?: number }
// Response (success):
//   { ok: true, fetched, inserted, updated, sample, windowStart, fetchedAt }

import postgres from 'postgres';
import { assertStoreOrdersSchemaReady } from '../../_lib/store-orders-schema.js';
import {
  hasExistingMarketplaceOrderRow,
  reconcileMarketplaceOrderStatuses,
} from '../../_lib/marketplace-status-reconciliation.js';
import { sendInternalServerError } from '../../_lib/safe-error.js';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../../src/lib/auth/verify-supabase-jwt.js';
import { corsHeaders } from '../../../src/lib/http/cors.js';
import { importStoreOrders } from '../../../src/services/store-connector-orchestrator.js';

function readBody(req: any): Promise<unknown> {
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Convert real UTC Date → Pacific-time wall-clock string stamped with "Z"
// so the FE's UTC-mode renderer (kept for ShipStation parity — orders
// stored as PT-clock-face-stamped-Z) displays it correctly. Without this
// conversion, eBay orders display 7-8 hours offset from ShipStation
// orders. See OrdersView.tsx:formatDateTime for the matching FE side.
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

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'POST, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const tok = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!tok) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(tok);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token' }); return; }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }

  const body = (await readBody(req)) as Record<string, unknown>;
  const accountId = body?.storeAccountId != null
    ? Number(body.storeAccountId)
    : (body?.carrierAccountId != null ? Number(body.carrierAccountId) : NaN);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'storeAccountId is required' });
    return;
  }
  const defaultStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceDate = typeof body?.sinceDate === 'string' && body.sinceDate
    ? body.sinceDate
    : defaultStart;
  const limit = Math.min(Math.max(Number(body?.limit ?? 100), 1), 200);

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    await assertStoreOrdersSchemaReady(sql, '[carriers/ebay/orders]');
  } catch (err) {
    console.error(
      '[carriers/ebay/orders] store_orders schema readiness failed:',
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({ ok: false, error: 'Store orders schema is not ready' });
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
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
    if (row.provider !== 'ebay') {
      res.status(400).json({ error: `Expected ebay provider, got ${row.provider}` });
      return;
    }
    const creds = (row.credentials && typeof row.credentials === 'object'
      ? (row.credentials as Record<string, unknown>)
      : {});

    let imported;
    try {
      imported = await importStoreOrders('ebay', {
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

    const elements: any[] = imported.orders.map((order: any) => order.rawPayload);
    const data = { total: imported.total ?? elements.length };

    // Pre-fetch SKU → weight_oz AND SKU → image_url from inventory in one
    // query. eBay's /sell/fulfillment/v1/order does NOT return product
    // images (the legacy ShipStation pipeline got them by enriching
    // against SS's own product DB). Looking them up by SKU from inventory
    // is the cleanest fix — same lookup the Walmart puller already does
    // for weights.
    const skuToWeightOz = new Map<string, number>();
    const skuToImageUrl = new Map<string, string>();
    {
      const allSkus = new Set<string>();
      for (const o of elements) {
        const lines = Array.isArray(o?.lineItems) ? o.lineItems : [];
        for (const line of lines) {
          if (line?.sku) allSkus.add(String(line.sku));
        }
      }
      if (allSkus.size > 0) {
        try {
          const skuArr = Array.from(allSkus);
          const inventoryRows = await sql<Array<{ sku: string; weight_oz: number | null; image_url: string | null }>>`
            SELECT sku, weight_oz, image_url FROM inventory
            WHERE sku = ANY(${skuArr}::text[])
          `;
          for (const r of inventoryRows) {
            if (!skuToWeightOz.has(r.sku) && r.weight_oz != null) {
              skuToWeightOz.set(r.sku, Number(r.weight_oz));
            }
            if (!skuToImageUrl.has(r.sku) && r.image_url) {
              skuToImageUrl.set(r.sku, String(r.image_url));
            }
          }
        } catch (lookupErr) {
          console.warn('[carriers/ebay/orders] inventory lookup failed:',
            lookupErr instanceof Error ? lookupErr.message : lookupErr);
        }
      }
    }

    // Ensure a clients row for this eBay store so synthetic store_id maps to a name.
    const syntheticStoreId = 9_500_000 + accountId; // separate offset from Walmart's 9_000_000
    const ebayLabel = row.label?.trim() || 'eBay';
    const ebayClientName = /ebay/i.test(ebayLabel) ? ebayLabel : `eBay — ${ebayLabel}`;
    let ebayClientId: number | null = null;
    try {
      const existing = await sql<Array<{ id: number }>>`
        SELECT id FROM clients
        WHERE store_ids @> ARRAY[${syntheticStoreId}]::integer[]
        LIMIT 1
      `;
      if (existing[0]) {
        ebayClientId = existing[0].id;
      } else {
        const created = await sql<Array<{ id: number }>>`
          INSERT INTO clients (name, store_ids, active, is_test)
          VALUES (${ebayClientName}, ARRAY[${syntheticStoreId}]::integer[], true, false)
          RETURNING id
        `;
        ebayClientId = created[0]?.id ?? null;
      }
    } catch (clientErr) {
      console.warn('[carriers/ebay/orders] could not ensure clients row:',
        clientErr instanceof Error ? clientErr.message : clientErr);
    }

    // Helpers — extract eBay's order shape into our normalized fields.
    const extractStatus = (o: any): string | null =>
      typeof o?.orderFulfillmentStatus === 'string' ? o.orderFulfillmentStatus : null;

    const extractShipTo = (o: any): Record<string, unknown> | null => {
      const ship = Array.isArray(o?.fulfillmentStartInstructions)
        ? o.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
        : null;
      if (!ship) return null;
      const addr = ship.contactAddress ?? {};
      return {
        name: ship.fullName ?? null,
        addressLine1: addr.addressLine1 ?? null,
        addressLine2: addr.addressLine2 ?? null,
        city: addr.city ?? null,
        state: addr.stateOrProvince ?? null,
        postalCode: addr.postalCode ?? null,
        country: addr.countryCode ?? null,
        phone: ship.primaryPhone?.phoneNumber ?? null,
        email: ship.email ?? null,
      };
    };

    const extractItems = (o: any): Array<Record<string, unknown>> => {
      const lines = Array.isArray(o?.lineItems) ? o.lineItems : [];
      return lines.map((line: any) => {
        const quantity = Number(line?.quantity ?? 1) || 1;
        const lineTotal = Number(line?.lineItemCost?.value ?? 0);
        const unitPrice = quantity > 0 ? Math.round((lineTotal / quantity) * 100) / 100 : lineTotal;
        const sku = line?.sku ? String(line.sku) : null;
        // Prefer eBay's response image if it ever returns one (most don't);
        // fall back to the inventory lookup. Without this, direct-pulled
        // eBay rows render with no thumbnail while legacy ShipStation rows
        // for the SAME items show images — confusing for the user.
        const imageUrl =
          line?.image?.imageUrl ??
          (sku ? skuToImageUrl.get(sku) : null) ??
          null;
        return {
          sku,
          name: line?.title ?? null,
          quantity,
          unitPrice,
          imageUrl,
          // eBay-specific extras retained for the raw payload.
          lineItemId: line?.lineItemId ?? null,
          legacyItemId: line?.legacyItemId ?? null,
          currency: line?.lineItemCost?.currency ?? null,
        };
      });
    };

    const extractTotals = (o: any): Record<string, unknown> => {
      const p = o?.pricingSummary ?? {};
      return {
        subtotal: Number(p?.priceSubtotal?.value ?? 0),
        shipping: Number(p?.deliveryCost?.value ?? 0),
        tax: Number(p?.tax?.value ?? 0),
        total: Number(p?.total?.value ?? 0),
        currency: p?.total?.currency ?? p?.priceSubtotal?.currency ?? 'USD',
      };
    };

    let inserted = 0;
    let updated = 0;
    let reconciledOrders = 0;
    let skippedSyntheticMirrors = 0;
    for (const o of elements) {
      const externalOrderId = o?.orderId ? String(o.orderId) : null;
      if (!externalOrderId) continue;
      const customerOrderId = o?.legacyOrderId ? String(o.legacyOrderId) : null;
      // eBay's creationDate is real UTC ISO. Convert to Pacific-time
      // wall-clock-stamped-Z so the FE's UTC-mode renderer (which exists
      // for ShipStation parity — see OrdersView.tsx:formatDateTime)
      // displays it as PT instead of 7-8 hours off.
      const rawCreation = typeof o?.creationDate === 'string' ? o.creationDate : null;
      const parsedCreation = rawCreation ? new Date(rawCreation) : null;
      const orderDate = parsedCreation && !Number.isNaN(parsedCreation.getTime())
        ? toPacificClockfaceZ(parsedCreation)
        : rawCreation;
      const sourceStatus = extractStatus(o);
      const shipTo = extractShipTo(o);
      const items = extractItems(o);
      const totals = extractTotals(o);

      const computedWeightOz = items.reduce((sum: number, item: any) => {
        const sku = typeof item?.sku === 'string' ? item.sku : null;
        const qty = Number(item?.quantity ?? 1) || 1;
        const w = sku ? (skuToWeightOz.get(sku) ?? 0) : 0;
        return sum + w * qty;
      }, 0);
      const weightOzForOrder = Math.round(computedWeightOz * 100) / 100;

      // Upsert into store_orders (provider-agnostic).
      const result = await sql<Array<{ inserted: boolean }>>`
        INSERT INTO store_orders (
          carrier_account_id, provider, external_order_id, customer_order_id,
          order_date, source_status, ship_to, items, totals, raw,
          first_fetched_at, last_fetched_at, updated_at
        )
        VALUES (
          ${accountId}, 'ebay', ${externalOrderId}, ${customerOrderId},
          ${orderDate}, ${sourceStatus},
          ${shipTo as Record<string, unknown> | null},
          ${items as Array<Record<string, unknown>>},
          ${totals as Record<string, unknown>},
          ${o as Record<string, unknown>},
          NOW(), NOW(), NOW()
        )
        ON CONFLICT (provider, external_order_id) DO UPDATE SET
          customer_order_id = EXCLUDED.customer_order_id,
          order_date = COALESCE(EXCLUDED.order_date, store_orders.order_date),
          source_status = EXCLUDED.source_status,
          ship_to = EXCLUDED.ship_to,
          items = EXCLUDED.items,
          totals = EXCLUDED.totals,
          raw = EXCLUDED.raw,
          last_fetched_at = NOW(),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `;
      if (result[0]?.inserted) inserted += 1; else updated += 1;

      // Mirror into the canonical orders table — drives Awaiting Shipment.
      const ppStatus = (() => {
        const s = (sourceStatus ?? '').toUpperCase();
        if (s === 'FULFILLED') return 'shipped';
        if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelled';
        return 'awaiting_shipment';
      })();
      const externalOrderIdPrefixed = `ebay-${externalOrderId}`;
      const marketplaceOrderNumber = customerOrderId ?? externalOrderId;
      try {
        const hasShipStationRow = await hasExistingMarketplaceOrderRow(
          sql,
          'ebay',
          marketplaceOrderNumber,
        );
        if (hasShipStationRow) {
          const reconciliation = await reconcileMarketplaceOrderStatuses(sql, {
            provider: 'ebay',
            storeAccountId: accountId,
            orderNumbers: [marketplaceOrderNumber],
            dryRun: false,
          });
          reconciledOrders += reconciliation.updated;
          skippedSyntheticMirrors += 1;
          continue;
        }

        await sql`
          INSERT INTO orders (
            external_order_id, client_id, order_number, order_status,
            order_date, store_id, customer_email, ship_to_name,
            ship_to_city, ship_to_state, ship_to_postal_code,
            weight_oz, order_total, shipping_amount, items, raw,
            externally_shipped, externally_fulfilled_verified,
            created_at, updated_at
          ) VALUES (
            ${externalOrderIdPrefixed},
            ${ebayClientId},
            ${customerOrderId ?? externalOrderId},
            ${ppStatus},
            ${orderDate},
            ${syntheticStoreId},
            ${shipTo?.email ?? null},
            ${shipTo?.name ?? null},
            ${shipTo?.city ?? null},
            ${shipTo?.state ?? null},
            ${shipTo?.postalCode ?? null},
            ${weightOzForOrder},
            ${(totals as any)?.total ?? 0},
            ${(totals as any)?.shipping ?? 0},
            ${items as Array<Record<string, unknown>>},
            ${{ source: 'ebay', accountId, ...o } as Record<string, unknown>},
            false, false,
            NOW(), NOW()
          )
          ON CONFLICT (external_order_id) DO UPDATE SET
            client_id = COALESCE(EXCLUDED.client_id, orders.client_id),
            order_number = EXCLUDED.order_number,
            order_status = CASE
              WHEN orders.order_status = 'shipped' THEN orders.order_status
              ELSE EXCLUDED.order_status
            END,
            order_date = COALESCE(EXCLUDED.order_date, orders.order_date),
            store_id = EXCLUDED.store_id,
            customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
            ship_to_name = COALESCE(EXCLUDED.ship_to_name, orders.ship_to_name),
            ship_to_city = EXCLUDED.ship_to_city,
            ship_to_state = EXCLUDED.ship_to_state,
            ship_to_postal_code = EXCLUDED.ship_to_postal_code,
            weight_oz = CASE
              WHEN EXCLUDED.weight_oz > 0 THEN EXCLUDED.weight_oz
              ELSE orders.weight_oz
            END,
            order_total = EXCLUDED.order_total,
            shipping_amount = EXCLUDED.shipping_amount,
            items = EXCLUDED.items,
            raw = EXCLUDED.raw,
            updated_at = NOW()
        `;
      } catch (mirrorErr) {
        console.warn(
          '[carriers/ebay/orders] mirror to orders table failed for',
          externalOrderId,
          mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
        );
      }
    }

    const sample = elements.slice(0, 5).map((o: any) => ({
      orderId: o?.orderId ?? null,
      legacyOrderId: o?.legacyOrderId ?? null,
      creationDate: o?.creationDate ?? null,
      status: extractStatus(o),
      buyer: o?.buyer?.username ?? null,
    }));

    res.status(200).json({
      ok: true,
      fetched: elements.length,
      inserted,
      updated,
      reconciledOrders,
      skippedSyntheticMirrors,
      sample,
      windowStart: sinceDate,
      fetchedAt: new Date().toISOString(),
      total: data?.total ?? null,
    });
  } catch (err) {
    sendInternalServerError(res, 'carriers/ebay/orders', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
