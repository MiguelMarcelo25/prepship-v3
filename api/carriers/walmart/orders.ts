// @ts-nocheck
// Vercel serverless function: pull recent orders from Walmart Marketplace API
// AND persist them into the store_orders table so they're usable in the app.
//
// Loads credentials by carrierAccountId, refreshes an OAuth access_token,
// hits GET /v3/orders, then upserts each order into store_orders keyed on
// (provider, external_order_id) — so re-pulling the same window updates
// existing rows instead of duplicating them. Bootstraps the table on first
// call so no separate migration step is needed.
//
// Auth: Supabase JWT in Authorization: Bearer <token>.
//
// POST body:
//   { carrierAccountId: number, createdStartDate?: string, limit?: number }
//
// Response shape (success):
//   { ok: true, fetched: number, inserted: number, updated: number,
//     sample: [...], windowStart: ISO, fetchedAt: ISO }
//
// Response shape (failure):
//   { ok: false, error: string, reason?: string }

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
import { assertStoreOrdersSchemaReady } from '../../_lib/store-orders-schema.js';
import {
  hasExistingMarketplaceOrderRow,
  reconcileMarketplaceOrderStatuses,
} from '../../_lib/marketplace-status-reconciliation.js';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (cachedJwks) return cachedJwks;
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  cachedJwks = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  return cachedJwks;
}

async function verifySupabaseJwt(token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const errors: string[] = [];
  const jwks = getJwks();
  if (jwks) {
    try {
      await jwtVerify(token, jwks);
      return { ok: true };
    } catch (err) {
      errors.push(`JWKS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      return { ok: true };
    } catch (err) {
      errors.push(`HS256: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: false, reason: errors.join(' | ') || 'no verification method available' };
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = new Set([
    'https://prepship.vercel.app',
    'https://prepship-eta.vercel.app',
    'https://prepshipv4.vercel.app',
    'http://localhost:5173',
  ]);
  const allow = origin && allowed.has(origin) ? origin : '';
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

function readBody(req: any): Promise<unknown> {
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.resolve({});
      }
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Convert a real UTC Date to a Pacific-time wall-clock string stamped with
// "Z" — matches the convention ShipStation orders use in our orders table
// (PT clock face stored as if it were UTC, so the FE's UTC-mode renderer
// reproduces the original clock face). Without this, real UTC timestamps
// from marketplace pulls render 7-8 hours off compared to ShipStation
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
  // hour can come back as "24" at midnight in some Intl impls; normalize.
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}Z`;
}

// Mint a fresh OAuth access token. Walmart tokens expire in ~15 minutes —
// we don't bother caching here since the function is short-lived; each
// invocation starts a new token.
async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are required');
  }
  const channelType = String(creds?.channelType ?? '').trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const correlationId = `prepship-${Date.now().toString(36)}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'WM_QOS.CORRELATION_ID': correlationId,
    'WM_SVC.NAME': 'Walmart Marketplace',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
    method: 'POST',
    headers,
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`Walmart OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('Walmart OAuth response missing access_token');
  return data.access_token;
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth gate
  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization' });
    return;
  }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    res.status(401).json({ error: 'Invalid token', reason: verified.reason });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    res.status(500).json({ error: 'DATABASE_URL not configured' });
    return;
  }

  const body = (await readBody(req)) as Record<string, unknown>;
  // Walmart is a store, so its credentials live in store_accounts now.
  // FE passes storeAccountId; we accept the legacy carrierAccountId name
  // as a fallback for old clients still in flight after a redeploy.
  const accountId = body?.storeAccountId != null
    ? Number(body.storeAccountId)
    : (body?.carrierAccountId != null ? Number(body.carrierAccountId) : NaN);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'storeAccountId is required' });
    return;
  }

  // Default window: last 7 days. The user can override via createdStartDate.
  const defaultStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const createdStartDate = typeof body?.createdStartDate === 'string' && body.createdStartDate
    ? body.createdStartDate
    : defaultStart;
  const limit = Math.min(Math.max(Number(body?.limit ?? 50), 1), 200);

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 5,
  });

  try {
    await assertStoreOrdersSchemaReady(sql, '[carriers/walmart/orders]');
  } catch (err) {
    console.error(
      '[carriers/walmart/orders] store_orders schema readiness failed:',
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({ ok: false, error: 'Store orders schema is not ready' });
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
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
    if (row.provider !== 'walmart') {
      res.status(400).json({ error: `Expected walmart provider, got ${row.provider}` });
      return;
    }
    const creds = (row.credentials && typeof row.credentials === 'object'
      ? (row.credentials as Record<string, unknown>)
      : {});

    let accessToken: string;
    try {
      accessToken = await getWalmartAccessToken(creds);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const correlationId = `prepship-${Date.now().toString(36)}`;
    const channelType = String(creds?.channelType ?? '').trim();
    const ordersHeaders: Record<string, string> = {
      'WM_SEC.ACCESS_TOKEN': accessToken,
      'WM_QOS.CORRELATION_ID': correlationId,
      'WM_SVC.NAME': 'Walmart Marketplace',
      Accept: 'application/json',
    };
    if (channelType) ordersHeaders['WM_CONSUMER.CHANNEL.TYPE'] = channelType;

    // productInfo=true asks Walmart to include the per-line item details
    // (productName, image_url, weight_kg, etc.) in the list response. Without
    // this flag the items array can come back lean — productName missing,
    // recipient name on shipping address sometimes empty too. The flag is
    // documented but defaults to false.
    const url = new URL('https://marketplace.walmartapis.com/v3/orders');
    url.searchParams.set('createdStartDate', createdStartDate);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('productInfo', 'true');

    const ordersRes = await fetch(url.toString(), { headers: ordersHeaders });
    if (!ordersRes.ok) {
      const t = await ordersRes.text().then((s) => s.slice(0, 400)).catch(() => '');
      res.status(400).json({
        ok: false,
        error: `Walmart /v3/orders ${ordersRes.status}: ${t || ordersRes.statusText}`,
      });
      return;
    }
    const data = (await ordersRes.json()) as { list?: { meta?: unknown; elements?: { order?: unknown[] | unknown } } };
    const ordersList = (data?.list?.elements as { order?: unknown[] | unknown } | undefined) ?? {};
    const elements = Array.isArray((ordersList as any)?.order)
      ? ((ordersList as any).order as unknown[])
      : (ordersList as any)?.order
        ? [(ordersList as any).order]
        : [];

    // Helper: extract overall order status from Walmart's nested structure.
    // Walmart returns status per orderLine; we collapse to a single value
    // (Created / Acknowledged / Shipped / Cancelled) by taking the first.
    const extractStatus = (o: any): string | null => {
      if (Array.isArray(o?.orderLines?.orderLine)) {
        const line = o.orderLines.orderLine[0];
        const status = line?.orderLineStatuses?.orderLineStatus?.[0]?.status;
        return typeof status === 'string' ? status : null;
      }
      return null;
    };

    // Helper: extract ship-to address into a normalized JSONB shape.
    // Walmart returns the recipient name on shippingInfo.postalAddress.name
    // (earlier comment was wrong) — this is what powers the Recipient column
    // in the Orders view.
    const extractShipTo = (o: any): Record<string, unknown> | null => {
      const addr = o?.shippingInfo?.postalAddress;
      if (!addr || typeof addr !== 'object') return null;
      return {
        name: addr.name ?? null,
        addressLine1: addr.address1 ?? null,
        addressLine2: addr.address2 ?? null,
        city: addr.city ?? null,
        state: addr.state ?? null,
        postalCode: addr.postalCode ?? null,
        country: addr.country ?? null,
        phone: o?.shippingInfo?.phone ?? null,
      };
    };

    // Helper: extract line items as an array of normalized rows in the
    // shape OrdersView expects: { sku, name, quantity, unitPrice, imageUrl }.
    // We keep the Walmart-specific fields (productName, lineNumber, …) too
    // so they're available in the raw payload for debugging.
    const extractItems = (o: any): Array<Record<string, unknown>> => {
      const lines = Array.isArray(o?.orderLines?.orderLine) ? o.orderLines.orderLine : [];
      return lines.map((line: any) => {
        const productName = line?.item?.productName ?? null;
        const productImage = line?.item?.imageUrl ?? line?.item?.imageURL ?? null;
        const quantity = Number(line?.orderLineQuantity?.amount ?? 1) || 1;
        const chargeAmount = Number(line?.charges?.charge?.[0]?.chargeAmount?.amount ?? 0);
        // Per-unit price for OrdersView's totals math.
        const unitPrice = quantity > 0
          ? Math.round((chargeAmount / quantity) * 100) / 100
          : chargeAmount;
        return {
          sku: line?.item?.sku ?? null,
          name: productName,
          quantity,
          unitPrice,
          imageUrl: productImage,
          // Walmart-specific extras retained for debugging / future use.
          lineNumber: line?.lineNumber ?? null,
          productName,
          unitOfMeasure: line?.orderLineQuantity?.unitOfMeasurement ?? null,
          chargeAmount,
          currency: line?.charges?.charge?.[0]?.chargeAmount?.currency ?? null,
          status: line?.orderLineStatuses?.orderLineStatus?.[0]?.status ?? null,
        };
      });
    };

    // Helper: extract dollar totals (sum of line charges + tax + shipping).
    const extractTotals = (o: any): Record<string, unknown> => {
      const lines = Array.isArray(o?.orderLines?.orderLine) ? o.orderLines.orderLine : [];
      let subtotal = 0;
      let tax = 0;
      let shipping = 0;
      let currency: string | null = null;
      for (const line of lines) {
        const charges = Array.isArray(line?.charges?.charge) ? line.charges.charge : [];
        for (const charge of charges) {
          const amt = Number(charge?.chargeAmount?.amount ?? 0);
          if (charge?.chargeType === 'PRODUCT') subtotal += amt;
          else if (charge?.chargeType === 'SHIPPING') shipping += amt;
          if (typeof charge?.tax?.taxAmount?.amount === 'number') tax += charge.tax.taxAmount.amount;
          if (!currency && charge?.chargeAmount?.currency) currency = charge.chargeAmount.currency;
        }
      }
      return {
        subtotal: Math.round(subtotal * 100) / 100,
        tax: Math.round(tax * 100) / 100,
        shipping: Math.round(shipping * 100) / 100,
        total: Math.round((subtotal + tax + shipping) * 100) / 100,
        currency,
      };
    };

    // Pre-fetch a SKU → weight_oz map for every SKU in this batch so the
    // order loop can compute total package weight without N round trips.
    // Walmart's order API doesn't return per-order weight; sellers carry
    // weight on their own inventory rows. First match per SKU wins (the
    // inventory table allows the same SKU under multiple client_ids; we
    // don't have a client to disambiguate against here, so we assume
    // the SKU's weight is consistent across clients — true for almost
    // every seller's catalog).
    const skuToWeightOz = new Map<string, number>();
    {
      const allSkus = new Set<string>();
      for (const o of elements as any[]) {
        const lines = Array.isArray(o?.orderLines?.orderLine) ? o.orderLines.orderLine : [];
        for (const line of lines) {
          const sku = line?.item?.sku;
          if (sku) allSkus.add(String(sku));
        }
      }
      if (allSkus.size > 0) {
        try {
          const skuArr = Array.from(allSkus);
          const weightRows = await sql<Array<{ sku: string; weight_oz: number | null }>>`
            SELECT sku, weight_oz FROM inventory
            WHERE sku = ANY(${skuArr}::text[])
          `;
          for (const r of weightRows) {
            if (!skuToWeightOz.has(r.sku) && r.weight_oz != null) {
              skuToWeightOz.set(r.sku, Number(r.weight_oz));
            }
          }
        } catch (lookupErr) {
          console.warn(
            '[carriers/walmart/orders] inventory weight lookup failed:',
            lookupErr instanceof Error ? lookupErr.message : lookupErr,
          );
        }
      }
    }

    // Ensure a `clients` row exists for this Walmart connection so the
    // synthetic store_id appears in /init/stores under a labeled name
    // (e.g. "Walmart Marketplace") rather than as a bare numeric store.
    // The match is by `store_ids @> ARRAY[syntheticStoreId]` so two pulls
    // for the same store_accounts row reuse the same client row.
    const syntheticStoreIdForClient = 9_000_000 + accountId;
    const walmartLabel = row.label?.trim() || 'Walmart';
    const walmartClientName = walmartLabel === 'Walmart' || /walmart/i.test(walmartLabel)
      ? walmartLabel
      : `Walmart — ${walmartLabel}`;
    let walmartClientId: number | null = null;
    try {
      const existing = await sql<Array<{ id: number }>>`
        SELECT id FROM clients
        WHERE store_ids @> ARRAY[${syntheticStoreIdForClient}]::integer[]
        LIMIT 1
      `;
      if (existing[0]) {
        walmartClientId = existing[0].id;
      } else {
        const created = await sql<Array<{ id: number }>>`
          INSERT INTO clients (name, store_ids, active, is_test)
          VALUES (${walmartClientName}, ARRAY[${syntheticStoreIdForClient}]::integer[], true, false)
          RETURNING id
        `;
        walmartClientId = created[0]?.id ?? null;
      }
    } catch (clientErr) {
      console.warn(
        '[carriers/walmart/orders] could not ensure clients row:',
        clientErr instanceof Error ? clientErr.message : clientErr,
      );
    }

    // Upsert each order. Track whether each row was newly inserted vs.
    // updated (re-pull of an order we already had) so the response gives
    // a clear picture of how the latest pull changed our local data.
    let inserted = 0;
    let updated = 0;
    let reconciledOrders = 0;
    let skippedSyntheticMirrors = 0;
    for (const o of elements as any[]) {
      const externalOrderId = o?.purchaseOrderId ? String(o.purchaseOrderId) : null;
      if (!externalOrderId) continue;
      const customerOrderId = o?.customerOrderId ? String(o.customerOrderId) : null;
      // Walmart's orderDate is epoch ms (real UTC). The FE intentionally
      // renders order dates in UTC mode to reproduce ShipStation's
      // "PT-wall-clock-stamped-as-Z" convention (see formatDateTime in
      // OrdersView.tsx). Saving raw UTC here would make Walmart orders
      // display 7-8 hours off from ShipStation orders. Convert to a
      // Pacific-time clock-face string stamped with Z so the FE's UTC
      // rendering produces the correct PT-display time.
      const orderDateMs = o?.orderDate ? Number(o.orderDate) : null;
      const orderDate = orderDateMs && Number.isFinite(orderDateMs)
        ? toPacificClockfaceZ(new Date(orderDateMs))
        : (typeof o?.orderDate === 'string' ? o.orderDate : null);
      const sourceStatus = extractStatus(o);
      const shipTo = extractShipTo(o);
      const items = extractItems(o);
      const totals = extractTotals(o);

      // Sum line-item weight × qty using the SKU → weight_oz map. Items
      // whose SKUs aren't in inventory contribute 0 (so a single
      // unknown SKU doesn't pollute the whole order with NaN). If
      // every SKU is unknown the result is 0, which is what we
      // already had before this lookup — no regression.
      const computedWeightOz = items.reduce((sum: number, item: any) => {
        const sku = typeof item?.sku === 'string' ? item.sku : null;
        const qty = Number(item?.quantity ?? 1) || 1;
        const w = sku ? (skuToWeightOz.get(sku) ?? 0) : 0;
        return sum + w * qty;
      }, 0);
      const weightOzForOrder = Math.round(computedWeightOz * 100) / 100;

      // Postgres reports xmax > 0 on conflict updates and xmax = 0 on
      // fresh inserts — use that to count inserted vs. updated cheaply
      // without an extra round trip.
      const result = await sql<Array<{ inserted: boolean }>>`
        INSERT INTO store_orders (
          carrier_account_id, provider, external_order_id, customer_order_id,
          order_date, source_status, ship_to, items, totals, raw,
          first_fetched_at, last_fetched_at, updated_at
        )
        VALUES (
          ${accountId}, 'walmart', ${externalOrderId}, ${customerOrderId},
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
      if (result[0]?.inserted) inserted += 1;
      else updated += 1;

      // Mirror into the canonical `orders` table so the order shows up in
      // the existing Awaiting Shipment view (which queries `orders` with
      // order_status='awaiting_shipment'). Map Walmart's status ladder
      // (Created/Acknowledged/Shipped/Cancelled) onto PrepShip's
      // (awaiting_shipment/shipped/cancelled). Synthetic store_id is
      // derived from the store_accounts row id so each connected
      // marketplace gets its own group in any byStore breakdown.
      const ppStatus = (() => {
        const s = (sourceStatus ?? '').toLowerCase();
        if (s === 'shipped') return 'shipped';
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';
        return 'awaiting_shipment';
      })();
      const syntheticStoreId = 9_000_000 + accountId;
      const externalOrderIdPrefixed = `walmart-${externalOrderId}`;
      const marketplaceOrderNumber = customerOrderId ?? externalOrderId;
      try {
        const hasShipStationRow = await hasExistingMarketplaceOrderRow(
          sql,
          'walmart',
          marketplaceOrderNumber,
        );
        if (hasShipStationRow) {
          const reconciliation = await reconcileMarketplaceOrderStatuses(sql, {
            provider: 'walmart',
            storeAccountId: accountId,
            orderNumbers: [marketplaceOrderNumber],
            dryRun: false,
          });
          reconciledOrders += reconciliation.updated;
          skippedSyntheticMirrors += 1;
          continue;
        }

        // Template literal form lets postgres.js auto-serialize the
        // array/object params correctly into JSONB columns. The earlier
        // sql.unsafe + JSON.stringify + ::jsonb form double-encoded the
        // value (stored items as a JSONB string instead of an array).
        const orderTotal = (totals as any)?.total ?? 0;
        const shippingAmount = (totals as any)?.shipping ?? 0;
        const itemsParam = items as Array<Record<string, unknown>>;
        const rawParam = { source: 'walmart', accountId, ...(o as Record<string, unknown>) };
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
            ${walmartClientId},
            ${customerOrderId ?? externalOrderId},
            ${ppStatus},
            ${orderDate},
            ${syntheticStoreId},
            NULL,
            ${shipTo?.name ?? null},
            ${shipTo?.city ?? null},
            ${shipTo?.state ?? null},
            ${shipTo?.postalCode ?? null},
            ${weightOzForOrder},
            ${orderTotal},
            ${shippingAmount},
            ${itemsParam},
            ${rawParam},
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
          '[carriers/walmart/orders] mirror to orders table failed for',
          externalOrderId,
          mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
        );
      }
    }

    const sample = elements.slice(0, 5).map((o: any) => ({
      purchaseOrderId: o?.purchaseOrderId ?? null,
      customerOrderId: o?.customerOrderId ?? null,
      orderDate: o?.orderDate ?? null,
      status: extractStatus(o),
      shipNode: o?.shipNode?.type ?? null,
    }));

    res.status(200).json({
      ok: true,
      fetched: elements.length,
      inserted,
      updated,
      reconciledOrders,
      skippedSyntheticMirrors,
      sample,
      windowStart: createdStartDate,
      fetchedAt: new Date().toISOString(),
      meta: data?.list?.meta ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carriers/walmart/orders]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
