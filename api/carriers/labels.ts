// @ts-nocheck
// Vercel serverless function: purchase a shipping label via the carrier
// the user picked in Rate Browser. Closes the rate-quote loop end-to-end —
// before this endpoint, our direct integrations could ONLY get rates;
// actually buying the label still required ShipStation. With this in
// place, PrepShip can ship orders without ShipStation in the loop.
//
// Auth: Supabase JWT in Authorization: Bearer <token>.
//
// POST body:
//   {
//     carrierAccountId: number,            // saved carrier_accounts row id
//     externalOrderId?: string,            // e.g. "walmart-12345" — for ship-to + items
//     rateId?: string,                     // EasyPost-only: which of the rates to buy
//     serviceCode?: string,                // UPS/USPS/etc: pick a specific service
//     weightOz: number,
//     dimsL: number, dimsW: number, dimsH: number,
//     // Optional explicit ship-to override (useful when externalOrderId
//     // isn't a marketplace pull):
//     shipTo?: { name, street1, street2?, city, state, zip, country, phone? }
//   }
//
// Response (success):
//   { ok: true, provider, trackingNumber, labelUrl, labelFormat: 'PDF',
//     cost: number, currency: 'USD', shipmentId?: string }
// Response (failure):
//   { ok: false, error: string, meta?: ... }

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
import { timedFetch } from '../../src/lib/http/timing.js';
import { persistDirectCarrierLabel } from '../../src/services/direct-label-persistence.js';
import { assertFulfillmentSchemaReady } from '../../src/services/fulfillment/schema-readiness.js';
import { createCarrierLabel } from '../../src/services/carrier-connector-orchestrator.js';

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
    try { await jwtVerify(token, jwks); return { ok: true }; }
    catch (err) { errors.push(`JWKS: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    try { await jwtVerify(token, new TextEncoder().encode(secret)); return { ok: true }; }
    catch (err) { errors.push(`HS256: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { ok: false, reason: errors.join(' | ') || 'no verification method' };
}

function inferStoreProviderFromExternalId(externalOrderId: string | null | undefined): string {
  if (!externalOrderId) return 'shipstation';
  const match = externalOrderId.match(/^([a-z_]+)-(.+)$/i);
  return match?.[1]?.toLowerCase() ?? 'shipstation';
}

function sourceOrderIdFromExternalId(externalOrderId: string | null | undefined): string | null {
  if (!externalOrderId) return null;
  const match = externalOrderId.match(/^[a-z_]+-(.+)$/i);
  return match?.[1] ?? externalOrderId;
}

async function ensureFulfillmentOutboxSql(sql: any): Promise<void> {
  // Per user override unlock shipped data on 2026-05-23: remove
  // request-time shipment/outbox DDL and require migration-owned schema.
  await assertFulfillmentSchemaReady(sql);
}

async function enqueueShipmentConfirmationSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    externalOrderId: string | null;
    clientId: number | null;
    orderNumber: string | null;
    trackingNumber: string;
    carrierCode: string | null;
    carrierProvider: string;
    carrierAccountId: number | string | null;
    confirmationProvider?: string | null;
    shipDate?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<{ queued: boolean; provider: string }> {
  await ensureFulfillmentOutboxSql(sql);
  const provider = args.confirmationProvider ?? inferStoreProviderFromExternalId(args.externalOrderId);
  const supported = provider === 'shipstation' || provider === 'walmart' || provider === 'ebay';
  await sql`
    UPDATE orders
    SET
      source_provider = COALESCE(source_provider, ${provider}),
      source_order_id = COALESCE(source_order_id, ${sourceOrderIdFromExternalId(args.externalOrderId)}),
      source_order_number = COALESCE(source_order_number, ${args.orderNumber}),
      canonical_status = CASE
        WHEN ${supported} THEN 'shipped_pending_confirmation'
        ELSE COALESCE(canonical_status, order_status)
      END,
      updated_at = NOW()
    WHERE id = ${args.orderId}
  `;
  await sql`
    UPDATE shipments
    SET
      carrier_provider = ${args.carrierProvider},
      carrier_account_id = ${args.carrierAccountId == null ? null : String(args.carrierAccountId)},
      confirmation_provider = ${provider},
      confirmation_status = ${supported ? 'pending' : 'not_required'},
      confirmation_last_error = ${supported ? null : `${provider} confirmation connector is not implemented yet`},
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
  if (!supported) return { queued: false, provider };

  const payload = {
    ...args.payload,
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    externalOrderId: args.externalOrderId,
    clientId: args.clientId,
    orderNumber: args.orderNumber,
    trackingNumber: args.trackingNumber,
    carrierCode: args.carrierCode,
    carrierProvider: args.carrierProvider,
    carrierAccountId: args.carrierAccountId,
    shipDate: args.shipDate ?? new Date().toISOString().slice(0, 10),
  };
  const dedupeKey = `shipment_confirmation_requested:${provider}:${args.orderId}:${args.shipmentId}`;
  await sql`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    VALUES (
      ${args.orderId}, ${args.shipmentId}, 'shipment_confirmation_requested',
      ${provider}, ${dedupeKey}, ${sql.json(payload)}, 'pending', 0, NOW(), NOW()
    )
    ON CONFLICT (dedupe_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      status = CASE
        WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.status
        ELSE 'pending'
      END,
      next_run_at = CASE
        WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.next_run_at
        ELSE NOW()
      END,
      updated_at = NOW()
  `;
  return { queued: true, provider };
}

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

// ─── UPS access-token helper (mirrors the one in rates.ts; we duplicate
//     to keep this file self-contained — the function is short and the
//     duplication is preferable to factoring out a shared module).
// ─── Resolve a ship-to address from various sources ──────────────────
// Order of preference: explicit body.shipTo → marketplace order's saved
// raw payload → throw (we genuinely need an address).
function resolveShipTo(body: any, rawOrder: any) {
  if (body?.shipTo && typeof body.shipTo === 'object') {
    return {
      name: String(body.shipTo.name ?? 'Buyer'),
      street1: String(body.shipTo.street1 ?? body.shipTo.address1 ?? ''),
      street2: String(body.shipTo.street2 ?? body.shipTo.address2 ?? ''),
      city: String(body.shipTo.city ?? ''),
      state: String(body.shipTo.state ?? ''),
      zip: String(body.shipTo.zip ?? body.shipTo.postalCode ?? ''),
      country: String(body.shipTo.country ?? body.shipTo.countryCode ?? 'US'),
      phone: String(body.shipTo.phone ?? '0000000000'),
    };
  }
  // Walmart order shape
  const wmAddr = rawOrder?.shippingInfo?.postalAddress;
  if (wmAddr) {
    return {
      name: wmAddr.name ?? 'Buyer',
      street1: wmAddr.address1 ?? '',
      street2: wmAddr.address2 ?? '',
      city: wmAddr.city ?? '',
      state: wmAddr.state ?? '',
      zip: wmAddr.postalCode ?? '',
      country: wmAddr.country ?? 'US',
      phone: rawOrder?.shippingInfo?.phone ?? '0000000000',
    };
  }
  // eBay order shape
  const ebAddr = rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const ebFullName = rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName;
  if (ebAddr) {
    return {
      name: ebFullName ?? 'Buyer',
      street1: ebAddr.addressLine1 ?? '',
      street2: ebAddr.addressLine2 ?? '',
      city: ebAddr.city ?? '',
      state: ebAddr.stateOrProvince ?? '',
      zip: ebAddr.postalCode ?? '',
      country: ebAddr.countryCode ?? 'US',
      phone: rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.primaryPhone?.phoneNumber ?? '0000000000',
    };
  }
  // Amazon order shape
  if (rawOrder?.ShippingAddress) {
    const a = rawOrder.ShippingAddress;
    return {
      name: a.Name ?? 'Buyer',
      street1: a.AddressLine1 ?? '',
      street2: a.AddressLine2 ?? '',
      city: a.City ?? '',
      state: a.StateOrRegion ?? '',
      zip: a.PostalCode ?? '',
      country: a.CountryCode ?? 'US',
      phone: a.Phone ?? '0000000000',
    };
  }
  throw new Error('Could not resolve ship-to address — pass body.shipTo explicitly or use an externalOrderId from a marketplace pull');
}

function resolveShipFrom(creds: Record<string, unknown>) {
  const fromZip = String(creds?.shipFromZip ?? '').replace(/[^0-9]/g, '').slice(0, 5) || '90248';
  return {
    name: String(creds?.shipFromName ?? '').trim() || 'Seller',
    street1: String(creds?.shipFromAddress1 ?? '').trim() || 'Warehouse',
    city: String(creds?.shipFromCity ?? '').trim() || 'Carson',
    state: String(creds?.shipFromState ?? '').trim() || 'CA',
    zip: fromZip,
    country: 'US',
    phone: String(creds?.shipFromPhone ?? '').trim() || '0000000000',
  };
}

// Direct carrier label HTTP calls are owned by CarrierConnector implementations.
const SHIPP_PROVIDER_ID_OFFSET = 10_000_000;

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const LABEL_CREATE_CONNECTOR_CAPABILITIES: Record<string, string[]> = {
  shipp: ['rates.quote', 'labels.create', 'tracking.read', 'credentials.verify'],
  walmart_shipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  ups: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  easypost: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify', 'webhooks.receive'],
};

function labelCreateConnectorCapabilities(providerKey: string): string[] | null {
  return LABEL_CREATE_CONNECTOR_CAPABILITIES[providerKey] ?? null;
}

function slugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeCarrierCodeForDirectRate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = normalizeProviderKey(raw);
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  if (compact.includes('walmart')) return 'walmart_shipping';
  if (compact.includes('amazon')) return 'amazon_shipping';
  if (compact.includes('ebay')) return 'ebay_shipping';
  return normalized || null;
}

function inferCarrierCodeForDirectRate(provider: string, service: string): string {
  const p = normalizeProviderKey(provider);
  const s = service.toLowerCase();
  if (s.includes('usps') || s.includes('postal')) return 'stamps_com';
  if (s.includes('fedex')) return 'fedex';
  if (s.includes('ups')) return 'ups';
  if (s.includes('dhl')) return 'dhl_express';
  return p || 'direct_carrier';
}

function walmartEstimateCarrierName(rate: any): string {
  return firstString(
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    rate?.carrierDisplayName,
  );
}

function walmartEstimateServiceType(rate: any): string {
  return firstString(
    rate?.name,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.carrierServiceName,
    rate?.serviceLevel,
    rate?.method,
    rate?.displayName,
  );
}

function walmartEstimateServiceName(rate: any): string {
  const carrier = firstString(
    rate?.carrierDisplayName,
    rate?.carrierFullName,
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    'Walmart',
  );
  const service = firstString(
    rate?.displayName,
    rate?.serviceTypeGroupDisplayName,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.serviceLevel,
    rate?.method,
    rate?.name,
  );
  return service ? `${carrier} ${service}` : carrier;
}

function walmartEstimateServiceCode(rate: any): string {
  const provider = 'walmart_shipping';
  const serviceName = walmartEstimateServiceName(rate);
  const explicitCarrierCode = normalizeCarrierCodeForDirectRate(
    rate?.carrierCode ?? rate?.carrierType ?? rate?.carrierName ?? rate?.carrierDisplayName,
  );
  const carrierCode = explicitCarrierCode ?? inferCarrierCodeForDirectRate(provider, serviceName);
  const carrierServicePrefix = carrierCode && carrierCode !== provider ? `${carrierCode}_` : '';
  return `${provider}_${carrierServicePrefix}${slugRateService(serviceName)}`;
}

function walmartEstimateCost(rate: any): number {
  return Number(
    rate?.estimatedRate?.amount ??
    rate?.totalCost?.amount ??
    rate?.cost?.amount ??
    rate?.totalCost ??
    rate?.cost ??
    rate?.amount ??
    0,
  ) || 0;
}

function walmartEstimateCurrency(rate: any): string {
  return String(
    rate?.estimatedRate?.currency ??
    rate?.totalCost?.currency ??
    rate?.cost?.currency ??
    rate?.currency ??
    'USD',
  );
}

function walmartEstimateList(data: any): any[] {
  return (
    (Array.isArray(data?.data?.estimates) && data.data.estimates) ||
    (Array.isArray(data?.shippingEstimates) && data.shippingEstimates) ||
    (Array.isArray(data?.rates) && data.rates) ||
    (Array.isArray(data?.estimates) && data.estimates) ||
    (Array.isArray(data?.payload) && data.payload) ||
    (Array.isArray(data) ? data : [])
  );
}

async function getWalmartAccessTokenForLabels(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Walmart clientId and clientSecret are required');
  }
  const channelType = String(creds?.channelType ?? '').trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const correlationId = `prepship-label-${Date.now().toString(36)}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'WM_QOS.CORRELATION_ID': correlationId,
    'WM_SVC.NAME': 'Walmart Marketplace',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  const res = await timedFetch('api.carriers.labels.external', 'https://marketplace.walmartapis.com/v3/token', {
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

function walmartMarketplaceHeaders(
  creds: Record<string, unknown>,
  token: string,
  accept = 'application/json',
  includeJsonContentType = false,
): Record<string, string> {
  const channelType = String(creds?.channelType ?? '').trim();
  const partnerId = String(creds?.partnerId ?? creds?.sellerId ?? '').trim();
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': `prepship-label-${Date.now().toString(36)}`,
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_MARKET': 'us',
    Accept: accept,
  };
  if (includeJsonContentType) headers['Content-Type'] = 'application/json';
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  if (partnerId) headers['WM_PARTNER.ID'] = partnerId;
  return headers;
}

async function readWalmartError(res: Response): Promise<string> {
  const text = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
  if (!text) return res.statusText;
  try {
    const parsed = JSON.parse(text) as { errors?: Array<{ info?: string; code?: string; description?: string }> };
    const first = parsed.errors?.[0];
    return first?.info || first?.description || first?.code || text;
  } catch {
    return text;
  }
}

async function lookupWalmartOrderByCustomerOrderIdForLabels(
  creds: Record<string, unknown>,
  customerOrderId: string,
): Promise<{ purchaseOrderId: string; rawOrder: any } | null> {
  const trimmed = customerOrderId.trim();
  if (!/^\d{8,}$/.test(trimmed)) return null;

  let token: string;
  try {
    token = await getWalmartAccessTokenForLabels(creds);
  } catch (err) {
    console.warn('[carriers/labels] walmart token (lookup) failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const url = new URL('https://marketplace.walmartapis.com/v3/orders');
  url.searchParams.set('customerOrderId', trimmed);
  url.searchParams.set('productInfo', 'true');

  try {
    const res = await timedFetch('api.carriers.labels.external', url.toString(), {
      headers: walmartMarketplaceHeaders(creds, token),
    });
    if (!res.ok) {
      const msg = await readWalmartError(res);
      console.warn(`[carriers/labels] walmart /v3/orders lookup ${res.status}: ${msg}`);
      return null;
    }
    const data = (await res.json()) as { list?: { elements?: { order?: unknown[] | unknown } } };
    return selectWalmartOrderByCustomerOrderId(data, trimmed);
  } catch (err) {
    console.warn('[carriers/labels] walmart /v3/orders lookup error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function selectWalmartOrderByCustomerOrderId(
  data: unknown,
  customerOrderId: string,
): { purchaseOrderId: string; rawOrder: any } | null {
  const trimmed = customerOrderId.trim();
  const ordersRaw = ((data as any)?.list?.elements as { order?: unknown[] | unknown } | undefined)?.order;
  const orders = Array.isArray(ordersRaw) ? ordersRaw : ordersRaw ? [ordersRaw] : [];
  const match = orders.find((order) => String((order as any)?.customerOrderId ?? '').trim() === trimmed);
  if (!match) return null;
  const purchaseOrderId = String((match as any)?.purchaseOrderId ?? '').trim();
  return purchaseOrderId ? { purchaseOrderId, rawOrder: match } : null;
}

function walmartRawOrderUsable(rawOrder: any): boolean {
  return Boolean(
    Array.isArray(rawOrder?.orderLines?.orderLine) ||
    rawOrder?.shippingInfo?.postalAddress,
  );
}

async function resolveWalmartLabelContext(
  sql: any,
  creds: Record<string, unknown>,
  body: Record<string, any>,
  orderRow: any,
  initialRawOrder: any,
): Promise<{
  purchaseOrderId: string;
  purchaseOrderSource: string;
  storeAccountId: number | null;
  rawOrder: any;
  externalOrderId: string | null;
  orderNumber: string | null;
}> {
  let rawOrder = initialRawOrder;
  let externalOrderId = typeof body?.externalOrderId === 'string'
    ? body.externalOrderId
    : orderRow?.external_order_id ?? null;
  let orderNumber = typeof body?.orderNumber === 'string'
    ? body.orderNumber
    : orderRow?.order_number ?? null;
  let purchaseOrderId = firstString(body?.purchaseOrderId, rawOrder?.purchaseOrderId);
  let purchaseOrderSource = purchaseOrderId ? 'body.purchaseOrderId' : 'none';
  let storeAccountId: number | null = null;

  if (!purchaseOrderId && externalOrderId?.startsWith('walmart-')) {
    purchaseOrderId = externalOrderId.slice('walmart-'.length);
    purchaseOrderSource = 'orders.external_order_id';
  }

  const lookupA = purchaseOrderId ?? '';
  const lookupB = externalOrderId?.startsWith('walmart-')
    ? externalOrderId.slice('walmart-'.length)
    : externalOrderId ?? '';
  const lookupC = orderNumber ?? '';

  if (lookupA || lookupB || lookupC) {
    try {
      const orderRows = await sql<Array<{ carrier_account_id: number | null; external_order_id: string; customer_order_id?: string | null; raw: any }>>`
        SELECT carrier_account_id, external_order_id, customer_order_id, raw FROM store_orders
        WHERE provider = 'walmart'
          AND (
            external_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
            OR customer_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
          )
        ORDER BY last_fetched_at DESC NULLS LAST
        LIMIT 1
      `;
      if (orderRows[0]) {
        purchaseOrderId = orderRows[0].external_order_id;
        storeAccountId = orderRows[0].carrier_account_id ?? storeAccountId;
        purchaseOrderSource = purchaseOrderSource === 'none'
          ? 'store_orders lookup'
          : purchaseOrderSource;
        rawOrder = orderRows[0].raw ?? rawOrder;
        externalOrderId = externalOrderId ?? `walmart-${purchaseOrderId}`;
        orderNumber = orderNumber ?? orderRows[0].customer_order_id ?? rawOrder?.customerOrderId ?? null;
      }
    } catch { /* non-fatal */ }
  }

  const candidateCustomerOrderId = (() => {
    const rawCustomerOrderId = firstString(rawOrder?.customerOrderId);
    if (lookupC && /^\d{8,}$/.test(lookupC.trim())) return lookupC.trim();
    if (rawCustomerOrderId && /^\d{8,}$/.test(rawCustomerOrderId.trim())) return rawCustomerOrderId.trim();
    return null;
  })();
  if (candidateCustomerOrderId) {
    const looked = await lookupWalmartOrderByCustomerOrderIdForLabels(creds, candidateCustomerOrderId);
    if (looked) {
      if (purchaseOrderId && purchaseOrderId !== looked.purchaseOrderId) {
        console.warn('[carriers/labels] walmart live PO verification replaced cached purchaseOrderId', {
          customerOrderId: candidateCustomerOrderId,
          previousPurchaseOrderId: purchaseOrderId,
          livePurchaseOrderId: looked.purchaseOrderId,
        });
      }
      purchaseOrderSource = 'walmart_marketplace_api';
      purchaseOrderId = looked.purchaseOrderId;
      rawOrder = looked.rawOrder ?? rawOrder;
      orderNumber = String((looked.rawOrder as any)?.customerOrderId ?? candidateCustomerOrderId);
      externalOrderId = `walmart-${purchaseOrderId}`;
    } else {
      throw new Error(
        `Could not verify live Walmart PO# for customerOrderId ${candidateCustomerOrderId}. Label not purchased.`,
      );
    }
  }

  if (purchaseOrderId && !walmartRawOrderUsable(rawOrder)) {
    try {
      const orderRows = await sql<Array<{ carrier_account_id: number | null; raw: any }>>`
        SELECT carrier_account_id, raw FROM store_orders
        WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
        LIMIT 1
      `;
      storeAccountId = orderRows[0]?.carrier_account_id ?? storeAccountId;
      rawOrder = orderRows[0]?.raw ?? null;
    } catch { /* non-fatal */ }
  }

  if (!purchaseOrderId) {
    throw new Error(
      'Walmart Shipping labels require a Walmart purchaseOrderId. Pull/refresh the Walmart order, then reopen Browse Rates from that order.',
    );
  }

  return {
    purchaseOrderId,
    purchaseOrderSource,
    storeAccountId,
    rawOrder,
    externalOrderId,
    orderNumber,
  };
}

function walmartBoxItems(rawOrder: any): any[] {
  const orderLines = Array.isArray(rawOrder?.orderLines?.orderLine)
    ? rawOrder.orderLines.orderLine
    : [];
  const items = orderLines.map((line: any) => {
    const lineNumber = firstString(line?.lineNumber);
    if (!lineNumber) return null;
    const item: Record<string, unknown> = {
      lineNumber,
      sku: String(line?.item?.sku ?? ''),
      quantity: Number(line?.orderLineQuantity?.amount ?? 1) || 1,
    };
    const productName = firstString(line?.item?.productName, line?.item?.productNameInLocale);
    if (productName) item.productName = productName;
    return item;
  }).filter(Boolean);
  return items;
}

function walmartLabelFromAddress(creds: Record<string, unknown>, shipFrom: any): Record<string, unknown> {
  const from = shipFrom && typeof shipFrom === 'object' ? shipFrom : {};
  const addressLine1 = firstString(creds?.shipFromAddress1, from?.addressLine1, from?.street1, 'Warehouse');
  const addressLine2 = firstString(creds?.shipFromAddress2, from?.addressLine2, from?.street2);
  const result: Record<string, unknown> = {
    addressLine1,
    city: firstString(creds?.shipFromCity, from?.city, 'Carson'),
    contactName: firstString(creds?.shipFromName, from?.name, 'Seller'),
    country: firstString(from?.country, 'US').toUpperCase(),
    phone: firstString(creds?.shipFromPhone, from?.phone, '0000000000'),
    postalCode: firstString(creds?.shipFromZip, from?.postalCode, from?.zip, '90248').replace(/[^0-9]/g, '').slice(0, 5),
    state: firstString(creds?.shipFromState, from?.state, 'CA'),
  };
  const companyName = firstString(creds?.shipFromCompany, from?.company);
  const email = firstString(creds?.shipFromEmail, from?.email);
  if (addressLine2) result.addressLine2 = addressLine2;
  if (companyName) result.companyName = companyName;
  if (email) result.email = email;
  return result;
}

function walmartEstimateFromAddress(labelAddress: Record<string, unknown>): Record<string, unknown> {
  return {
    addressLines: [labelAddress.addressLine1, labelAddress.addressLine2].map((v) => String(v ?? '').trim()).filter(Boolean),
    city: String(labelAddress.city ?? ''),
    state: String(labelAddress.state ?? ''),
    postalCode: String(labelAddress.postalCode ?? ''),
    countryCode: String(labelAddress.country ?? 'US'),
  };
}

function walmartEstimateToAddress(body: Record<string, any>, rawOrder: any): Record<string, unknown> {
  const shipTo = resolveShipTo(body, rawOrder);
  return {
    addressLines: [shipTo.street1, shipTo.street2].filter(Boolean),
    city: shipTo.city,
    state: shipTo.state,
    postalCode: shipTo.zip,
    countryCode: shipTo.country || 'US',
  };
}

function walmartIsoDate(value: unknown, fallbackDays: number): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(Date.now() + fallbackDays * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchWalmartEstimatesForLabel(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    dimsL: number;
    dimsW: number;
    dimsH: number;
    purchaseOrderId: string;
    rawOrder: any;
    body: Record<string, any>;
    fromAddress: Record<string, unknown>;
    boxItems: any[];
  },
): Promise<{ token: string; rates: any[] }> {
  const token = await getWalmartAccessTokenForLabels(creds);
  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  const estimateBody = {
    purchaseOrderId: input.purchaseOrderId,
    boxDimensions: {
      boxWeight: weightLb,
      boxWeightUnit: 'LB',
      boxLength: input.dimsL,
      boxWidth: input.dimsW,
      boxHeight: input.dimsH,
      boxDimensionUnit: 'IN',
    },
    fromAddress: walmartEstimateFromAddress(input.fromAddress),
    toAddress: walmartEstimateToAddress(input.body, input.rawOrder),
    packageType: 'CUSTOM_PACKAGE',
    shipByDate: walmartIsoDate(input.rawOrder?.shippingInfo?.estimatedShipDate, 1),
    deliverByDate: walmartIsoDate(input.rawOrder?.shippingInfo?.estimatedDeliveryDate, 5),
    includeServicesNotMeetingDeliveryPromise: true,
    boxItems: input.boxItems,
    addOns: false,
    hasBattery: false,
  };
  console.info('[carriers/labels] walmart shipping estimate request', {
    hasPurchaseOrderId: Boolean(input.purchaseOrderId),
    weightUnit: 'LB',
    dimensionUnit: 'IN',
    boxItemCount: input.boxItems.length,
    requestKeys: walmartSafeObjectKeys(estimateBody),
  });
  const res = await timedFetch('api.carriers.labels.external', 'https://marketplace.walmartapis.com/v3/shipping/labels/shipping-estimates', {
    method: 'POST',
    headers: walmartMarketplaceHeaders(creds, token, 'application/json', true),
    body: JSON.stringify(estimateBody),
  });
  if (!res.ok) {
    throw new Error(`Walmart Shipping Estimates ${res.status}: ${await readWalmartError(res)}`);
  }
  const data = await res.json();
  const rates = walmartEstimateList(data).filter((rate) => walmartEstimateCost(rate) > 0);
  console.info('[carriers/labels] walmart shipping estimate response', {
    responseKeys: walmartSafeObjectKeys(data),
    dataKeys: walmartSafeObjectKeys(data?.data),
    usableRateCount: rates.length,
  });
  return { token, rates };
}

function selectWalmartEstimateRate(rates: any[], serviceCode: unknown): any | null {
  const wanted = normalizeProviderKey(serviceCode);
  if (!wanted) return null;
  const exact = rates.find((rate) => normalizeProviderKey(walmartEstimateServiceCode(rate)) === wanted);
  if (exact) return exact;
  return rates.find((rate) => {
    const serviceSlug = slugRateService(walmartEstimateServiceName(rate));
    return serviceSlug && wanted.endsWith(serviceSlug);
  }) ?? null;
}

function walmartTrackingUrl(carrierName: string, trackingNumber: string): string {
  const carrier = normalizeProviderKey(carrierName);
  const encoded = encodeURIComponent(trackingNumber);
  if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (carrier.includes('usps') || carrier.includes('postal')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  return '';
}

function walmartShipmentMethodCode(rawOrder: any): string {
  return firstString(rawOrder?.shippingInfo?.methodCode, 'VALUE');
}

function walmartShipmentStatusQuantity(line: any): Record<string, string> {
  const statuses = Array.isArray(line?.orderLineStatuses?.orderLineStatus)
    ? line.orderLineStatuses.orderLineStatus
    : [];
  const statusQuantity = statuses.find((status: any) => status?.statusQuantity)?.statusQuantity;
  const quantity = statusQuantity ?? line?.orderLineQuantity ?? {};
  return {
    unitOfMeasurement: firstString(quantity?.unitOfMeasurement, 'EACH'),
    amount: firstString(quantity?.amount, '1'),
  };
}

function walmartShipmentLineNumber(line: any): string {
  return firstString(line?.lineNumber);
}

function walmartShipmentConfirmationBody(
  rawOrder: any,
  input: {
    carrierName: string;
    methodCode: string;
    shipDateTime: number;
    trackingNumber: string;
    trackingUrl: string;
  },
): { orderShipment: { orderLines: { orderLine: Array<Record<string, unknown>> } } } {
  const orderLines = Array.isArray(rawOrder?.orderLines?.orderLine)
    ? rawOrder.orderLines.orderLine
    : [];
  const orderLine = orderLines
    .filter((line: any) => {
      const statuses = Array.isArray(line?.orderLineStatuses?.orderLineStatus)
        ? line.orderLineStatuses.orderLineStatus
        : [];
      return walmartShipmentLineNumber(line) && (!statuses.length || statuses.some((status: any) => !/cancel/i.test(String(status?.status ?? ''))));
    })
    .map((line: any) => ({
      lineNumber: walmartShipmentLineNumber(line),
      orderLineStatuses: {
        orderLineStatus: [
          {
            status: 'Shipped',
            statusQuantity: walmartShipmentStatusQuantity(line),
            trackingInfo: {
              shipDateTime: input.shipDateTime,
              carrierName: { carrier: input.carrierName },
              methodCode: input.methodCode,
              trackingNumber: input.trackingNumber,
              ...(input.trackingUrl ? { trackingURL: input.trackingUrl } : {}),
            },
          },
        ],
      },
    }));
  return {
    orderShipment: {
      orderLines: {
        orderLine,
      },
    },
  };
}

async function confirmWalmartOrderShipped(
  creds: Record<string, unknown>,
  token: string,
  input: {
    purchaseOrderId: string;
    rawOrder: any;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string;
    shipDate?: string | null;
  },
): Promise<any> {
  if (!firstString(input.trackingNumber)) {
    throw new Error('Walmart shipment confirmation missing tracking number');
  }
  const methodCode = walmartShipmentMethodCode(input.rawOrder);
  const parsedShipDate = input.shipDate ? Date.parse(input.shipDate) : NaN;
  const shipmentBody = walmartShipmentConfirmationBody(input.rawOrder, {
    carrierName: input.carrierName,
    methodCode,
    shipDateTime: Number.isFinite(parsedShipDate) ? parsedShipDate : Date.now(),
    trackingNumber: input.trackingNumber,
    trackingUrl: input.trackingUrl,
  });
  if (!shipmentBody.orderShipment.orderLines.orderLine.length) {
    throw new Error('Walmart shipment confirmation has no shippable order lines');
  }

  const res = await timedFetch('api.carriers.labels.external', 
    `https://marketplace.walmartapis.com/v3/orders/${encodeURIComponent(input.purchaseOrderId)}/shipping`,
    {
      method: 'POST',
      headers: walmartMarketplaceHeaders(creds, token, 'application/json', true),
      body: JSON.stringify(shipmentBody),
    },
  );
  if (!res.ok) {
    throw new Error(`Walmart Ship Confirm ${res.status}: ${await readWalmartError(res)}`);
  }
  const text = await res.text().catch(() => '');
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, body: text.slice(0, 500) };
  }
}

async function downloadWalmartLabelPdf(
  creds: Record<string, unknown>,
  token: string,
  carrierName: string,
  trackingNumber: string,
): Promise<string> {
  const url = `https://marketplace.walmartapis.com/v3/shipping/labels/carriers/${encodeURIComponent(carrierName)}/trackings/${encodeURIComponent(trackingNumber)}`;
  const res = await timedFetch('api.carriers.labels.external', url, {
    headers: walmartMarketplaceHeaders(creds, token, 'application/pdf'),
  });
  if (!res.ok) {
    console.warn(`[carriers/labels] walmart label download ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }
  const contentType = res.headers.get('content-type') || 'application/pdf';
  if (!/pdf/i.test(contentType)) {
    console.warn(`[carriers/labels] walmart label download returned ${contentType}`);
    return '';
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:application/pdf;base64,${buffer.toString('base64')}`;
}

const WALMART_LABEL_BASE64_KEYS = new Set([
  'labeldata',
  'label_data',
  'labelbase64',
  'labelpdf',
  'pdffile',
  'pdfdata',
  'pdf_data',
  'pdfbase64',
]);

const WALMART_LABEL_URL_KEYS = new Set([
  'labelurl',
  'label_url',
  'labeldownloadurl',
  'label_download_url',
  'downloadurl',
  'download_url',
  'labeldownload',
  'label_download',
  'href',
  'url',
]);

const WALMART_LABEL_BASE64_CHILD_KEYS = new Set([
  'data',
  'content',
  'pdf',
  'base64',
  'labeldata',
  'label_data',
  'labelbase64',
  'pdfbase64',
]);

const WALMART_LABEL_URL_CHILD_KEYS = new Set([
  'href',
  'url',
  'pdf',
  'download',
  'downloadurl',
  'download_url',
  'labelurl',
  'label_url',
]);

function walmartLabelKeySummary(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 6);
  return `object(${keys.join(',') || 'no_keys'})`;
}

function walmartSafeObjectKeys(value: unknown): string[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 8);
}

function walmartLabelPath(parent: string, key: string): string {
  if (!parent || parent === 'response') return key;
  return `${parent}.${key}`;
}

function walmartLabelReject(diagnostics: string[], path: string, value: unknown, reason: string): void {
  diagnostics.push(`${path}:${walmartLabelKeySummary(value)}_${reason}`);
}

function validateWalmartLabelString(
  value: string,
  mode: 'base64' | 'url',
  path: string,
  diagnostics: string[],
): { value: string; path: string } | null {
  const text = value.trim();
  if (!text) {
    walmartLabelReject(diagnostics, path, value, 'empty');
    return null;
  }
  if (text === '[object Object]') {
    walmartLabelReject(diagnostics, path, value, 'invalid');
    return null;
  }
  if (mode === 'url') {
    if (/^https?:\/\//i.test(text)) return { value: text, path };
    walmartLabelReject(diagnostics, path, value, 'unsupported');
    return null;
  }
  const compact = text.replace(/\s+/g, '');
  if (/^data:application\/pdf/i.test(compact)) return { value: compact, path };
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
    return { value: compact, path };
  }
  walmartLabelReject(diagnostics, path, value, 'unsupported');
  return null;
}

function extractWalmartLabelReference(
  payload: unknown,
  mode: 'base64' | 'url',
): { value: string; path: string; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const rootKeys = mode === 'base64' ? WALMART_LABEL_BASE64_KEYS : WALMART_LABEL_URL_KEYS;
  const childKeys = mode === 'base64' ? WALMART_LABEL_BASE64_CHILD_KEYS : WALMART_LABEL_URL_CHILD_KEYS;

  const scan = (value: unknown, path: string, depth: number, withinCandidate: boolean): { value: string; path: string } | null => {
    if (depth > 8 || value == null) return null;
    if (typeof value === 'string') {
      return withinCandidate ? validateWalmartLabelString(value, mode, path, diagnostics) : null;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const found = scan(item, `${path}[${index}]`, depth + 1, withinCandidate);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') {
      if (withinCandidate) walmartLabelReject(diagnostics, path, value, 'unsupported');
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const [key, raw] of Object.entries(record)) {
      const normalized = key.toLowerCase();
      const keyPath = walmartLabelPath(path, key);
      if (rootKeys.has(normalized) || (withinCandidate && childKeys.has(normalized))) {
        const found = scan(raw, keyPath, depth + 1, true);
        if (found) return found;
        if (raw == null || typeof raw !== 'object') {
          walmartLabelReject(diagnostics, keyPath, raw, 'unsupported');
        }
      }
    }

    for (const [key, raw] of Object.entries(record)) {
      const found = scan(raw, walmartLabelPath(path, key), depth + 1, withinCandidate);
      if (found) return found;
    }
    return null;
  };

  const found = scan(payload, 'response', 0, false);
  if (found) return { ...found, diagnostics };
  if (diagnostics.length) {
    throw new Error(`Walmart label ${mode} extraction rejected unsupported fields: ${diagnostics.slice(0, 8).join('; ')}`);
  }
  return { value: '', path: '', diagnostics };
}

export function __test_extractWalmartLabelReference(payload: unknown, mode: 'base64' | 'url') {
  return extractWalmartLabelReference(payload, mode);
}

export function __test_selectWalmartOrderByCustomerOrderId(data: unknown, customerOrderId: string) {
  return selectWalmartOrderByCustomerOrderId(data, customerOrderId);
}

function walmartLabelExtractionErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Walmart label extraction failed';
}

function findWalmartLabelString(value: unknown, keys: string[], depth = 0): string {
  void depth;
  const normalized = new Set(keys.map((key) => key.toLowerCase()));
  const mode = [...normalized].some((key) => WALMART_LABEL_BASE64_KEYS.has(key)) ? 'base64' : 'url';
  try {
    return extractWalmartLabelReference(value, mode).value;
  } catch (err) {
    console.warn('[carriers/labels] walmart label extraction rejected:', walmartLabelExtractionErrorMessage(err));
    return '';
  }
}

function walmartLabelDataUrlFromPayload(payload: unknown): string {
  let base64 = '';
  try {
    base64 = extractWalmartLabelReference(payload, 'base64').value.replace(/\s+/g, '');
  } catch (err) {
    console.warn('[carriers/labels] walmart label data extraction rejected:', walmartLabelExtractionErrorMessage(err));
    return '';
  }
  if (!base64) return '';
  if (/^data:application\/pdf/i.test(base64)) return base64;
  if (/^[A-Za-z0-9+/=]+$/.test(base64) && base64.length > 100) {
    return `data:application/pdf;base64,${base64}`;
  }
  return '';
}

async function downloadWalmartLabelPdfFromUrl(
  creds: Record<string, unknown>,
  token: string,
  url: string,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return '';
  const res = await timedFetch('api.carriers.labels.external', url, {
    headers: walmartMarketplaceHeaders(creds, token, 'application/pdf,application/json,image/png,*/*'),
  });
  if (!res.ok) {
    console.warn(`[carriers/labels] walmart label download url ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }

  const contentType = res.headers.get('content-type') || '';
  if (/pdf/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:application/pdf;base64,${buffer.toString('base64')}`;
  }
  if (/json/i.test(contentType)) {
    return walmartLabelDataUrlFromPayload(await res.json().catch(() => null));
  }
  if (/image\/png/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buffer.toString('base64')}`;
  }
  return '';
}

async function downloadWalmartLabelPdfById(
  creds: Record<string, unknown>,
  token: string,
  labelId: string,
): Promise<string> {
  const res = await timedFetch('api.carriers.labels.external', 
    `https://marketplace.walmartapis.com/v3/shipping/labels/${encodeURIComponent(labelId)}`,
    {
      headers: walmartMarketplaceHeaders(creds, token, 'application/pdf,application/json'),
    },
  );
  if (!res.ok) {
    console.warn(`[carriers/labels] walmart label download by id ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }

  const contentType = res.headers.get('content-type') || '';
  if (/pdf/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:application/pdf;base64,${buffer.toString('base64')}`;
  }

  const text = await res.text().catch(() => '');
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const labelUrl = walmartLabelDataUrlFromPayload(parsed);
    if (labelUrl) return labelUrl;
    const directUrl = findWalmartLabelString(parsed, ['labelUrl', 'labelURL', 'downloadUrl', 'downloadURL', 'href', 'url']);
    return directUrl ? downloadWalmartLabelPdfFromUrl(creds, token, directUrl) : '';
  } catch {
    const compact = text.trim().replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
      return `data:application/pdf;base64,${compact}`;
    }
    return '';
  }
}

async function markWalmartConfirmationAttemptSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    provider: string;
    succeeded: boolean;
    error?: string | null;
  },
): Promise<void> {
  const dedupeKeyPrefix = `shipment_confirmation_requested:${args.provider}:${args.orderId}:${args.shipmentId}`;
  await sql`
    UPDATE shipments
    SET
      confirmation_status = ${args.succeeded ? 'succeeded' : 'failed'},
      confirmation_attempts = COALESCE(confirmation_attempts, 0) + 1,
      confirmation_last_error = ${args.succeeded ? null : args.error ?? 'Walmart confirmation failed'},
      marketplace_confirmed_at = CASE WHEN ${args.succeeded} THEN NOW() ELSE marketplace_confirmed_at END,
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
  await sql`
    UPDATE fulfillment_outbox
    SET
      status = ${args.succeeded ? 'succeeded' : 'failed'},
      attempts = attempts + 1,
      last_error = ${args.succeeded ? null : args.error ?? 'Walmart confirmation failed'},
      next_run_at = CASE
        WHEN ${args.succeeded} THEN next_run_at
        ELSE NOW() + INTERVAL '2 minutes'
      END,
      updated_at = NOW()
    WHERE dedupe_key = ${dedupeKeyPrefix}
  `;
  await sql`
    UPDATE orders
    SET canonical_status = ${args.succeeded ? 'shipped' : 'confirmation_failed'}, updated_at = NOW()
    WHERE id = ${args.orderId}
  `;
}

async function loadWalmartStoreCredentialsForConfirmationSql(
  sql: any,
  args: {
    purchaseOrderId?: string | null;
    storeAccountId?: number | string | null;
    fallbackCreds: Record<string, unknown>;
  },
): Promise<{ credentials: Record<string, unknown>; storeAccountId: number | null; source: string }> {
  const explicitId = Number(args.storeAccountId);
  let accountId = Number.isFinite(explicitId) && explicitId > 0 ? Math.trunc(explicitId) : null;

  const loadById = async (id: number) => {
    const rows = await sql<Array<{ id: number; credentials: Record<string, unknown> }>>`
      SELECT id, credentials
      FROM store_accounts
      WHERE id = ${id} AND provider = 'walmart'
      LIMIT 1
    `;
    const row = rows[0];
    return row?.credentials ? { credentials: row.credentials, storeAccountId: row.id, source: `store_accounts.${row.id}` } : null;
  };

  if (accountId) {
    const explicit = await loadById(accountId).catch(() => null);
    if (explicit) return explicit;
    accountId = null;
  }

  const purchaseOrderId = firstString(args.purchaseOrderId);
  if (purchaseOrderId) {
    const rows = await sql<Array<{ carrier_account_id: number | null }>>`
      SELECT carrier_account_id
      FROM store_orders
      WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
      LIMIT 1
    `.catch(() => []) as Array<{ carrier_account_id: number | null }>;
    const inferredId = rows[0]?.carrier_account_id;
    if (inferredId) {
      const inferred = await loadById(inferredId).catch(() => null);
      if (inferred) return { ...inferred, source: `store_orders.${purchaseOrderId}->${inferred.source}` };
    }
  }

  return { credentials: args.fallbackCreds, storeAccountId: null, source: 'label_account_fallback' };
}

async function confirmWalmartSourceOrderAfterLabelSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    purchaseOrderId: string | null;
    rawOrder: any;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string;
    shipDate?: string | null;
    storeAccountId?: number | string | null;
    fallbackCreds: Record<string, unknown>;
  },
): Promise<{
  confirmed: boolean;
  error: string | null;
  raw: any;
  storeAccountId: number | null;
  credentialSource: string;
}> {
  const purchaseOrderId = firstString(args.purchaseOrderId);
  if (!purchaseOrderId) {
    throw new Error('Walmart shipment confirmation missing purchaseOrderId');
  }

  const loaded = await loadWalmartStoreCredentialsForConfirmationSql(sql, {
    purchaseOrderId,
    storeAccountId: args.storeAccountId,
    fallbackCreds: args.fallbackCreds,
  });
  const token = await getWalmartAccessTokenForLabels(loaded.credentials);
  const raw = await confirmWalmartOrderShipped(loaded.credentials, token, {
    purchaseOrderId,
    rawOrder: args.rawOrder,
    carrierName: args.carrierName,
    trackingNumber: args.trackingNumber,
    trackingUrl: args.trackingUrl,
    shipDate: args.shipDate,
  });
  await markWalmartConfirmationAttemptSql(sql, {
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    provider: 'walmart',
    succeeded: true,
  });
  return {
    confirmed: true,
    error: null,
    raw,
    storeAccountId: loaded.storeAccountId,
    credentialSource: loaded.source,
  };
}

async function buyLabelWalmartShipping(
  sql: any,
  creds: Record<string, unknown>,
  input: {
    body: Record<string, any>;
    orderRow: any;
    rawOrder: any;
    weightOz: number;
    dimsL: number;
    dimsW: number;
    dimsH: number;
  },
): Promise<{
  trackingNumber: string;
  labelUrl: string;
  cost: number;
  currency: string;
  shipmentId: string;
  carrierCode: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  selectedRate: any;
  raw: any;
  context: Awaited<ReturnType<typeof resolveWalmartLabelContext>>;
  shipmentConfirmed: boolean;
  shipmentConfirmError: string | null;
  shipmentConfirmRaw: any;
}> {
  const context = await resolveWalmartLabelContext(sql, creds, input.body, input.orderRow, input.rawOrder);
  const fromAddress = walmartLabelFromAddress(creds, input.body?.shipFrom);
  const boxItems = walmartBoxItems(context.rawOrder);
  if (!boxItems.length) {
    throw new Error('Cannot create Walmart Shipping label: missing Walmart order line numbers');
  }
  const { token, rates } = await fetchWalmartEstimatesForLabel(creds, {
    weightOz: input.weightOz,
    dimsL: input.dimsL,
    dimsW: input.dimsW,
    dimsH: input.dimsH,
    purchaseOrderId: context.purchaseOrderId,
    rawOrder: context.rawOrder,
    body: input.body,
    fromAddress,
    boxItems,
  });

  if (!rates.length) {
    throw new Error('Walmart returned 0 rates for this order. Browse Rates again with a different package size or confirm Ship With Walmart is enabled in Seller Center.');
  }

  const selectedRate = selectWalmartEstimateRate(rates, input.body?.serviceCode);
  if (!selectedRate) {
    throw new Error('Selected Walmart Shipping service is no longer available. Click Browse Rates again and select one of the current Walmart rates.');
  }

  const carrierName = walmartEstimateCarrierName(selectedRate);
  const carrierServiceType = walmartEstimateServiceType(selectedRate);
  if (!carrierName || !carrierServiceType) {
    throw new Error('Walmart did not return the carrierName/carrierServiceType required to buy this label. Click Browse Rates again and choose another Walmart rate.');
  }

  const addOns = /signature/i.test(String(input.body?.confirmation ?? '')) ? ['SIGNATURE'] : [];
  const labelBody: Record<string, unknown> = {
    boxDimensions: {
      boxWeight: Math.max(1, Math.round(input.weightOz)),
      boxWeightUnit: 'OZ',
      boxLength: input.dimsL,
      boxWidth: input.dimsW,
      boxHeight: input.dimsH,
      boxDimensionUnit: 'IN',
    },
    boxItems,
    carrierName,
    carrierServiceType,
    packageType: 'CUSTOM_PACKAGE',
    purchaseOrderId: context.purchaseOrderId,
    fromAddress,
    returnAddress: fromAddress,
    addOns,
    hasBattery: false,
    hazmat: false,
  };
  const accountType = firstString(input.body?.accountType, creds?.accountType);
  if (accountType) labelBody.accountType = accountType;

  console.info('[carriers/labels] walmart create label request', {
    hasPurchaseOrderId: Boolean(context.purchaseOrderId),
    carrierName: Boolean(carrierName),
    carrierServiceType: Boolean(carrierServiceType),
    boxItemCount: boxItems.length,
    requestKeys: walmartSafeObjectKeys(labelBody),
  });
  const res = await timedFetch('api.carriers.labels.external', 'https://marketplace.walmartapis.com/v3/shipping/labels', {
    method: 'POST',
    headers: walmartMarketplaceHeaders(creds, token, 'application/json', true),
    body: JSON.stringify(labelBody),
  });
  if (!res.ok) {
    throw new Error(`Walmart Create Label ${res.status}: ${await readWalmartError(res)}`);
  }

  const data = await res.json();
  const details = data?.data && typeof data.data === 'object' ? data.data : data;
  console.info('[carriers/labels] walmart create label response', {
    responseKeys: walmartSafeObjectKeys(data),
    detailKeys: walmartSafeObjectKeys(details),
    responseShape: walmartLabelKeySummary(data),
  });
  const labelId = firstString(
    details?.labelId,
    details?.labelID,
    details?.label_id,
    details?.id,
    data?.labelId,
  );
  const trackingNumber = firstString(
    details?.trackingNo,
    details?.trackingNumber,
    details?.tracking_number,
    details?.tracking,
  );
  if (!trackingNumber) {
    throw new Error('Walmart created a label response without a tracking number');
  }

  const responseCarrierName = firstString(details?.carrierName, carrierName);
  const trackingUrl = firstString(
    details?.trackingUrl,
    details?.trackingURL,
    selectedRate?.trackingUrl,
    selectedRate?.trackingURL,
    walmartTrackingUrl(responseCarrierName, trackingNumber),
  );
  let shipmentConfirmed: boolean | null = null;
  let shipmentConfirmError: string | null = null;
  let shipmentConfirmRaw: any = null;
  // Shipment confirmation runs after the label is persisted. The handler
  // attempts it immediately, and the outbox row remains the retry safety net.

  let labelUrl = walmartLabelDataUrlFromPayload(data);
  if (!labelUrl) {
    const directUrl = findWalmartLabelString(data, ['labelUrl', 'labelURL', 'downloadUrl', 'downloadURL', 'href', 'url']);
    if (directUrl) {
      labelUrl = await downloadWalmartLabelPdfFromUrl(creds, token, directUrl).catch((err) => {
        console.warn('[carriers/labels] walmart label PDF download url failed:', err instanceof Error ? err.message : err);
        return '';
      });
    }
  }
  if (!labelUrl && labelId) {
    labelUrl = await downloadWalmartLabelPdfById(creds, token, labelId).catch((err) => {
      console.warn('[carriers/labels] walmart label PDF download by id failed:', err instanceof Error ? err.message : err);
      return '';
    });
  }
  if (!labelUrl) {
    labelUrl = await downloadWalmartLabelPdf(creds, token, responseCarrierName, trackingNumber).catch((err) => {
      console.warn('[carriers/labels] walmart label PDF download failed:', err instanceof Error ? err.message : err);
      return '';
    });
  }
  const serviceName = walmartEstimateServiceName(selectedRate);
  const serviceCode = walmartEstimateServiceCode(selectedRate);
  const carrierCode = normalizeCarrierCodeForDirectRate(responseCarrierName) ?? inferCarrierCodeForDirectRate('walmart_shipping', serviceName);

  return {
    trackingNumber,
    labelUrl,
    cost: walmartEstimateCost(selectedRate),
    currency: walmartEstimateCurrency(selectedRate),
    shipmentId: trackingNumber,
    carrierCode,
    carrierName: responseCarrierName,
    serviceCode,
    serviceName,
    selectedRate,
    raw: data,
    context,
    shipmentConfirmed,
    shipmentConfirmError,
    shipmentConfirmRaw,
  };
}

async function persistWalmartShipment(
  sql: any,
  args: {
    body: Record<string, any>;
    provider: string;
    carrierAccountId: number;
    syntheticProviderId: number;
    carrierLabel: string | null;
    result: Awaited<ReturnType<typeof buyLabelWalmartShipping>>;
  },
) {
  const orderId = Number(args.body.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('orderId is required for Walmart Shipping label creation');
  }

  const selectedRateJson = {
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    serviceName: args.result.serviceName,
    carrierNickname: args.carrierLabel ?? 'Walmart Shipping',
    providerAccountNickname: args.carrierLabel ?? 'Walmart Shipping',
    providerAccountId: args.syntheticProviderId,
    shippingProviderId: args.syntheticProviderId,
    provider: 'walmart_shipping',
    source: 'carrier_accounts',
    amount: args.result.cost,
    cost: args.result.cost,
    shipmentCost: args.result.cost,
    otherCost: 0,
      deliveryDays: Number(args.result.selectedRate?.transitTime?.businessDays ?? args.result.selectedRate?.transitDays ?? args.result.selectedRate?.deliveryDays ?? 0) || null,
  };

  return persistDirectCarrierLabel(sql, {
    orderId,
    carrierProvider: 'Walmart Shipping',
    carrierAccountId: args.syntheticProviderId,
    carrierLabel: args.carrierLabel ?? 'Walmart Shipping',
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    trackingNumber: args.result.trackingNumber,
    labelUrl: args.result.labelUrl || null,
    labelFormat: args.result.labelUrl?.startsWith('data:application/pdf') ? 'pdf' : null,
    cost: args.result.cost,
    currency: args.result.currency,
    weightOz: Number(args.body.weightOz ?? 0),
    dimsL: Number(args.body.dimsL ?? args.body.length ?? 0) || null,
    dimsW: Number(args.body.dimsW ?? args.body.width ?? 0) || null,
    dimsH: Number(args.body.dimsH ?? args.body.height ?? 0) || null,
    selectedRateJson,
    labelProvider: args.syntheticProviderId,
    labelShipmentId: null,
    selectedPid: args.syntheticProviderId,
    selectedPackageId: args.body.customPackageId != null ? String(args.body.customPackageId) : null,
    source: 'walmart_shipping',
  });
}

// Shipp provider HTTP calls are owned by src/connectors/carrier/shipp.ts.
async function persistShippShipment(
  sql: any,
  args: {
    body: Record<string, any>;
    provider: string;
    carrierAccountId: number;
    syntheticProviderId: number;
    carrierLabel: string | null;
    result: any;
  },
) {
  const orderId = Number(args.body.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('orderId is required for Shipp label creation');
  }

  const selectedRateJson = {
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    serviceName: args.result.serviceName,
    carrierNickname: args.carrierLabel ?? 'Shipp',
    providerAccountNickname: args.carrierLabel ?? 'Shipp',
    providerAccountId: args.syntheticProviderId,
    shippingProviderId: args.syntheticProviderId,
    provider: 'shipp',
    source: 'carrier_accounts',
    amount: args.result.cost,
    cost: args.result.cost,
    shipmentCost: args.result.cost,
    otherCost: 0,
    deliveryDays: Number(args.result.deliveryDays ?? 0) || null,
  };

  return persistDirectCarrierLabel(sql, {
    orderId,
    carrierProvider: 'Shipp',
    carrierAccountId: args.syntheticProviderId,
    carrierLabel: args.carrierLabel ?? 'Shipp',
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    trackingNumber: args.result.trackingNumber,
    labelUrl: args.result.labelUrl,
    labelFormat: args.result.labelUrl?.startsWith('data:application/pdf') ? 'pdf' : 'image',
    cost: args.result.cost,
    currency: args.result.currency,
    weightOz: Number(args.body.weightOz ?? 0),
    dimsL: Number(args.body.dimsL ?? args.body.length ?? 0) || null,
    dimsW: Number(args.body.dimsW ?? args.body.width ?? 0) || null,
    dimsH: Number(args.body.dimsH ?? args.body.height ?? 0) || null,
    selectedRateJson,
    labelProvider: args.syntheticProviderId,
    labelShipmentId: null,
    selectedPid: args.syntheticProviderId,
    selectedPackageId: args.body.customPackageId != null ? String(args.body.customPackageId) : null,
    source: 'shipp',
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token', reason: verified.reason }); return; }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    const body = (await readBody(req)) as Record<string, any>;
    const carrierAccountId = Number(body?.carrierAccountId);
    if (!Number.isFinite(carrierAccountId)) {
      res.status(400).json({ error: 'carrierAccountId is required' });
      return;
    }
    const weightOz = Number(body?.weightOz);
    const dimsL = Number(body?.dimsL);
    const dimsW = Number(body?.dimsW);
    const dimsH = Number(body?.dimsH);
    if (!weightOz || !dimsL || !dimsW || !dimsH) {
      res.status(400).json({ error: 'weightOz + dimsL/W/H are required' });
      return;
    }

    const carrierRows = await sql<Array<{ provider: string; credentials: any; label: string | null }>>`
      SELECT provider, credentials, label FROM carrier_accounts
      WHERE id = ${carrierAccountId} LIMIT 1
    `;
    if (carrierRows.length === 0) {
      res.status(404).json({ error: `carrier_account ${carrierAccountId} not found` });
      return;
    }
    const { provider, credentials, label } = carrierRows[0];
    const providerKey = normalizeProviderKey(provider);
    const connectorCapabilities = labelCreateConnectorCapabilities(providerKey);
    if (!connectorCapabilities) {
      res.status(400).json({
        ok: false,
        error: `Label purchase for "${provider}" is not registered as a carrier connector.`,
      });
      return;
    }
    const creds = (credentials ?? {}) as Record<string, unknown>;

    // Fetch the saved order's raw payload to derive ship-to (when caller
    // didn't pass an explicit shipTo override).
    let rawOrder: any = null;
    let orderRow: any = null;
    let orderLookupError: string | null = null;
    const orderId = Number(body?.orderId);
    if (Number.isFinite(orderId) && orderId > 0) {
      try {
        const rows = await sql<Array<{
          id: number;
          client_id: number | null;
          order_number: string | null;
          external_order_id: string | null;
          order_status: string | null;
          raw: any;
        }>>`
          SELECT id, client_id, order_number, external_order_id, order_status, raw
          FROM orders
          WHERE id = ${Math.trunc(orderId)}
          LIMIT 1
        `;
        orderRow = rows[0] ?? null;
        rawOrder = orderRow?.raw ?? null;
      } catch (err) {
        orderLookupError = err instanceof Error ? err.message : String(err);
      }
    }

    const explicitExternalOrderId = typeof body?.externalOrderId === 'string'
      ? body.externalOrderId
      : null;
    const externalOrderId = explicitExternalOrderId ?? orderRow?.external_order_id ?? null;
    const orderNumber = typeof body?.orderNumber === 'string'
      ? body.orderNumber
      : orderRow?.order_number ?? null;
    if (externalOrderId) {
      const m = externalOrderId.match(/^([a-z_]+)-(.+)$/);
      if (m) {
        try {
          const rows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = ${m[1]} AND external_order_id = ${m[2]}
            LIMIT 1
          `;
          rawOrder = rows[0]?.raw ?? rawOrder;
        } catch { /* non-fatal */ }
      }
    }

    if (providerKey === 'shipp') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for Shipp label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying Shipp label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create Shipp label for ${orderRow.order_status} order` });
        return;
      }

      const serviceCode = String(body?.serviceCode ?? '').trim();
      if (!serviceCode) {
        res.status(400).json({ ok: false, error: 'serviceCode is required for Shipp label creation' });
        return;
      }

      const syntheticProviderId = Number.isFinite(Number(body?.shippingProviderId))
        ? Number(body.shippingProviderId)
        : SHIPP_PROVIDER_ID_OFFSET + carrierAccountId;
      const result = await createCarrierLabel('shipp', {
        credentials: creds,
        serviceCode,
        weightOz,
        dimsL,
        dimsW,
        dimsH,
        shipFrom: body?.shipFrom,
        shipTo: body?.shipTo,
        rawOrder,
        externalOrderId,
        orderNumber,
      });
      const persisted = await persistShippShipment(sql, {
        body,
        provider: providerKey,
        carrierAccountId,
        syntheticProviderId,
        carrierLabel: label,
        result,
      });
      const confirmation = await enqueueShipmentConfirmationSql(sql, {
        orderId,
        shipmentId: persisted.localShipmentId,
        externalOrderId,
        clientId: persisted.clientId,
        orderNumber: persisted.orderNumber,
        trackingNumber: result.trackingNumber,
        carrierCode: result.carrierCode,
        carrierProvider: 'shipp',
        carrierAccountId,
        shipDate: new Date().toISOString().slice(0, 10),
        payload: {
          purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
          rawOrder,
          carrierName: result.carrierName ?? result.carrierCode,
          trackingUrl: null,
          serviceCode: result.serviceCode,
          serviceName: result.serviceName,
        },
      }).catch((err) => {
        console.warn('[carriers/labels] confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
        return { queued: false, provider: inferStoreProviderFromExternalId(externalOrderId), error: err instanceof Error ? err.message : String(err) };
      });

      let marketplaceShipmentConfirmed: boolean | null = null;
      let marketplaceShipmentConfirmError: string | null = null;
      let marketplaceCredentialSource: string | null = null;
      let marketplaceStoreAccountId: number | null = null;
      if (confirmation.provider === 'walmart') {
        try {
          const confirmed = await confirmWalmartSourceOrderAfterLabelSql(sql, {
            orderId,
            shipmentId: persisted.localShipmentId,
            purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
            rawOrder,
            carrierName: result.carrierName ?? result.carrierCode ?? 'Other',
            trackingNumber: result.trackingNumber,
            trackingUrl: walmartTrackingUrl(result.carrierName ?? result.carrierCode ?? '', result.trackingNumber),
            shipDate: new Date().toISOString().slice(0, 10),
            fallbackCreds: {},
          });
          marketplaceShipmentConfirmed = confirmed.confirmed;
          marketplaceShipmentConfirmError = confirmed.error;
          marketplaceCredentialSource = confirmed.credentialSource;
          marketplaceStoreAccountId = confirmed.storeAccountId;
        } catch (err) {
          marketplaceShipmentConfirmed = false;
          marketplaceShipmentConfirmError = err instanceof Error ? err.message : String(err);
          console.warn('[carriers/labels] walmart source confirmation after Shipp label failed:', marketplaceShipmentConfirmError);
          await markWalmartConfirmationAttemptSql(sql, {
            orderId,
            shipmentId: persisted.localShipmentId,
            provider: 'walmart',
            succeeded: false,
            error: marketplaceShipmentConfirmError,
          }).catch((markErr) => {
            console.warn('[carriers/labels] walmart source confirmation status update failed:', markErr instanceof Error ? markErr.message : markErr);
          });
        }
      }

      res.status(200).json({
        ok: true,
        provider: providerKey,
        carrierLabel: label,
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        labelFormat: result.labelUrl?.startsWith('data:application/pdf') ? 'PDF' : 'IMAGE',
        cost: result.cost,
        currency: result.currency,
        shipmentId: persisted.localShipmentId,
        localShipmentId: persisted.localShipmentId,
        orderStatus: 'shipped',
        apiVersion: 'shipp',
        voided: false,
        meta: {
          externalOrderId,
          orderNumber,
          hasRawOrder: rawOrder != null,
          carrierAccountId,
          confirmationQueued: confirmation.queued,
          confirmationProvider: confirmation.provider,
          confirmationError: confirmation.error ?? null,
          marketplaceShipmentConfirmed,
          marketplaceShipmentConfirmError,
          marketplaceStoreAccountId,
          marketplaceCredentialSource,
          shippShipmentId: result.shipmentId,
          selectedServiceCode: result.serviceCode,
          connectorCapabilities,
        },
      });
      return;
    }

    if (providerKey === 'walmart_shipping') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for Walmart Shipping label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying Walmart Shipping label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create Walmart Shipping label for ${orderRow.order_status} order` });
        return;
      }

      const syntheticProviderId = Number.isFinite(Number(body?.shippingProviderId))
        ? Number(body.shippingProviderId)
        : SHIPP_PROVIDER_ID_OFFSET + carrierAccountId;
      const result = await buyLabelWalmartShipping(sql, creds, {
        body,
        orderRow,
        rawOrder,
        weightOz,
        dimsL,
        dimsW,
        dimsH,
      });
      const persisted = await persistWalmartShipment(sql, {
        body,
        provider: providerKey,
        carrierAccountId,
        syntheticProviderId,
        carrierLabel: label,
        result,
      });
      const confirmation = await enqueueShipmentConfirmationSql(sql, {
        orderId,
        shipmentId: persisted.localShipmentId,
        externalOrderId: result.context.externalOrderId,
        clientId: persisted.clientId,
        orderNumber: persisted.orderNumber,
        trackingNumber: result.trackingNumber,
        carrierCode: result.carrierCode,
        carrierProvider: 'walmart_shipping',
        carrierAccountId,
        confirmationProvider: 'walmart',
        shipDate: new Date().toISOString().slice(0, 10),
        payload: {
          storeAccountId: result.context.storeAccountId ?? undefined,
          purchaseOrderId: result.context.purchaseOrderId,
          rawOrder: result.context.rawOrder,
          carrierName: result.carrierName,
          trackingUrl: walmartTrackingUrl(result.carrierName, result.trackingNumber),
          serviceCode: result.serviceCode,
          serviceName: result.serviceName,
        },
      }).catch((err) => {
        console.warn('[carriers/labels] walmart confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
        return { queued: false, provider: 'walmart', error: err instanceof Error ? err.message : String(err) };
      });

      let walmartConfirmationCredentialSource: string | null = null;
      let walmartConfirmationStoreAccountId: number | null = result.context.storeAccountId ?? null;
      try {
        const confirmed = await confirmWalmartSourceOrderAfterLabelSql(sql, {
          orderId,
          shipmentId: persisted.localShipmentId,
          purchaseOrderId: result.context.purchaseOrderId,
          rawOrder: result.context.rawOrder,
          carrierName: result.carrierName,
          trackingNumber: result.trackingNumber,
          trackingUrl: walmartTrackingUrl(result.carrierName, result.trackingNumber),
          shipDate: new Date().toISOString().slice(0, 10),
          storeAccountId: result.context.storeAccountId,
          fallbackCreds: creds,
        });
        result.shipmentConfirmRaw = confirmed.raw;
        result.shipmentConfirmed = confirmed.confirmed;
        result.shipmentConfirmError = confirmed.error;
        walmartConfirmationCredentialSource = confirmed.credentialSource;
        walmartConfirmationStoreAccountId = confirmed.storeAccountId;
      } catch (err) {
        result.shipmentConfirmed = false;
        result.shipmentConfirmError = err instanceof Error ? err.message : String(err);
        console.warn('[carriers/labels] walmart immediate confirmation failed:', result.shipmentConfirmError);
        await markWalmartConfirmationAttemptSql(sql, {
          orderId,
          shipmentId: persisted.localShipmentId,
          provider: 'walmart',
          succeeded: false,
          error: result.shipmentConfirmError,
        }).catch((markErr) => {
          console.warn('[carriers/labels] walmart confirmation status update failed:', markErr instanceof Error ? markErr.message : markErr);
        });
      }

      res.status(200).json({
        ok: true,
        provider: providerKey,
        carrierLabel: label,
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        labelFormat: result.labelUrl?.startsWith('data:application/pdf') ? 'PDF' : null,
        cost: result.cost,
        currency: result.currency,
        shipmentId: persisted.localShipmentId,
        localShipmentId: persisted.localShipmentId,
        orderStatus: persisted.orderStatus,
        apiVersion: 'walmart_shipping',
        voided: false,
        meta: {
          externalOrderId: result.context.externalOrderId,
          orderNumber: result.context.orderNumber,
          purchaseOrderId: result.context.purchaseOrderId,
          purchaseOrderSource: result.context.purchaseOrderSource,
          marketplaceStoreAccountId: walmartConfirmationStoreAccountId,
          marketplaceCredentialSource: walmartConfirmationCredentialSource,
          hasRawOrder: result.context.rawOrder != null,
          carrierAccountId,
          confirmationQueued: confirmation.queued,
          confirmationProvider: confirmation.provider,
          confirmationError: confirmation.error ?? null,
          selectedServiceCode: result.serviceCode,
          walmartTrackingNumber: result.trackingNumber,
          labelPdfReturned: Boolean(result.labelUrl),
          walmartShipmentConfirmed: result.shipmentConfirmed,
          walmartShipmentConfirmError: result.shipmentConfirmError,
          connectorCapabilities,
        },
      });
      return;
    }

    const shipTo = resolveShipTo(body, rawOrder);
    const shipFrom = resolveShipFrom(creds);

    let result: any = null;
    let directServiceCode: string | null = null;
    if (providerKey === 'ups') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for UPS label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying UPS label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create UPS label for ${orderRow.order_status} order` });
        return;
      }
      // UPS service code default: "03" = Ground. Caller can pass
      // serviceCode like "01" (Next Day Air), "02" (2nd Day Air), etc.
      directServiceCode = String(body?.serviceCode ?? '03');
      result = await createCarrierLabel('ups', {
        credentials: creds,
        weightOz, dimsL, dimsW, dimsH, serviceCode: directServiceCode, shipFrom, shipTo,
      });
    } else if (providerKey === 'easypost') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for EasyPost label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying EasyPost label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create EasyPost label for ${orderRow.order_status} order` });
        return;
      }
      directServiceCode = String(body?.serviceCode ?? 'USPS Priority');
      result = await createCarrierLabel('easypost', {
        credentials: creds,
        weightOz, dimsL, dimsW, dimsH, serviceCode: directServiceCode, shipFrom, shipTo,
      });
    } else {
      res.status(400).json({
        error: `Label purchase for "${provider}" is not implemented yet. Currently supported: ups, easypost, shipp.`,
      });
      return;
    }

    const selectedRateJson = {
      carrierCode: providerKey,
      serviceCode: directServiceCode,
      serviceName: directServiceCode,
      carrierNickname: label ?? providerKey,
      providerAccountNickname: label ?? providerKey,
      providerAccountId: carrierAccountId,
      shippingProviderId: carrierAccountId,
      provider: providerKey,
      source: 'carrier_accounts',
      amount: result.cost,
      cost: result.cost,
      shipmentCost: result.cost,
      otherCost: 0,
      raw: result.raw,
    };
    const persisted = await persistDirectCarrierLabel(sql, {
      orderId,
      carrierProvider: providerKey === 'ups' ? 'UPS' : 'EasyPost',
      carrierAccountId,
      carrierLabel: label ?? providerKey,
      carrierCode: providerKey,
      serviceCode: directServiceCode,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      labelFormat: providerKey === 'ups' ? 'gif' : 'pdf',
      cost: result.cost,
      currency: result.currency,
      weightOz,
      dimsL,
      dimsW,
      dimsH,
      selectedRateJson,
      labelProvider: carrierAccountId,
      labelShipmentId: null,
      selectedPid: carrierAccountId,
      selectedPackageId: body?.customPackageId != null ? String(body.customPackageId) : null,
      source: providerKey,
    });
    const confirmation = await enqueueShipmentConfirmationSql(sql, {
      orderId,
      shipmentId: persisted.localShipmentId,
      externalOrderId,
      clientId: persisted.clientId,
      orderNumber: persisted.orderNumber,
      trackingNumber: result.trackingNumber,
      carrierCode: providerKey,
      carrierProvider: providerKey,
      carrierAccountId,
      shipDate: new Date().toISOString().slice(0, 10),
      payload: {
        purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
        rawOrder,
        carrierName: providerKey === 'ups' ? 'UPS' : 'EasyPost',
        trackingUrl: null,
        serviceCode: directServiceCode,
      },
    }).catch((err) => {
      console.warn('[carriers/labels] confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
      return { queued: false, provider: inferStoreProviderFromExternalId(externalOrderId), error: err instanceof Error ? err.message : String(err) };
    });

    res.status(200).json({
      ok: true,
      provider,
      carrierLabel: label,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      labelFormat: provider === 'ups' ? 'GIF' : 'PDF',
      cost: result.cost,
      currency: result.currency,
      shipmentId: persisted.localShipmentId,
      localShipmentId: persisted.localShipmentId,
      orderStatus: persisted.orderStatus,
      meta: {
        externalOrderId,
        hasRawOrder: rawOrder != null,
        carrierAccountId,
        carrierShipmentId: result.shipmentId ?? null,
        confirmationQueued: confirmation.queued,
        confirmationProvider: confirmation.provider,
        confirmationError: confirmation.error ?? null,
        connectorCapabilities,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carriers/labels]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
