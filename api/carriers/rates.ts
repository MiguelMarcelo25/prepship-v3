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

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';

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

// ───────── UPS Rating API (production) ─────────
// OAuth client_credentials → bearer access token → POST /api/rating/v2403/Shop
// Returns one rate per available service. "Shop" mode asks UPS to compute
// every service we're entitled to with this shipment; we map each one into
// our standard {service, cost, days, currency} shape.
const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Saver',
  '92': 'UPS Ground Saver',
  '93': 'UPS SurePost 1 lb or Greater',
};

async function getUpsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('UPS clientId and clientSecret are required');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`UPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('UPS OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromUps(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('UPS accountNumber is required');
  if (!input.toZip) throw new Error('toZip is required for UPS rate quotes');

  const token = await getUpsAccessToken(creds);

  // UPS expects weight in pounds; convert from ounces (round to 1 decimal).
  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  // Sensible ship-from default if the caller didn't pass one — same warehouse
  // ZIP the rest of the codebase uses (90248, the GWH location).
  const fromZip = (input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);

  const dims = (input.dimsL && input.dimsW && input.dimsH)
    ? {
        UnitOfMeasurement: { Code: 'IN' },
        Length: String(input.dimsL),
        Width: String(input.dimsW),
        Height: String(input.dimsH),
      }
    : undefined;

  const body = {
    RateRequest: {
      Request: {
        TransactionReference: { CustomerContext: 'prepship-rates' },
        RequestOption: 'Shop',
      },
      Shipment: {
        Shipper: {
          ShipperNumber: accountNumber,
          Address: { PostalCode: fromZip, CountryCode: 'US' },
        },
        ShipFrom: {
          Address: { PostalCode: fromZip, CountryCode: 'US' },
        },
        ShipTo: {
          Address: { PostalCode: toZip, CountryCode: 'US' },
        },
        Package: {
          PackagingType: { Code: '02' }, // 02 = customer-supplied package
          ...(dims ? { Dimensions: dims } : {}),
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(weightLb),
          },
        },
      },
    },
  };

  const res = await fetch('https://onlinetools.ups.com/api/rating/v2403/Shop', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      transId: `prepship-${Date.now().toString(36)}`,
      transactionSrc: 'prepship',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`UPS Rating ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as {
    RateResponse?: {
      RatedShipment?: Array<{
        Service?: { Code?: string; Description?: string };
        TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string };
        GuaranteedDelivery?: { BusinessDaysInTransit?: string };
      } | undefined> | { Service?: unknown } | undefined;
    };
  };
  // UPS returns either an array (multiple services) or a single object — normalize.
  const rated = data?.RateResponse?.RatedShipment;
  const list: any[] = Array.isArray(rated) ? rated : rated ? [rated] : [];

  return list.map((row: any) => {
    const code = String(row?.Service?.Code ?? '');
    const service = UPS_SERVICE_NAMES[code]
      ?? row?.Service?.Description
      ?? `UPS Service ${code || '?'}`;
    const cost = Number(row?.TotalCharges?.MonetaryValue ?? 0);
    const currency = String(row?.TotalCharges?.CurrencyCode ?? 'USD');
    const days = Number(row?.GuaranteedDelivery?.BusinessDaysInTransit ?? 0) || 0;
    return { service, cost, days, currency };
  }).filter((r) => r.cost > 0);
}

// ───────── FedEx Rate API ─────────
// OAuth client_credentials → Bearer token → POST /rate/v1/rates/quotes.
// "rateRequestType": ["LIST","ACCOUNT"] asks FedEx for both list-rate and
// the seller's account-discounted rate; we surface the lower of the two.
const FEDEX_SERVICE_NAMES: Record<string, string> = {
  FEDEX_GROUND: 'FedEx Ground',
  GROUND_HOME_DELIVERY: 'FedEx Home Delivery',
  FEDEX_2_DAY: 'FedEx 2Day',
  FEDEX_2_DAY_AM: 'FedEx 2Day AM',
  FEDEX_EXPRESS_SAVER: 'FedEx Express Saver',
  STANDARD_OVERNIGHT: 'FedEx Standard Overnight',
  PRIORITY_OVERNIGHT: 'FedEx Priority Overnight',
  FIRST_OVERNIGHT: 'FedEx First Overnight',
  FEDEX_FIRST_FREIGHT: 'FedEx First Freight',
  INTERNATIONAL_PRIORITY: 'FedEx International Priority',
  INTERNATIONAL_ECONOMY: 'FedEx International Economy',
  FEDEX_INTERNATIONAL_GROUND: 'FedEx International Ground',
  SMART_POST: 'FedEx SmartPost',
};

async function getFedexAccessToken(creds: Record<string, unknown>): Promise<string> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiSecret = String(creds?.apiSecret ?? '').trim();
  if (!apiKey || !apiSecret) {
    throw new Error('FedEx apiKey and apiSecret are required');
  }
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const tokenUrl = useSandbox
    ? 'https://apis-sandbox.fedex.com/oauth/token'
    : 'https://apis.fedex.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`FedEx OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('FedEx OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromFedex(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('FedEx accountNumber is required');
  if (!input.toZip) throw new Error('toZip is required for FedEx rate quotes');

  const token = await getFedexAccessToken(creds);
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const ratesUrl = useSandbox
    ? 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes'
    : 'https://apis.fedex.com/rate/v1/rates/quotes';

  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  const fromZip = (input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);

  const pkg: Record<string, unknown> = {
    weight: { units: 'LB', value: weightLb },
  };
  if (input.dimsL && input.dimsW && input.dimsH) {
    pkg.dimensions = {
      length: input.dimsL,
      width: input.dimsW,
      height: input.dimsH,
      units: 'IN',
    };
  }

  const body = {
    accountNumber: { value: accountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: { postalCode: fromZip, countryCode: 'US' } },
      recipient: { address: { postalCode: toZip, countryCode: 'US' } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT', 'LIST'],
      requestedPackageLineItems: [pkg],
    },
  };

  const res = await fetch(ratesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-locale': 'en_US',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`FedEx Rate ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as any;
  const replyDetails: any[] = Array.isArray(data?.output?.rateReplyDetails)
    ? data.output.rateReplyDetails
    : [];

  // Transit-time → business-days lookup. FedEx returns enums like TWO_DAYS.
  const transitDays: Record<string, number> = {
    ONE_DAY: 1, TWO_DAYS: 2, THREE_DAYS: 3, FOUR_DAYS: 4, FIVE_DAYS: 5,
    SIX_DAYS: 6, SEVEN_DAYS: 7, EIGHT_DAYS: 8, NINE_DAYS: 9, TEN_DAYS: 10,
    ELEVEN_DAYS: 11, TWELVE_DAYS: 12, THIRTEEN_DAYS: 13, FOURTEEN_DAYS: 14,
    FIFTEEN_DAYS: 15, SIXTEEN_DAYS: 16, SEVENTEEN_DAYS: 17, EIGHTEEN_DAYS: 18,
  };

  return replyDetails
    .map((d: any) => {
      const code = String(d?.serviceType ?? '');
      const service = FEDEX_SERVICE_NAMES[code]
        ?? d?.serviceName
        ?? `FedEx ${code || '?'}`;
      // Pick the lower of ACCOUNT and LIST rates; fall back to whatever's there.
      const shipDetails = Array.isArray(d?.ratedShipmentDetails)
        ? d.ratedShipmentDetails
        : [];
      const charges = shipDetails
        .map((s: any) => Number(s?.totalNetCharge ?? s?.totalNetFedExCharge ?? 0))
        .filter((n: number) => n > 0)
        .sort((a: number, b: number) => a - b);
      const cost = charges[0] ?? 0;
      const currency = String(shipDetails[0]?.currency ?? 'USD');
      const transitKey = String(d?.operationalDetail?.transitTime ?? '');
      const days = transitDays[transitKey] ?? 0;
      return { service, cost, days, currency };
    })
    .filter((r) => r.cost > 0);
}

// ───────── USPS APIs v3 (Domestic Prices) ─────────
// USPS v3 doesn't return all service rates in one call — each mail class
// requires a separate request. We fan out to the most common domestic
// classes in parallel and merge.
const USPS_MAIL_CLASSES = [
  { class: 'USPS_GROUND_ADVANTAGE', label: 'USPS Ground Advantage' },
  { class: 'PRIORITY_MAIL',        label: 'USPS Priority Mail' },
  { class: 'PRIORITY_MAIL_EXPRESS', label: 'USPS Priority Mail Express' },
] as const;

async function getUspsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const consumerKey = String(creds?.consumerKey ?? '').trim();
  const consumerSecret = String(creds?.consumerSecret ?? '').trim();
  if (!consumerKey || !consumerSecret) {
    throw new Error('USPS consumerKey and consumerSecret are required');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: consumerKey,
    client_secret: consumerSecret,
  });
  const res = await fetch('https://apis.usps.com/oauth2/v3/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`USPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('USPS OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromUsps(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  if (!input.toZip) throw new Error('toZip is required for USPS rate quotes');

  const token = await getUspsAccessToken(creds);
  // USPS expects weight in pounds (decimal).
  const weightLb = Math.max(0.0625, Math.round((input.weightOz / 16) * 100) / 100);
  const fromZip = (input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);
  const length = input.dimsL ?? 6;
  const width = input.dimsW ?? 6;
  const height = input.dimsH ?? 4;

  // Fan out one request per mail class. Each succeeds or fails independently
  // (one class not eligible for the shipment shouldn't kill the whole quote).
  const results = await Promise.all(
    USPS_MAIL_CLASSES.map(async ({ class: mailClass, label }) => {
      try {
        const body = {
          originZIPCode: fromZip,
          destinationZIPCode: toZip,
          weight: weightLb,
          length, width, height,
          mailClass,
          processingCategory: 'MACHINABLE',
          rateIndicator: 'DR',
          destinationEntryFacilityType: 'NONE',
          priceType: 'COMMERCIAL',
        };
        const res = await fetch('https://apis.usps.com/prices/v3/base-rates/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as any;
        // USPS returns either a top-level `rates` array or a single rate object.
        const rates: any[] = Array.isArray(data?.rates) ? data.rates : (data?.rate ? [data.rate] : []);
        if (rates.length === 0) {
          const directPrice = Number(data?.totalBasePrice ?? data?.price ?? 0);
          if (directPrice > 0) {
            return { service: label, cost: directPrice, days: 0, currency: 'USD' };
          }
          return null;
        }
        const cheapest = rates
          .map((r: any) => Number(r?.price ?? r?.totalBasePrice ?? 0))
          .filter((n) => n > 0)
          .sort((a, b) => a - b)[0];
        if (!cheapest) return null;
        const days = Number(rates[0]?.deliveryDays ?? 0) || 0;
        return { service: label, cost: cheapest, days, currency: 'USD' };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

// ───────── Walmart Shipping Solutions / Sponsored Carrier ─────────
// Walmart exposes per-order shipping rates via the Marketplace API. There
// is no generic "rate-shop arbitrary package" endpoint; the rates returned
// reflect Walmart's negotiated pricing for a specific Walmart order. So
// this branch only works when the caller passes a Walmart purchaseOrderId
// (extracted from the orders.external_order_id we ingested as
// `walmart-<purchaseOrderId>`).
async function getWalmartAccessTokenForRates(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Walmart clientId and clientSecret are required');
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

// Fix 4 (2026-05-12): on-demand Walmart Marketplace lookup of a single
// order by its customer order number. The Shipping Estimates API requires
// `purchaseOrderId` (Walmart's short internal id) but our `orders` table
// often only has the customer-facing `customerOrderNumber` (the long
// 2000… number that the buyer sees) — especially when the order was
// ingested via ShipStation instead of via the direct Marketplace pull.
//
// Returns { purchaseOrderId, rawOrder } on success, or null on any failure
// (no match, network/auth error, missing creds, etc). Caller falls back
// to the existing error path so a flaky lookup never breaks the request.
async function lookupWalmartOrderByCustomerOrderId(
  creds: Record<string, unknown>,
  customerOrderId: string,
): Promise<{ purchaseOrderId: string; rawOrder: any } | null> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) return null;
  // Only attempt this for things that *look* like a Walmart customer
  // order number (long, all digits). Avoids burning OAuth tokens on
  // ShipStation order numbers, eBay ids, etc.
  const trimmed = customerOrderId.trim();
  if (!/^\d{8,}$/.test(trimmed)) return null;

  let token: string;
  try {
    token = await getWalmartAccessTokenForRates(creds);
  } catch (err) {
    console.warn('[carriers/rates] walmart token (lookup) failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const channelType = String(creds?.channelType ?? '').trim();
  const partnerId = String(creds?.partnerId ?? creds?.sellerId ?? '').trim();
  const correlationId = `prepship-lookup-${Date.now().toString(36)}`;
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': correlationId,
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_MARKET': 'us',
    Accept: 'application/json',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

  // Walmart's /v3/orders accepts `customerOrderId` as a query filter.
  // productInfo=true keeps the response rich enough to use as `rawOrder`
  // (item names, addresses, shipping info) so the Shipping Estimates
  // call right after has everything it needs to build the request body.
  const url = new URL('https://marketplace.walmartapis.com/v3/orders');
  url.searchParams.set('customerOrderId', trimmed);
  url.searchParams.set('productInfo', 'true');

  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      console.warn(`[carriers/rates] walmart /v3/orders lookup ${res.status}: ${t || res.statusText}`);
      return null;
    }
    const data = (await res.json()) as { list?: { elements?: { order?: unknown[] | unknown } } };
    const elementsRaw = (data?.list?.elements as { order?: unknown[] | unknown } | undefined)?.order;
    const elements = Array.isArray(elementsRaw)
      ? elementsRaw
      : elementsRaw
        ? [elementsRaw]
        : [];
    const match = elements.find((o) => {
      const recordedCust = (o as { customerOrderId?: unknown })?.customerOrderId;
      return recordedCust != null && String(recordedCust) === trimmed;
    }) ?? elements[0];
    if (!match) return null;
    const purchaseOrderId = (match as { purchaseOrderId?: unknown })?.purchaseOrderId;
    if (purchaseOrderId == null || String(purchaseOrderId).trim() === '') return null;
    return { purchaseOrderId: String(purchaseOrderId), rawOrder: match };
  } catch (err) {
    console.warn('[carriers/rates] walmart /v3/orders lookup error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Ship With Walmart "Shipping Estimates" rate quote.
// Real endpoint: POST /v3/shipping/labels/shipping-estimates
// Required body fields:
//   purchaseOrderId, boxDimensions, boxItems[{lineId, sku, quantity}],
//   fromAddress, toAddress, packageType (e.g. CUSTOMER_SUPPLIED).
// We pull the line-item shape from store_orders.raw (already has lineNumber +
// item.sku from the orders pull) so callers don't have to assemble it.
async function ratesFromWalmartShipping(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    purchaseOrderId?: string | null;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    fromZip?: string;
    shipFrom?: any;
    rawOrder?: any; // optional pre-fetched store_orders.raw payload
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  if (!input.purchaseOrderId) {
    throw new Error(
      'Walmart Shipping Solutions rates require a Walmart purchaseOrderId. Open the Rate Browser on a Walmart-pulled order (orders whose external id starts with walmart-).',
    );
  }
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error(
      'Walmart Shipping Estimates require box dimensions (length, width, height). Set them in the Rate Browser before fetching rates.',
    );
  }
  const token = await getWalmartAccessTokenForRates(creds);
  const correlationId = `prepship-${Date.now().toString(36)}`;
  const channelType = String(creds?.channelType ?? '').trim();
  const partnerId = String(creds?.partnerId ?? creds?.sellerId ?? '').trim();
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': correlationId,
    'WM_SVC.NAME': 'Walmart Marketplace',
    // WM_MARKET is required by some Walmart endpoints (orders, items, returns)
    // even though shipping-estimates docs are silent on it. Sending it is
    // harmless when not needed and rules out a missing-header 500.
    'WM_MARKET': 'us',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);

  // Build boxItems from the saved Walmart order's orderLines. Walmart
  // marketplace orders use `lineNumber` consistently — we use the same
  // name in our request body since Walmart's shipping APIs (labels,
  // shipping-estimates, ship-confirm) all key off lineNumber, not lineId.
  const orderLines = Array.isArray(input.rawOrder?.orderLines?.orderLine)
    ? input.rawOrder.orderLines.orderLine
    : [];
  const boxItems = orderLines.length > 0
    ? orderLines.map((line: any) => ({
        lineNumber: String(line?.lineNumber ?? '1'),
        sku: line?.item?.sku ?? '',
        quantity: Number(line?.orderLineQuantity?.amount ?? 1) || 1,
      }))
    : [{ lineNumber: '1', sku: 'UNKNOWN', quantity: 1 }];

  // Walmart's current Shipping Estimates API expects top-level request
  // fields. The important names are not the generic package names used by
  // other carriers: boxWeight/boxLength/boxWidth/boxHeight live inside
  // boxDimensions, and addresses use addressLines[] + state.
  //
  // Ship-from override: Walmart's WSS validates shipFromAddress against
  // the seller's REGISTERED shipping origin in Seller Center. Mismatches
  // return a generic 500. Hardcoded Carson CA only used when the user
  // hasn't pasted their real warehouse on the carrier_account form.
  const credShipFromZip = String(creds?.shipFromZip ?? '').replace(/[^0-9]/g, '').slice(0, 5);
  const shipFromInput = input.shipFrom && typeof input.shipFrom === 'object' ? input.shipFrom : {};
  const fromZip = credShipFromZip ||
    String(shipFromInput?.postalCode ?? input.fromZip ?? '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const fromAddress = {
    name: String(creds?.shipFromName ?? shipFromInput?.name ?? '').trim() || 'Seller',
    addressLines: [
      String(creds?.shipFromAddress1 ?? shipFromInput?.addressLine1 ?? shipFromInput?.street1 ?? '').trim() || 'Warehouse',
      String(creds?.shipFromAddress2 ?? shipFromInput?.addressLine2 ?? shipFromInput?.street2 ?? '').trim(),
    ].filter(Boolean),
    city: String(creds?.shipFromCity ?? shipFromInput?.city ?? '').trim() || 'Carson',
    state: String(creds?.shipFromState ?? shipFromInput?.state ?? '').trim() || 'CA',
    postalCode: fromZip,
    countryCode: String(shipFromInput?.country ?? 'US').trim() || 'US',
    phone: String(creds?.shipFromPhone ?? shipFromInput?.phone ?? '').trim() || '0000000000',
  };

  // Ship-to: Walmart's order payload uses address1/state/country —
  // translate to the shipping-estimates field names here.
  const addr = input.rawOrder?.shippingInfo?.postalAddress ?? {};
  const toAddress = {
    name: addr?.name ?? 'Buyer',
    addressLines: [addr?.address1 ?? '', addr?.address2 ?? ''].filter(Boolean),
    city: addr?.city ?? '',
    state: addr?.state ?? '',
    postalCode: addr?.postalCode ?? '',
    countryCode: addr?.country ?? 'US',
    phone: input.rawOrder?.shippingInfo?.phone ?? '0000000000',
  };

  const toWalmartIsoDate = (value: unknown, fallbackDays: number): string => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date(Date.now() + fallbackDays * 24 * 60 * 60 * 1000).toISOString();
  };

  const shipByDate = toWalmartIsoDate(input.rawOrder?.shippingInfo?.estimatedShipDate, 1);
  const deliverByDate = toWalmartIsoDate(input.rawOrder?.shippingInfo?.estimatedDeliveryDate, 5);

  const body = {
    purchaseOrderId: input.purchaseOrderId,
    boxDimensions: {
      boxWeight: weightLb,
      boxWeightUnit: 'LB',
      boxLength: input.dimsL,
      boxWidth: input.dimsW,
      boxHeight: input.dimsH,
      boxDimensionUnit: 'IN',
    },
    fromAddress,
    toAddress,
    packageType: 'CUSTOM_PACKAGE',
    shipByDate,
    deliverByDate,
    includeServicesNotMeetingDeliveryPromise: true,
    boxItems,
    addOns: false,
    hasBattery: false,
  };

  const url = 'https://marketplace.walmartapis.com/v3/shipping/labels/shipping-estimates';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    // Include a compact summary of what we actually sent — without
    // sensitive values — so a 400 from Walmart can be diagnosed against
    // their schema without a redeploy. The full body is too noisy to
    // include verbatim, so we show a fingerprint of the structure.
    let walmartMessage = t || res.statusText;
    try {
      const parsed = JSON.parse(t) as { errors?: Array<{ info?: string; code?: string; description?: string }> };
      const first = parsed.errors?.[0];
      walmartMessage = first?.info || first?.description || first?.code || walmartMessage;
    } catch {
      // Keep Walmart's raw text fallback when it is not JSON.
    }
    const sentSummary = {
      purchaseOrderId: input.purchaseOrderId,
      packageType: (body as any).packageType,
      boxDimensionKeys: Object.keys((body as any).boxDimensions ?? {}),
      fromAddressKeys: Object.keys((body as any).fromAddress ?? {}),
      toAddressKeys: Object.keys((body as any).toAddress ?? {}),
      boxItemKeys: Object.keys(boxItems[0] ?? {}),
      itemCount: boxItems.length,
      topLevelKeys: Object.keys(body),
      // Capture the actual values we resolved for ship-from — most likely
      // place a 500 hides. If the seller's registered origin is e.g.
      // Phoenix AZ but we sent CA, this will reveal it without leaking
      // anything sensitive.
      fromCity: (body as any).fromAddress?.city,
      fromState: (body as any).fromAddress?.state,
      fromZip: (body as any).fromAddress?.postalCode,
    };
    throw new Error(
      `Walmart Shipping Estimates ${res.status}: ${walmartMessage} | sent: ${JSON.stringify(sentSummary)}`,
    );
  }
  const data = (await res.json()) as any;
  // Response shape per Walmart docs: an array of rate options, each with
  // carrier shortName, serviceType, cost, ETA, addOns. The docs vary on
  // the wrapper field; we probe a few likely shapes.
  const rateList: any[] =
    (Array.isArray(data?.data?.estimates) && data.data.estimates) ||
    (Array.isArray(data?.shippingEstimates) && data.shippingEstimates) ||
    (Array.isArray(data?.rates) && data.rates) ||
    (Array.isArray(data?.estimates) && data.estimates) ||
    (Array.isArray(data?.payload) && data.payload) ||
    (Array.isArray(data) ? data : []);

  return rateList
    .map((r: any) => {
      const carrier = String(
        r?.carrierDisplayName ?? r?.carrier?.shortName ?? r?.carrierShortName ?? r?.carrierName ?? r?.carrier ?? 'Walmart',
      );
      const svcType = String(
        r?.displayName ?? r?.name ?? r?.serviceType ?? r?.carrierServiceType ?? r?.serviceLevel ?? r?.method ?? '',
      );
      const service = svcType ? `${carrier} ${svcType}` : carrier;
      const cost = Number(
        r?.estimatedRate?.amount ?? r?.totalCost?.amount ?? r?.cost?.amount ?? r?.totalCost ?? r?.cost ?? r?.amount ?? 0,
      );
      const currency = String(
        r?.estimatedRate?.currency ?? r?.totalCost?.currency ?? r?.cost?.currency ?? r?.currency ?? 'USD',
      );
      const days = Number(r?.transitTime?.businessDays ?? r?.transitDays ?? r?.deliveryDays ?? 0) || 0;
      return { service, cost, days, currency };
    })
    .filter((r) => r.cost > 0);
}

// ───────── EasyPost (multi-carrier aggregator) ─────────
// Real endpoint: POST https://api.easypost.com/v2/shipments
// Auth: HTTP Basic with the API key as the username, empty password.
// One call returns rates from EVERY carrier the user has connected to
// their EasyPost account (UPS, USPS, FedEx, DHL, etc.) — much simpler
// than wiring per-carrier integrations. EasyPost handles all the carrier
// OAuth/credential management on their side.
async function ratesFromEasyPost(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    rawOrder?: any;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('EasyPost requires apiKey on the carrier_account credentials.');
  }
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('EasyPost rate quotes require box dimensions (length, width, height).');
  }

  // EasyPost API key as Basic Auth username, empty password (the trailing
  // colon after the key matters — without it the API returns 401).
  const basic = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Ship-from: prefer per-account override, fall back to a Carson CA
  // default (matches the convention used by other quoters in this file).
  const credShipFromZip = String(creds?.shipFromZip ?? '').replace(/[^0-9]/g, '').slice(0, 5);
  const fromZip = credShipFromZip || (input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const fromAddress = {
    name: String(creds?.shipFromName ?? '').trim() || 'Seller',
    street1: String(creds?.shipFromAddress1 ?? '').trim() || 'Warehouse',
    city: String(creds?.shipFromCity ?? '').trim() || 'Carson',
    state: String(creds?.shipFromState ?? '').trim() || 'CA',
    zip: fromZip,
    country: 'US',
    phone: String(creds?.shipFromPhone ?? '').trim() || '0000000000',
  };

  // Ship-to: try the saved order address first; fall back to a generic
  // Oakland CA address keyed off toZip for the Settings demo button.
  // EasyPost requires a full address — zip alone won't validate.
  const orderAddr =
    input.rawOrder?.shippingInfo?.postalAddress ?? // walmart shape
    input.rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress ?? // ebay shape
    input.rawOrder?.ShippingAddress ?? // amazon shape
    null;
  const toAddress = orderAddr
    ? {
        name: orderAddr.name ?? orderAddr.fullName ?? orderAddr.Name ?? 'Buyer',
        street1: orderAddr.address1 ?? orderAddr.addressLine1 ?? orderAddr.AddressLine1 ?? '',
        street2: orderAddr.address2 ?? orderAddr.addressLine2 ?? orderAddr.AddressLine2 ?? '',
        city: orderAddr.city ?? orderAddr.City ?? '',
        state: orderAddr.state ?? orderAddr.stateOrProvince ?? orderAddr.StateOrRegion ?? '',
        zip: orderAddr.postalCode ?? orderAddr.PostalCode ?? '',
        country: orderAddr.country ?? orderAddr.countryCode ?? orderAddr.CountryCode ?? 'US',
        phone: orderAddr.phone ?? orderAddr.Phone ?? '0000000000',
      }
    : {
        name: 'Buyer',
        street1: '1 Main St',
        city: 'Oakland',
        state: 'CA',
        zip: (input.toZip || '94601').replace(/[^0-9]/g, '').slice(0, 5),
        country: 'US',
        phone: '0000000000',
      };

  // EasyPost's parcel takes weight in OUNCES (despite some carriers
  // wanting LB internally — EasyPost normalizes). Dimensions in inches.
  const parcel = {
    length: input.dimsL,
    width: input.dimsW,
    height: input.dimsH,
    weight: input.weightOz,
  };

  const body = {
    shipment: {
      from_address: fromAddress,
      to_address: toAddress,
      parcel,
    },
  };

  const res = await fetch('https://api.easypost.com/v2/shipments', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    throw new Error(`EasyPost ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as any;
  const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];

  // Sort by cost ascending so the cheapest rate appears first — matches
  // user expectation when scanning rate-shopping results.
  return rateList
    .map((r: any) => ({
      service: `${r.carrier ?? 'EasyPost'} ${r.service ?? ''}`.trim(),
      cost: Number(r.rate ?? 0),
      days: Number(r.delivery_days ?? r.est_delivery_days ?? 0) || 0,
      currency: String(r.currency ?? 'USD'),
    }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

// ───────── ShipEngine / ShipStation API rate shopping ─────────
async function shipEngineCarrierIds(creds: Record<string, unknown>): Promise<string[]> {
  const explicit = String(creds?.carrierIds ?? creds?.carrier_ids ?? '').trim();
  if (explicit) {
    return explicit
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }

  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('ShipEngine apiKey is required.');
  const res = await fetch('https://api.shipengine.com/v1/carriers', {
    headers: { 'API-Key': apiKey, Accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 500)).catch(() => '');
    throw new Error(`ShipEngine carriers ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as any;
  return (Array.isArray(data?.carriers) ? data.carriers : [])
    .filter((carrier: any) => carrier?.connection_status !== 'pending_approval')
    .map((carrier: any) => String(carrier?.carrier_id ?? '').trim())
    .filter(Boolean);
}

function shipEngineShipTo(rawOrder: any, toZip?: string) {
  const wmAddr = rawOrder?.shippingInfo?.postalAddress ?? null;
  const ebayContact = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const ebayAddr = ebayContact?.contactAddress ?? null;
  const amazonAddr = rawOrder?.ShippingAddress ?? null;
  const ssAddr = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const addr = wmAddr ?? ebayAddr ?? amazonAddr ?? ssAddr;
  const postalCode = String(
    addr?.postalCode ??
      addr?.PostalCode ??
      addr?.postal_code ??
      toZip ??
      '94601',
  ).replace(/[^0-9-]/g, '').slice(0, 10);

  return {
    name: String(
      addr?.name ??
        ebayContact?.fullName ??
        addr?.Name ??
        ssAddr?.name ??
        'Buyer',
    ),
    phone: String(
      rawOrder?.shippingInfo?.phone ??
        ebayContact?.primaryPhone?.phoneNumber ??
        addr?.Phone ??
        ssAddr?.phone ??
        '0000000000',
    ),
    company_name: String(addr?.company ?? ebayContact?.companyName ?? addr?.CompanyName ?? ''),
    address_line1: String(
      addr?.address1 ??
        addr?.addressLine1 ??
        addr?.AddressLine1 ??
        ssAddr?.street1 ??
        '1 Main St',
    ),
    address_line2: String(
      addr?.address2 ??
        addr?.addressLine2 ??
        addr?.AddressLine2 ??
        ssAddr?.street2 ??
        '',
    ) || null,
    city_locality: String(addr?.city ?? addr?.City ?? ssAddr?.city ?? 'Oakland'),
    state_province: String(
      addr?.state ??
        addr?.stateOrProvince ??
        addr?.StateOrRegion ??
        ssAddr?.state ??
        'CA',
    ),
    postal_code: postalCode || '94601',
    country_code: String(addr?.country ?? addr?.countryCode ?? addr?.CountryCode ?? ssAddr?.country ?? 'US'),
    address_residential_indicator: 'yes',
  };
}

function shipEngineShipFrom(
  creds: Record<string, unknown>,
  input: { fromZip?: string; shipFrom?: any },
) {
  const shipFromInput = input.shipFrom && typeof input.shipFrom === 'object' ? input.shipFrom : {};
  const fromZip = String(
    creds?.shipFromZip ??
      shipFromInput?.postalCode ??
      input.fromZip ??
      '90248',
  ).replace(/[^0-9-]/g, '').slice(0, 10);
  return {
    name: String(creds?.shipFromName ?? shipFromInput?.name ?? 'Seller'),
    phone: String(creds?.shipFromPhone ?? shipFromInput?.phone ?? '0000000000'),
    company_name: String(creds?.shipFromCompany ?? creds?.shipFromName ?? shipFromInput?.name ?? ''),
    address_line1: String(
      creds?.shipFromAddress1 ??
        shipFromInput?.addressLine1 ??
        shipFromInput?.street1 ??
        'Warehouse',
    ),
    address_line2: String(
      creds?.shipFromAddress2 ??
        shipFromInput?.addressLine2 ??
        shipFromInput?.street2 ??
        '',
    ) || null,
    city_locality: String(creds?.shipFromCity ?? shipFromInput?.city ?? 'Carson'),
    state_province: String(creds?.shipFromState ?? shipFromInput?.state ?? 'CA'),
    postal_code: fromZip || '90248',
    country_code: String(shipFromInput?.country ?? 'US') || 'US',
    address_residential_indicator: 'no',
  };
}

async function ratesFromShipEngine(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    shipFrom?: any;
    rawOrder?: any;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('ShipEngine apiKey is required.');
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('ShipEngine rates require box dimensions (length, width, height).');
  }

  const carrierIds = await shipEngineCarrierIds(creds);
  if (!carrierIds.length) {
    throw new Error('ShipEngine has no connected carrier IDs available for rates.');
  }

  const body = {
    rate_options: {
      carrier_ids: carrierIds,
    },
    shipment: {
      validate_address: 'no_validation',
      ship_to: shipEngineShipTo(input.rawOrder, input.toZip),
      ship_from: shipEngineShipFrom(creds, {
        fromZip: input.fromZip,
        shipFrom: input.shipFrom,
      }),
      packages: [
        {
          weight: { value: Math.max(0.1, input.weightOz), unit: 'ounce' },
          dimensions: {
            unit: 'inch',
            length: input.dimsL,
            width: input.dimsW,
            height: input.dimsH,
          },
        },
      ],
    },
  };

  const res = await fetch('https://api.shipengine.com/v1/rates', {
    method: 'POST',
    headers: {
      'API-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    throw new Error(`ShipEngine rates ${res.status}: ${t || res.statusText}`);
  }

  const data = (await res.json()) as any;
  const response = data?.rate_response ?? data;
  const apiErrors = Array.isArray(response?.errors) ? response.errors : [];
  const rateList: any[] = Array.isArray(response?.rates) ? response.rates : [];
  if (!rateList.length && apiErrors.length) {
    throw new Error(`ShipEngine returned no rates: ${JSON.stringify(apiErrors).slice(0, 800)}`);
  }

  return rateList
    .map((rate: any) => {
      const shipping = Number(rate?.shipping_amount?.amount ?? 0);
      const insurance = Number(rate?.insurance_amount?.amount ?? 0);
      const confirmation = Number(rate?.confirmation_amount?.amount ?? 0);
      const other = Number(rate?.other_amount?.amount ?? 0);
      const cost = shipping + insurance + confirmation + other;
      const carrier = String(rate?.carrier_friendly_name ?? rate?.carrier_code ?? 'ShipEngine');
      const service = String(rate?.service_type ?? rate?.service_code ?? 'Rate');
      const currency = String(
        rate?.shipping_amount?.currency ??
          rate?.other_amount?.currency ??
          'USD',
      ).toUpperCase();
      const etaTime = Date.parse(rate?.estimated_delivery_date ?? '');
      const days = Number(rate?.delivery_days ?? 0) ||
        (Number.isFinite(etaTime)
          ? Math.max(1, Math.ceil((etaTime - Date.now()) / (24 * 60 * 60 * 1000)))
          : 0);
      return { service: `${carrier} ${service}`.trim(), cost, days, currency };
    })
    .filter((rate) => rate.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

// ───────── eBay Shipping (Logistics API, USPS rates) ─────────
async function getEbayLogisticsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const appId = String(creds?.appId ?? '').trim();
  const certId = String(creds?.certId ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!appId || !certId || !refreshToken) {
    throw new Error('eBay Shipping requires appId, certId, and refreshToken.');
  }
  const useSandbox = String(creds?.environment ?? '').toLowerCase() === 'sandbox';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://api.ebay.com/oauth/api_scope/sell.logistics',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 400)).catch(() => '');
    throw new Error(`eBay Logistics OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('eBay Logistics OAuth response missing access_token');
  return data.access_token;
}

function ebayOrderIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('ebay-') ? trimmed.slice('ebay-'.length) : trimmed;
}

function ebayShipToContact(rawOrder: any) {
  const ship = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const addr = ship?.contactAddress ?? {};
  const postalCode = String(addr?.postalCode ?? '').trim();
  if (postalCode) {
    return {
      fullName: String(ship?.fullName ?? 'Buyer'),
      companyName: ship?.companyName ?? null,
      contactAddress: {
        addressLine1: String(addr?.addressLine1 ?? 'Address unavailable'),
        addressLine2: addr?.addressLine2 ?? null,
        city: String(addr?.city ?? ''),
        stateOrProvince: String(addr?.stateOrProvince ?? ''),
        postalCode,
        countryCode: String(addr?.countryCode ?? 'US'),
        county: String(addr?.county ?? ''),
      },
      primaryPhone: {
        phoneNumber: String(ship?.primaryPhone?.phoneNumber ?? '0000000000'),
      },
    };
  }

  // ShipStation-synced orders store address data as raw.shipTo. This lets
  // eBay Logistics quote an eBay order even when it came through ShipStation
  // before the eBay store poller saved a store_orders copy.
  const ssShipTo = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const ssPostalCode = String(ssShipTo?.postalCode ?? ssShipTo?.postal_code ?? '').trim();
  if (!ssPostalCode) return null;
  return {
    fullName: String(ssShipTo?.name ?? 'Buyer'),
    companyName: ssShipTo?.company ?? null,
    contactAddress: {
      addressLine1: String(ssShipTo?.street1 ?? ssShipTo?.addressLine1 ?? 'Address unavailable'),
      addressLine2: ssShipTo?.street2 ?? ssShipTo?.addressLine2 ?? null,
      city: String(ssShipTo?.city ?? ''),
      stateOrProvince: String(ssShipTo?.state ?? ssShipTo?.stateOrProvince ?? ''),
      postalCode: ssPostalCode,
      countryCode: String(ssShipTo?.country ?? ssShipTo?.countryCode ?? 'US'),
      county: String(ssShipTo?.county ?? ''),
    },
    primaryPhone: {
      phoneNumber: String(ssShipTo?.phone ?? ssShipTo?.primaryPhone?.phoneNumber ?? '0000000000'),
    },
  };
}

async function ratesFromEbayShipping(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    externalOrderId?: string | null;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    fromZip?: string;
    shipFrom?: any;
    rawOrder?: any;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const orderId = ebayOrderIdFrom(input.externalOrderId ?? input.rawOrder?.orderId);
  if (!orderId) {
    throw new Error('eBay Shipping rates require an eBay order id. Open Browse Rates from an eBay-pulled order.');
  }
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('eBay Shipping rates require box dimensions (length, width, height).');
  }
  const shipTo = ebayShipToContact(input.rawOrder);
  if (!shipTo) {
    throw new Error('eBay Shipping rates require the eBay order ship-to address. Pull the eBay order first, then open Browse Rates from that order.');
  }

  const token = await getEbayLogisticsAccessToken(creds);
  const useSandbox = String(creds?.environment ?? '').toLowerCase() === 'sandbox';
  const apiBase = useSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const marketplaceId = String(creds?.marketplaceId ?? 'EBAY_US').trim() || 'EBAY_US';
  const shipFromInput = input.shipFrom && typeof input.shipFrom === 'object' ? input.shipFrom : {};
  const fromZip = String(creds?.shipFromZip ?? shipFromInput?.postalCode ?? input.fromZip ?? '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const shipFrom = {
    fullName: String(creds?.shipFromName ?? shipFromInput?.name ?? 'Seller'),
    companyName: String(creds?.shipFromCompany ?? creds?.shipFromName ?? shipFromInput?.name ?? 'Seller'),
    contactAddress: {
      addressLine1: String(creds?.shipFromAddress1 ?? shipFromInput?.addressLine1 ?? shipFromInput?.street1 ?? 'Warehouse'),
      addressLine2: String(creds?.shipFromAddress2 ?? shipFromInput?.addressLine2 ?? shipFromInput?.street2 ?? ''),
      city: String(creds?.shipFromCity ?? shipFromInput?.city ?? 'Carson'),
      stateOrProvince: String(creds?.shipFromState ?? shipFromInput?.state ?? 'CA'),
      postalCode: fromZip,
      countryCode: String(shipFromInput?.country ?? 'US') || 'US',
      county: String(creds?.shipFromCounty ?? ''),
    },
    primaryPhone: {
      phoneNumber: String(creds?.shipFromPhone ?? shipFromInput?.phone ?? '0000000000'),
    },
  };

  const body = {
    orders: [{ channel: 'EBAY', orderId }],
    packageSpecification: {
      dimensions: {
        length: String(input.dimsL),
        width: String(input.dimsW),
        height: String(input.dimsH),
        unit: 'INCH',
      },
      weight: {
        value: String(Math.max(0.1, input.weightOz)),
        unit: 'OUNCE',
      },
    },
    shipFrom,
    shipTo,
  };

  const res = await fetch(`${apiBase}/sell/logistics/v1_beta/shipping_quote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    throw new Error(`eBay Shipping Quote ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as any;
  const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];
  const now = Date.now();
  return rateList
    .map((r: any) => {
      const carrier = String(r?.shippingCarrierName ?? r?.shippingCarrierCode ?? 'USPS');
      const service = String(r?.shippingServiceName ?? r?.shippingServiceCode ?? 'eBay Shipping');
      const cost = Number(r?.baseShippingCost?.value ?? 0);
      const currency = String(r?.baseShippingCost?.currency ?? 'USD');
      const etaTime = Date.parse(r?.maxEstimatedDeliveryDate ?? r?.minEstimatedDeliveryDate ?? '');
      const days = Number.isFinite(etaTime)
        ? Math.max(1, Math.ceil((etaTime - now) / (24 * 60 * 60 * 1000)))
        : 0;
      return { service: `${carrier} ${service}`.trim(), cost, days, currency };
    })
    .filter((rate) => rate.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

// ───────── Amazon Buy Shipping (SP-API Shipping v2) ─────────
// Real endpoint: POST https://sellingpartnerapi-na.amazon.com/shipping/v2/shipments/rates
// Auth: LWA refresh_token → access_token (no AWS Sigv4 — Amazon dropped that
// requirement in April 2024; only x-amz-access-token header is needed now).
//
// Required body:
//   shipDate, shipFrom, shipTo, packages[], channelDetails.channelType
// channelType:
//   "AMAZON" — for Amazon-marketplace orders (use amazonOrderId in body)
//   "EXTERNAL" — for any other order (Shopify, eBay, etc., or demo calls)
//
// Buy Shipping rates work without a real order, unlike Walmart's
// shipping-estimates — so the Settings demo button can call this directly
// with placeholder shipTo and get back genuine quotes.
async function ratesFromAmazonBuyShipping(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    rawOrder?: any;
    externalOrderId?: string | null;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const lwaClientId = String(creds?.lwaClientId ?? '').trim();
  const lwaClientSecret = String(creds?.lwaClientSecret ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!lwaClientId || !lwaClientSecret || !refreshToken) {
    throw new Error('Amazon Buy Shipping requires lwaClientId, lwaClientSecret, refreshToken on the carrier_account credentials.');
  }
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('Amazon Buy Shipping requires box dimensions (length, width, height). Set them in the Rate Browser before fetching rates.');
  }

  // 1) LWA refresh → access token. Same flow as the verifier.
  const lwaBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: lwaClientId,
    client_secret: lwaClientSecret,
  });
  const lwaRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: lwaBody.toString(),
  });
  if (!lwaRes.ok) {
    const t = await lwaRes.text().then((s) => s.slice(0, 200)).catch(() => '');
    throw new Error(`Amazon LWA ${lwaRes.status}: ${t || lwaRes.statusText}`);
  }
  const lwaJson = (await lwaRes.json()) as { access_token?: string };
  if (!lwaJson?.access_token) throw new Error('Amazon LWA response missing access_token');

  // 2) Build the rate request. shipFrom uses the seller's configured
  // origin (we hardcode a CA default, same as the Walmart quoter — Amazon
  // Buy Shipping rates don't depend on shipFrom matching a registered
  // address as much as Walmart's WSS does, so a generic LA-area shipper
  // works for the Settings demo case).
  const fromZip = (input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const shipFrom = {
    name: 'Seller',
    addressLine1: 'Warehouse',
    city: 'Carson',
    stateOrRegion: 'CA',
    postalCode: fromZip,
    countryCode: 'US',
    phoneNumber: '0000000000',
  };

  // shipTo: prefer the saved order's address if we have one; fall back
  // to a generic Oakland CA address keyed off toZip for the Settings
  // demo button. Amazon's Buy Shipping API requires a full address —
  // zip alone won't validate.
  const orderAddr = input.rawOrder?.ShippingAddress ?? input.rawOrder?.shippingAddress ?? null;
  const shipTo = orderAddr
    ? {
        name: orderAddr.Name ?? orderAddr.name ?? 'Buyer',
        addressLine1: orderAddr.AddressLine1 ?? orderAddr.addressLine1 ?? '',
        addressLine2: orderAddr.AddressLine2 ?? orderAddr.addressLine2 ?? '',
        city: orderAddr.City ?? orderAddr.city ?? '',
        stateOrRegion: orderAddr.StateOrRegion ?? orderAddr.stateOrRegion ?? '',
        postalCode: orderAddr.PostalCode ?? orderAddr.postalCode ?? '',
        countryCode: orderAddr.CountryCode ?? orderAddr.countryCode ?? 'US',
        phoneNumber: orderAddr.Phone ?? orderAddr.phone ?? '0000000000',
      }
    : {
        name: 'Buyer',
        addressLine1: '1 Main St',
        city: 'Oakland',
        stateOrRegion: 'CA',
        postalCode: (input.toZip || '94601').replace(/[^0-9]/g, '').slice(0, 5),
        countryCode: 'US',
        phoneNumber: '0000000000',
      };

  // Buy Shipping uses INCH/POUND uppercase strings.
  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  const packages = [
    {
      packageClientReferenceId: '1',
      dimensions: {
        length: input.dimsL,
        width: input.dimsW,
        height: input.dimsH,
        unit: 'INCH',
      },
      weight: { value: weightLb, unit: 'POUND' },
    },
  ];

  // Determine channel: if this is an Amazon order, use AMAZON + amazonOrderId.
  // Otherwise EXTERNAL (Settings demo, or non-Amazon marketplaces).
  const ext = input.externalOrderId ?? '';
  const isAmazonOrder = typeof ext === 'string' && ext.startsWith('amazon-');
  const amazonOrderId = isAmazonOrder ? ext.slice('amazon-'.length) : null;
  const channelDetails = isAmazonOrder
    ? { channelType: 'AMAZON', amazonOrderDetails: { amazonOrderId } }
    : { channelType: 'EXTERNAL' };

  // Ship date defaults to today; Buy Shipping accepts ISO-8601 with timezone.
  const shipDate = new Date().toISOString();

  const body = {
    shipDate,
    shipFrom,
    shipTo,
    packages,
    channelDetails,
  };

  // SP-API endpoint host varies by region (NA / EU / FE). Using NA since
  // marketplaceId ATVPDKIKX0DER (US) is the only one we currently support.
  // If the seller adds non-NA marketplaces, route on marketplaceId here.
  const url = 'https://sellingpartnerapi-na.amazon.com/shipping/v2/shipments/rates';
  const apiRes = await fetch(url, {
    method: 'POST',
    headers: {
      'x-amz-access-token': lwaJson.access_token!,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!apiRes.ok) {
    const t = await apiRes.text().then((s) => s.slice(0, 800)).catch(() => '');
    const sentSummary = {
      hasShipFrom: !!shipFrom,
      hasShipTo: !!shipTo,
      packageCount: packages.length,
      channelType: channelDetails.channelType,
      shipFromKeys: Object.keys(shipFrom),
      shipToKeys: Object.keys(shipTo),
    };
    throw new Error(
      `Amazon Buy Shipping ${apiRes.status}: ${t || apiRes.statusText} | sent: ${JSON.stringify(sentSummary)}`,
    );
  }
  const data = (await apiRes.json()) as any;

  // Buy Shipping v2 wraps rates under either `rates` or `rateGroups[].rates`.
  // Normalize to a flat list.
  const flat: any[] = [];
  if (Array.isArray(data?.rates)) flat.push(...data.rates);
  if (Array.isArray(data?.payload?.rates)) flat.push(...data.payload.rates);
  if (Array.isArray(data?.rateGroups)) {
    for (const g of data.rateGroups) {
      if (Array.isArray(g?.rates)) flat.push(...g.rates);
    }
  }
  if (Array.isArray(data?.payload?.rateGroups)) {
    for (const g of data.payload.rateGroups) {
      if (Array.isArray(g?.rates)) flat.push(...g.rates);
    }
  }

  return flat
    .map((r: any) => {
      const carrier = String(r?.carrierName ?? r?.carrier?.name ?? r?.carrier ?? 'Amazon');
      const svc = String(r?.serviceName ?? r?.service?.name ?? r?.serviceLevel ?? '');
      const service = svc ? `${carrier} ${svc}` : carrier;
      const cost = Number(
        r?.totalCharge?.value ??
          r?.totalCharge?.amount ??
          r?.billedWeight?.value ??
          r?.amount ??
          0,
      );
      const currency = String(
        r?.totalCharge?.unit ?? r?.totalCharge?.currency ?? r?.currency ?? 'USD',
      );
      // Buy Shipping returns deliveryWindow start/end ISO timestamps; convert
      // to "days from today" for display parity with the other carriers.
      const promise = r?.promise?.deliveryWindow ?? r?.promise ?? null;
      const endDate = promise?.end ?? promise?.latest ?? null;
      const days = endDate
        ? Math.max(
            1,
            Math.round((new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
          )
        : 0;
      return { service, cost, days, currency };
    })
    .filter((r) => r.cost > 0);
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
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token', reason: verified.reason }); return; }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }

  const body = (await readBody(req)) as Record<string, unknown>;
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

    if (provider === 'simulator') {
      const rates = simulatorRates({ weightOz, toZip });
      res.status(200).json({
        ok: true,
        provider,
        simulated: true,
        rates,
        fetchedAt: new Date().toISOString(),
      });
      return;
    }

    if (provider === 'ups') {
      try {
        const rates = await ratesFromUps(creds, {
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
        });
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
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
        const rates = await ratesFromFedex(creds, {
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH,
        });
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        res.status(200).json({
          ok: false, provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (provider === 'usps') {
      try {
        const rates = await ratesFromUsps(creds, {
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH,
        });
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        res.status(200).json({
          ok: false, provider,
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
        const rates = await ratesFromShipEngine(creds, {
          weightOz,
          toZip,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shipFrom: body?.shipFrom,
          rawOrder,
        });
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, orderNumber, hasRawOrder: rawOrder != null, rateCount: rates.length },
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
        } catch { /* non-fatal; ratesFromWalmartShipping has a fallback */ }
      }

      try {
        const rates = await ratesFromWalmartShipping(creds, {
          weightOz,
          purchaseOrderId,
          dimsL,
          dimsW,
          dimsH,
          fromZip,
          shipFrom: shipFromForRates,
          rawOrder,
        });
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
        const rates = await ratesFromAmazonBuyShipping(creds, {
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH,
          rawOrder,
          externalOrderId,
        });
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, hasRawOrder: rawOrder != null },
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
        const rates = await ratesFromEbayShipping(creds, {
          weightOz,
          externalOrderId,
          fromZip,
          dimsL,
          dimsW,
          dimsH,
          shipFrom: body?.shipFrom,
          rawOrder,
        });
        res.status(200).json({
          ok: true,
          provider,
          simulated: false,
          rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, orderNumber, ebayOrderId, hasRawOrder: rawOrder != null },
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
        const rates = await ratesFromEasyPost(creds, {
          weightOz, toZip, fromZip, dimsL, dimsW, dimsH, rawOrder,
        });
        res.status(200).json({
          ok: true, provider, simulated: false, rates,
          fetchedAt: new Date().toISOString(),
          meta: { externalOrderId, hasRawOrder: rawOrder != null, rateCount: rates.length },
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carriers/rates]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
