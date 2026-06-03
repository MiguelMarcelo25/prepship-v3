// @ts-nocheck
// Vercel serverless function: rate-shopping for direct carrier_accounts rows.
//
// Single endpoint. Loads a saved row, dispatches to the correct per-provider
// rate quoter. As real carrier integrations get written (UPS, USPS, FedEx,
// DHL, etc.) they slot in as additional case branches below — the FE keeps
// calling this one URL.
//
// Today only the 'simulator' provider returns synthetic rates so the full
// pipeline (save → verify → fetch rates → render) can be exercised without
// needing real API credentials. Every other carrier returns a clean
// "rate quoter not yet implemented" response.
//
// Auth: Supabase JWT.
// POST body: { carrierAccountId, weightOz, fromZip?, toZip?, dimsL?, dimsW?, dimsH? }
// Response (success):
//   { ok: true, provider, rates: Array<{ service, cost, days, currency }>,
//     simulated: boolean, fetchedAt: ISO }

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../src/lib/auth/verify-supabase-jwt.js';
import { corsHeaders } from '../../src/lib/http/cors.js';
import { sendInternalServerError, logServerError } from '../_lib/safe-error.js';
import { normalizeShippingOptions } from '../../src/lib/shipping-options.js';
import { filterEligibleShippingServices } from '../../src/lib/shipping-service-eligibility.js';

// Keep this endpoint self-contained for Vercel cold starts. Importing the
// connector registry here pulls a wider src/ tree into the serverless bundle;
// other carrier functions already hit FUNCTION_INVOCATION_FAILED from similar
// shared-helper paths. The canonical registry is still guarded elsewhere; this
// map only exposes response metadata for the direct rate preview endpoint.
const DIRECT_CARRIER_CONNECTOR_CAPABILITIES: Record<string, string[]> = {
  shipstation: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
  shipp: ['rates.quote', 'labels.create', 'tracking.read', 'credentials.verify'],
  easypost: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify', 'webhooks.receive'],
  easy_post: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify', 'webhooks.receive'],
  walmart_shipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  walmartshipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  ups: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  fedex: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  usps: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  shipengine: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  ebay_shipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  amazon_shipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
};

function directCarrierConnectorCapabilities(provider: string): string[] {
  return DIRECT_CARRIER_CONNECTOR_CAPABILITIES[provider] ?? [];
}

const DIRECT_RATE_PROVIDER_ALIASES: Record<string, string> = {
  shipstation: 'shipstation',
  shipp: 'shipp',
  easypost: 'easypost',
  easy_post: 'easypost',
  walmart_shipping: 'walmart_shipping',
  walmartshipping: 'walmart_shipping',
  ups: 'ups',
  fedex: 'fedex',
  usps: 'usps',
  shipengine: 'shipengine',
  ebay_shipping: 'ebay_shipping',
  ebayshipping: 'ebay_shipping',
  amazon_shipping: 'amazon_shipping',
  amazonshipping: 'amazon_shipping',
};

function normalizeDirectRateProvider(provider: string | null | undefined): string | null {
  const key = String(provider ?? '').trim().toLowerCase();
  return DIRECT_RATE_PROVIDER_ALIASES[key] ?? null;
}

function directRateServiceDescriptor(rate: Record<string, unknown>, provider: string) {
  return {
    provider,
    carrierCode: rate.carrierCode ?? rate.carrierType ?? rate.carrierName ?? provider,
    carrierName: rate.carrierName ?? rate.carrierType ?? null,
    serviceCode: rate.serviceCode ?? rate.service_code ?? rate.service,
    serviceName: rate.serviceName ?? rate.service_type ?? rate.service,
    serviceType: rate.service_type ?? rate.service,
  };
}

function filterDirectCarrierRatesForEligibility(
  rates: Array<Record<string, unknown>>,
  provider: string,
  context: Record<string, unknown> | null,
  body: Record<string, unknown>,
) {
  return filterEligibleShippingServices(
    rates,
    {
      clientId: body.clientId ?? context?.client_id ?? null,
      clientName: body.clientName ?? context?.client_name ?? null,
      storeId: body.storeId ?? context?.store_id ?? null,
    },
    (rate) => directRateServiceDescriptor(rate, provider),
    normalizeShippingOptions(body),
  );
}

// Hardening: cap each upstream carrier rate quote so a hung provider
// (UPS / Walmart / ShipStation / etc.) returns a clean "timed out" error
// instead of letting the whole Vercel function run to the platform limit and
// crash with FUNCTION_INVOCATION_FAILED. The underlying request can't be truly
// cancelled without per-connector AbortSignal support, but the function always
// responds. PS-071 then renders the clean error as "Rate unavailable · Retry".
const RATE_QUOTE_TIMEOUT_MS = 20_000;
function withRateTimeout<T>(promise: Promise<T>, provider: string, ms = RATE_QUOTE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Rate request to ${provider} timed out after ${ms}ms`)),
      ms,
    );
  });
  const wrapped = Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); return value; },
    (error) => { clearTimeout(timer); throw error; },
  );
  // If the timeout wins the race, the underlying request may still reject
  // later — swallow that so it can't surface as an unhandled rejection (which
  // would itself crash the function).
  wrapped.catch(() => {});
  return Promise.race([wrapped, timeout]);
}

async function quoteCarrierRates(provider: string | null | undefined, input: Record<string, unknown>) {
  const normalized = normalizeDirectRateProvider(provider);
  if (!normalized) {
    throw new Error(`No direct carrier rate connector registered for ${provider ?? '(missing)'}`);
  }

  let connector: any;
  if (normalized === 'shipstation') {
    connector = (await import('../../src/connectors/carrier/shipstation.js')).shipStationCarrierConnector;
  } else if (normalized === 'shipp') {
    connector = (await import('../../src/connectors/carrier/shipp.js')).shippCarrierConnector;
  } else if (normalized === 'easypost') {
    connector = (await import('../../src/connectors/carrier/easypost.js')).easyPostCarrierConnector;
  } else if (normalized === 'walmart_shipping') {
    connector = (await import('../../src/connectors/carrier/walmart-shipping.js')).walmartShippingCarrierConnector;
  } else if (normalized === 'ups') {
    connector = (await import('../../src/connectors/carrier/ups.js')).upsCarrierConnector;
  } else if (normalized === 'fedex') {
    connector = (await import('../../src/connectors/carrier/fedex.js')).fedexCarrierConnector;
  } else if (normalized === 'usps') {
    connector = (await import('../../src/connectors/carrier/usps.js')).uspsCarrierConnector;
  } else if (normalized === 'shipengine') {
    connector = (await import('../../src/connectors/carrier/shipengine.js')).shipEngineCarrierConnector;
  } else if (normalized === 'ebay_shipping') {
    connector = (await import('../../src/connectors/carrier/ebay-shipping.js')).ebayShippingCarrierConnector;
  } else if (normalized === 'amazon_shipping') {
    connector = (await import('../../src/connectors/carrier/amazon-shipping.js')).amazonShippingCarrierConnector;
  }

  if (!connector?.getRates) {
    throw new Error(`No direct carrier rate connector registered for ${provider ?? '(missing)'}`);
  }

  return {
    provider: normalized,
    rates: await withRateTimeout(connector.getRates(input), normalized),
  };
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

function ebayOrderIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('ebay-') ? trimmed.slice('ebay-'.length) : trimmed;
}

// Synthetic rates for the simulator provider. Three service tiers, prices
// scale with weight + a small ZIP-based jitter so re-running the same
// request returns the same rates (deterministic), but two different
// shipments produce different prices.
function simulatorRates(input: {
  weightOz: number;
  toZip?: string;
}): Array<{ service: string; cost: number; days: number; currency: string }> {
  const lb = Math.max(0.5, input.weightOz / 16);
  // Cheap ZIP-derived jitter so different ZIPs feel different.
  const zipJitter = (() => {
    if (!input.toZip) return 0;
    let h = 0;
    for (const ch of String(input.toZip)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return ((h % 100) - 50) / 100; // -0.5..+0.49
  })();
  const round = (n: number) => Math.round(n * 100) / 100;
  return [
    { service: 'Demo Standard', cost: round(4.95 + lb * 0.85 + zipJitter * 0.4), days: 5, currency: 'USD' },
    { service: 'Demo Priority', cost: round(8.95 + lb * 1.25 + zipJitter * 0.7), days: 2, currency: 'USD' },
    { service: 'Demo Express', cost: round(24.5 + lb * 2.1 + zipJitter * 1.2), days: 1, currency: 'USD' },
  ];
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'POST, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  // verifySupabaseJwt does a remote JWKS fetch and can THROW on a network blip.
  // It runs BEFORE the main try/catch below, so an unguarded throw here crashed
  // the function as FUNCTION_INVOCATION_FAILED. Guard it -> clean 401/503.
  let verified;
  try {
    verified = await verifySupabaseJwt(token);
  } catch (authErr) {
    logServerError('carriers/rates:auth', authErr);
    res.status(503).json({ ok: false, error: 'Auth verification temporarily unavailable' });
    return;
  }
  if (!verified.ok) {
    console.warn('[direct-carrier-rates] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }

  // readBody can reject on a malformed/aborted request stream; guard it (also
  // pre-try) so a bad body is a clean 400, never a function crash.
  let body: Record<string, unknown>;
  try {
    body = (await readBody(req)) as Record<string, unknown>;
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    return;
  }
  const carrierAccountId = body?.carrierAccountId != null ? Number(body.carrierAccountId) : null;
  const storeAccountId = body?.storeAccountId != null ? Number(body.storeAccountId) : null;
  const hasCarrierAccountId = carrierAccountId != null && Number.isFinite(carrierAccountId) && carrierAccountId > 0;
  const hasStoreAccountId = storeAccountId != null && Number.isFinite(storeAccountId) && storeAccountId > 0;
  if (!hasCarrierAccountId && !hasStoreAccountId) {
    res.status(400).json({ error: 'carrierAccountId or storeAccountId is required' });
    return;
  }

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  try {
    const useStoreTable = hasStoreAccountId;
    const lookupId = useStoreTable ? storeAccountId! : carrierAccountId!;
    let orderContext: Record<string, unknown> | null = null;
    const orderId = Number(body?.orderId);
    if (Number.isFinite(orderId) && orderId > 0) {
      const orderRows = await sql<Array<{ client_id: number | null; store_id: number | null; client_name: string | null }>>`
        SELECT o.client_id, o.store_id, c.name as client_name
        FROM orders o
        LEFT JOIN clients c ON c.id = o.client_id
        WHERE o.id = ${Math.trunc(orderId)}
        LIMIT 1
      `;
      orderContext = orderRows[0] ?? null;
    }
    const rows = useStoreTable
      ? await sql<Array<{ provider: string; credentials: unknown }>>`
          SELECT provider, credentials FROM store_accounts WHERE id = ${lookupId} LIMIT 1
        `
      : await sql<Array<{ provider: string; credentials: unknown }>>`
          SELECT provider, credentials FROM carrier_accounts WHERE id = ${lookupId} LIMIT 1
        `;
    const row = rows[0];
    if (!row) {
      res.status(404).json({
        error: `${useStoreTable ? 'store_accounts' : 'carrier_accounts'} row #${lookupId} not found`,
      });
      return;
    }

    const requestedProvider = String(body?.provider ?? '').toLowerCase();
    let provider = String(row.provider).toLowerCase();
    if (useStoreTable && provider === 'ebay' && requestedProvider === 'ebay_shipping') {
      provider = 'ebay_shipping';
    }
    if (useStoreTable && provider === 'walmart' && requestedProvider === 'walmart_shipping') {
      provider = 'walmart_shipping';
    }
    provider = normalizeDirectRateProvider(provider) ?? provider;
    const connectorCapabilities = directCarrierConnectorCapabilities(provider);
    const creds = (row.credentials && typeof row.credentials === 'object'
      ? (row.credentials as Record<string, unknown>)
      : {});
    const weightOz = typeof body?.weightOz === 'number' && body.weightOz > 0
      ? body.weightOz
      : 16; // 1 lb default — enough to produce believable demo rates
    const toZip = typeof body?.toZip === 'string' && body.toZip ? body.toZip : undefined;
    const fromZip = typeof body?.fromZip === 'string' && body.fromZip ? body.fromZip : undefined;
    const dimsL = typeof body?.dimsL === 'number' && body.dimsL > 0 ? body.dimsL : undefined;
    const dimsW = typeof body?.dimsW === 'number' && body.dimsW > 0 ? body.dimsW : undefined;
    const dimsH = typeof body?.dimsH === 'number' && body.dimsH > 0 ? body.dimsH : undefined;
    const shippingOptions = normalizeShippingOptions(body);

    if (provider === 'simulator') {
      const rates = simulatorRates({ weightOz, toZip });
        res.status(200).json({
          ok: true,
          provider,
          simulated: true,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { connectorCapabilities },
        });
      return;
    }

    if (provider === 'ups') {
      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shippingOptions,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (provider === 'fedex') {
      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shippingOptions,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (provider === 'usps') {
      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shippingOptions,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (provider === 'shipengine') {
      const externalOrderId =
        typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;
      const orderNumber =
        typeof body?.orderNumber === 'string' ? body.orderNumber : null;
      const lookupA = orderNumber ?? '';
      const lookupB = externalOrderId ?? '';

      let rawOrder: any = null;
      if (lookupA || lookupB) {
        try {
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM orders
            WHERE order_number IN (${lookupA}, ${lookupB})
              OR external_order_id IN (${lookupA}, ${lookupB})
            ORDER BY id DESC
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal; quoter can still rate from ZIP fallback */ }
      }
      if (!rawOrder && externalOrderId) {
        const provIdMatch = externalOrderId.match(/^([a-z_]+)-(.+)$/);
        if (provIdMatch) {
          const [, srcProvider, extId] = provIdMatch;
          try {
            const orderRows = await sql<Array<{ raw: any }>>`
              SELECT raw FROM store_orders
              WHERE provider = ${srcProvider} AND external_order_id = ${extId}
              LIMIT 1
            `;
            rawOrder = orderRows[0]?.raw ?? null;
          } catch { /* non-fatal */ }
        }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shipFrom: body?.shipFrom,
          shippingOptions,
          rawOrder,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, orderNumber, hasRawOrder: rawOrder != null, rateCount: rates.length, connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { externalOrderId, orderNumber, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'walmart_shipping') {
      // Real Walmart "Ship With Walmart" Shipping Estimates endpoint:
      // POST /v3/shipping/labels/shipping-estimates (different from the
      // earlier guesses — this is the actual documented path).
      // Build the request from the order's saved raw payload + the dims
      // / weight the Rate Browser passes through.
      let purchaseOrderId: string | null = null;
      let purchaseOrderSource = 'none';
      let externalOrderId = typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;
      let orderNumber = typeof body?.orderNumber === 'string' ? body.orderNumber : null;
      const orderId = typeof body?.orderId === 'number' && Number.isFinite(body.orderId)
        ? Math.trunc(body.orderId)
        : null;
      if (orderId) {
        try {
          const localRows = await sql<Array<{ external_order_id: string | null; order_number: string | null }>>`
            SELECT external_order_id, order_number
            FROM orders
            WHERE id = ${orderId}
            LIMIT 1
          `;
          if (localRows[0]) {
            externalOrderId = externalOrderId ?? localRows[0].external_order_id ?? null;
            orderNumber = orderNumber ?? localRows[0].order_number ?? null;
          }
        } catch { /* non-fatal; fall back to request-provided ids */ }
      }
      if (typeof body?.purchaseOrderId === 'string' && body.purchaseOrderId) {
        purchaseOrderId = body.purchaseOrderId;
        purchaseOrderSource = 'body.purchaseOrderId';
      } else if (externalOrderId && externalOrderId.startsWith('walmart-')) {
        purchaseOrderId = externalOrderId.slice('walmart-'.length);
        purchaseOrderSource = 'body.externalOrderId';
      }

      // Fetch the saved raw payload so we can build boxItems + toAddress.
      // Walmart's visible order number is often customerOrderId (starts with
      // 2000...), while the shipping API requires purchaseOrderId. Resolve both.
      let rawOrder: any = null;
      const lookupA = purchaseOrderId ?? '';
      const lookupB = externalOrderId?.startsWith('walmart-')
        ? externalOrderId.slice('walmart-'.length)
        : externalOrderId ?? '';
      const lookupC = orderNumber ?? '';
      if (lookupA || lookupB || lookupC) {
        try {
          const orderRows = await sql<Array<{ external_order_id: string; raw: any }>>`
            SELECT external_order_id, raw FROM store_orders
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
            purchaseOrderSource = purchaseOrderSource === 'none'
              ? 'store_orders lookup'
              : purchaseOrderSource;
            rawOrder = orderRows[0].raw ?? null;
          }
        } catch { /* non-fatal */ }
      }

      // Fix 4 (2026-05-12): if store_orders had no match, try resolving
      // the purchaseOrderId by calling Walmart's Marketplace API directly
      // with the customer order number. This rescues ShipStation-pulled
      // Walmart orders (no `store_orders` row, but we still have the
      // customerOrderNumber on `orders.order_number`). One-shot lookup,
      // any failure silently falls through to the existing error path.
      if (!purchaseOrderId) {
        const candidateCustomerOrderId = (() => {
          if (lookupC && /^\d{8,}$/.test(lookupC.trim())) return lookupC.trim();
          if (lookupB && /^\d{8,}$/.test(lookupB.trim())) return lookupB.trim();
          if (lookupA && /^\d{8,}$/.test(lookupA.trim())) return lookupA.trim();
          return null;
        })();
        if (candidateCustomerOrderId) {
          const { lookupWalmartOrderByCustomerOrderId } = await import('../../src/connectors/store/walmart.js');
          const looked = await lookupWalmartOrderByCustomerOrderId(creds, candidateCustomerOrderId);
          if (looked) {
            purchaseOrderId = looked.purchaseOrderId;
            purchaseOrderSource = 'walmart_marketplace_api';
            rawOrder = looked.rawOrder ?? rawOrder;
          }
        }
      }

      // Fix 1 (2026-05-12): the "most-recent walmart row" fallback is
      // ONLY for the Settings-page demo button (no real order context).
      // Real order rate-browsing (orderId present) MUST NOT silently
      // borrow a different order's purchaseOrderId — that produced the
      // "rate browser shows zero rates for the wrong reason" bug we're
      // fixing here. When orderId is set and we got this far without a
      // match, fall through to the clean "could not resolve" error so
      // the operator sees what's actually wrong.
      if (!purchaseOrderId && !orderId) {
        // Fallback: most-recent walmart row in store_orders (Settings demo).
        try {
          const recent = await sql<Array<{ external_order_id: string; raw: any }>>`
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

      if (purchaseOrderId && !rawOrder) {
        try {
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal — function will fail with a clear error */ }
      }

      let shipFromForRates = body?.shipFrom;
      if (!shipFromForRates || typeof shipFromForRates !== 'object') {
        try {
          const locationRows = await sql<Array<{
            name: string | null;
            street1: string | null;
            street2: string | null;
            city: string | null;
            state: string | null;
            postal_code: string | null;
            country: string | null;
            phone: string | null;
          }>>`
            SELECT name, street1, street2, city, state, postal_code, country, phone
            FROM locations
            ORDER BY is_default DESC NULLS LAST, id ASC
            LIMIT 1
          `;
          const loc = locationRows[0];
          if (loc) {
            shipFromForRates = {
              name: loc.name,
              street1: loc.street1,
              street2: loc.street2,
              city: loc.city,
              state: loc.state,
              postalCode: loc.postal_code,
              country: loc.country,
              phone: loc.phone,
            };
          }
        } catch { /* non-fatal; connector has a fallback */ }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          purchaseOrderId,
          dimsL,
          dimsW,
          dimsH,
          fromZip,
          shipFrom: shipFromForRates,
          shippingOptions,
          rawOrder,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        // Fix 2 (2026-05-12): Walmart sometimes returns 200 OK with an
        // empty rate array — e.g. the order isn't eligible for Walmart
        // Shipping, the dims/weight fall outside any sponsored carrier's
        // box, or the seller isn't enrolled. Silent success hides the
        // reason and the operator just sees a blank Rate Browser. Flip
        // to ok=false with a clear hint so the FE error overlay fires.
        if (!Array.isArray(rates) || rates.length === 0) {
          res.status(200).json({
            ok: false,
            provider,
            error:
              'Walmart returned 0 rates for this order. The order may not be eligible for Walmart Shipping, or the box dimensions/weight fall outside any sponsored carrier limit. Confirm Ship With Walmart is enabled in Seller Center and try a different package size.',
            meta: { orderId, externalOrderId, orderNumber, purchaseOrderId, purchaseOrderSource, hasRawOrder: rawOrder != null, rateCount: 0 },
          });
          return;
        }
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { orderId, externalOrderId, orderNumber, purchaseOrderId, purchaseOrderSource, hasRawOrder: rawOrder != null, rateCount: rates.length },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { orderId, externalOrderId, orderNumber, purchaseOrderId, purchaseOrderSource, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'amazon_shipping') {
      // Amazon Buy Shipping (SP-API Shipping v2). Works for any shipment —
      // doesn't require the order to be from Amazon — so the Settings demo
      // button is supported. When the order IS from Amazon we pass the
      // amazonOrderId for accurate Buy Shipping pricing under channelType
      // AMAZON; otherwise channelType EXTERNAL with placeholder shipTo.
      const externalOrderId =
        typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;

      // If the caller passed an Amazon externalOrderId, fetch the saved
      // raw payload so shipTo comes from the real customer address. For
      // EXTERNAL channel calls this is fine to leave null — the quoter
      // falls back to a placeholder Oakland CA address.
      let rawOrder: any = null;
      if (externalOrderId && externalOrderId.startsWith('amazon-')) {
        try {
          const amzId = externalOrderId.slice('amazon-'.length);
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = 'amazon' AND external_order_id = ${amzId}
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal */ }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH,
          shippingOptions,
          rawOrder,
          externalOrderId,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, hasRawOrder: rawOrder != null, rateCount: rates.length, connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false, provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { externalOrderId, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'ebay_shipping') {
      const externalOrderId =
        typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;
      const orderNumber =
        typeof body?.orderNumber === 'string' ? body.orderNumber : null;
      const ebayOrderId = ebayOrderIdFrom(orderNumber) ?? ebayOrderIdFrom(externalOrderId);

      let rawOrder: any = null;
      const lookupA = ebayOrderId ?? '';
      const lookupB = orderNumber ?? '';
      const lookupC = externalOrderId ?? '';
      if (lookupA || lookupB || lookupC) {
        try {
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = 'ebay'
              AND (
                external_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
                OR customer_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
              )
            ORDER BY last_fetched_at DESC NULLS LAST
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal; quoter will produce a clear error */ }
      }
      if (!rawOrder && (lookupA || lookupB || lookupC)) {
        try {
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM orders
            WHERE order_number IN (${lookupA}, ${lookupB}, ${lookupC})
              OR external_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
            ORDER BY id DESC
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal; quoter will produce a clear error */ }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          externalOrderId,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shipFrom: body?.shipFrom,
          shippingOptions,
          rawOrder,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, orderNumber, ebayOrderId, hasRawOrder: rawOrder != null, rateCount: rates.length, connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { externalOrderId, orderNumber, ebayOrderId, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'easypost') {
      // EasyPost is a multi-carrier aggregator — one API call returns
      // rates from every carrier the user has connected to their EasyPost
      // dashboard (UPS, USPS, FedEx, DHL, etc.). Works for any order;
      // no marketplace-specific data required.
      const externalOrderId =
        typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;

      // Look up the saved order to extract the customer ship-to address
      // when this is a real order from any of our marketplace pullers.
      // Settings demo calls (no externalOrderId) fall back to placeholder
      // address inside the quoter.
      let rawOrder: any = null;
      if (externalOrderId) {
        const provIdMatch = externalOrderId.match(/^([a-z_]+)-(.+)$/);
        if (provIdMatch) {
          const [, srcProvider, extId] = provIdMatch;
          try {
            const orderRows = await sql<Array<{ raw: any }>>`
              SELECT raw FROM store_orders
              WHERE provider = ${srcProvider} AND external_order_id = ${extId}
              LIMIT 1
            `;
            rawOrder = orderRows[0]?.raw ?? null;
          } catch { /* non-fatal */ }
        }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH, shippingOptions, rawOrder,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, hasRawOrder: rawOrder != null, rateCount: rates.length, connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false, provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { externalOrderId, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'shipp') {
      // Shipp.to returns multi-carrier quotes from its private quote API.
      // This branch is quote-only; label creation is intentionally not called
      // here because POST /api/shipping/label/create purchases postage.
      const externalOrderId =
        typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;
      const orderNumber =
        typeof body?.orderNumber === 'string' ? body.orderNumber : null;
      const orderId = body?.orderId != null && Number.isFinite(Number(body.orderId))
        ? Math.trunc(Number(body.orderId))
        : null;

      let rawOrder: any = null;
      if (orderId) {
        try {
          const localRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM orders
            WHERE id = ${orderId}
            LIMIT 1
          `;
          rawOrder = localRows[0]?.raw ?? null;
        } catch { /* non-fatal; quoter can still rate from ZIP fallback */ }
      }

      if (!rawOrder && externalOrderId) {
        const provIdMatch = externalOrderId.match(/^([a-z_]+)-(.+)$/);
        if (provIdMatch) {
          const [, srcProvider, extId] = provIdMatch;
          try {
            const orderRows = await sql<Array<{ raw: any }>>`
              SELECT raw FROM store_orders
              WHERE provider = ${srcProvider} AND external_order_id = ${extId}
              LIMIT 1
            `;
            rawOrder = orderRows[0]?.raw ?? null;
          } catch { /* non-fatal */ }
        }
      }

      if (!rawOrder && (externalOrderId || orderNumber)) {
        const lookupA = orderNumber ?? '';
        const lookupB = externalOrderId ?? '';
        try {
          const orderRows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM orders
            WHERE order_number IN (${lookupA}, ${lookupB})
              OR external_order_id IN (${lookupA}, ${lookupB})
            ORDER BY id DESC
            LIMIT 1
          `;
          rawOrder = orderRows[0]?.raw ?? null;
        } catch { /* non-fatal; quoter can still rate from ZIP fallback */ }
      }

      try {
        const quoted = await quoteCarrierRates(provider, {
          credentials: creds,
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shipFrom: body?.shipFrom,
          shippingOptions,
          rawOrder,
          externalOrderId,
          orderNumber,
          toCity: typeof body?.toCity === 'string' ? body.toCity : undefined,
          toState: typeof body?.toState === 'string' ? body.toState : undefined,
          toAddress: typeof body?.toAddress === 'string' ? body.toAddress : undefined,
          toName: typeof body?.toName === 'string' ? body.toName : undefined,
          toCountry: typeof body?.toCountry === 'string' ? body.toCountry : undefined,
        });
        const rates = filterDirectCarrierRatesForEligibility(quoted.rates, provider, orderContext, body);
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { orderId, externalOrderId, orderNumber, hasRawOrder: rawOrder != null, rateCount: rates.length, connectorCapabilities },
        });
      } catch (err) {
        res.status(200).json({
          ok: false,
          provider,
          error: err instanceof Error ? err.message : String(err),
          meta: { orderId, externalOrderId, orderNumber, hasRawOrder: rawOrder != null },
        });
      }
      return;
    }

    if (provider === 'ehub') {
      res.status(200).json({
        ok: false,
        provider,
        error: 'eHub is available in Settings, but the live rate quoter still needs the eHub API base URL and rate endpoint contract from the eHub docs/API Explorer.',
        meta: {
          hasApiKey: typeof creds?.apiKey === 'string' && creds.apiKey.trim().length > 0,
          hasBaseUrl: typeof creds?.baseUrl === 'string' && creds.baseUrl.trim().length > 0,
        },
      });
      return;
    }

    // Real-carrier rate quoters slot in here as they get implemented:
    //   case 'dhl_express': return ratesFromDhl(creds, body)
    res.status(200).json({
      ok: false,
      provider,
      error: `Rate quoter for "${provider}" is not implemented yet.`,
    });
  } catch (err) {
    sendInternalServerError(res, 'carriers/rates', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
