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

async function ratesFromWalmartShipping(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    purchaseOrderId?: string | null;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
  },
): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  if (!input.purchaseOrderId) {
    throw new Error(
      'Walmart Shipping Solutions rates require a Walmart purchaseOrderId. Open the Rate Browser on a Walmart-pulled order (orders whose external id starts with walmart-).',
    );
  }
  const token = await getWalmartAccessTokenForRates(creds);
  const correlationId = `prepship-${Date.now().toString(36)}`;
  const channelType = String(creds?.channelType ?? '').trim();
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': correlationId,
    'WM_SVC.NAME': 'Walmart Marketplace',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;

  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  const body: Record<string, unknown> = {
    purchaseOrderIds: [input.purchaseOrderId],
    weight: { value: weightLb, unit: 'LB' },
  };
  if (input.dimsL && input.dimsW && input.dimsH) {
    body.dimensions = {
      length: input.dimsL,
      width: input.dimsW,
      height: input.dimsH,
      unit: 'IN',
    };
  }

  // Most common documented endpoint for Sponsored Carrier rate requests.
  // Variants exist (/v3/shipping/labels/v2/rates, /v3/orders/.../shipping/rates)
  // and are program-specific. If this 404s, try /v2/ form below.
  const endpoints = [
    'https://marketplace.walmartapis.com/v3/shipping/labels/rates',
    `https://marketplace.walmartapis.com/v3/orders/${encodeURIComponent(
      input.purchaseOrderId,
    )}/shipping/labels/rates`,
  ];

  let lastErr: string = '';
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res.status === 404) {
        lastErr = `404 from ${url}`;
        continue; // try next endpoint shape
      }
      if (!res.ok) {
        const t = await res.text().then((s) => s.slice(0, 600)).catch(() => '');
        throw new Error(`Walmart Shipping rates ${res.status} (${url}): ${t || res.statusText}`);
      }
      const data = (await res.json()) as any;
      // Walmart returns either {rates: [...]} or {payload: {rates: [...]}} depending
      // on the program. Probe both.
      const rateList: any[] =
        (Array.isArray(data?.rates) && data.rates) ||
        (Array.isArray(data?.payload?.rates) && data.payload.rates) ||
        (Array.isArray(data?.list?.elements) && data.list.elements) ||
        [];
      return rateList
        .map((r: any) => {
          const service = String(
            r?.serviceLevelName ?? r?.serviceLevel ?? r?.carrierName ?? r?.method ?? 'Walmart Service',
          );
          const cost = Number(
            r?.totalCost?.amount ?? r?.cost?.amount ?? r?.amount ?? r?.totalCost ?? r?.cost ?? 0,
          );
          const currency = String(
            r?.totalCost?.currency ?? r?.cost?.currency ?? r?.currency ?? 'USD',
          );
          const days = Number(r?.transitDays ?? r?.deliveryDays ?? 0) || 0;
          return { service, cost, days, currency };
        })
        .filter((r) => r.cost > 0);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`No Walmart shipping rates endpoint accepted the request. Last error: ${lastErr}`);
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
  const carrierAccountId = body?.carrierAccountId != null ? Number(body.carrierAccountId) : NaN;
  if (!Number.isFinite(carrierAccountId) || carrierAccountId <= 0) {
    res.status(400).json({ error: 'carrierAccountId is required' });
    return;
  }

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  try {
    const rows = await sql<Array<{ provider: string; credentials: unknown }>>`
      SELECT provider, credentials FROM carrier_accounts WHERE id = ${carrierAccountId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) { res.status(404).json({ error: `carrier_accounts row #${carrierAccountId} not found` }); return; }

    const provider = String(row.provider).toLowerCase();
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

    if (provider === 'walmart_shipping') {
      // Confirmed empirically: the documented Walmart Sponsored Carrier rate
      // endpoints (/v3/shipping/labels/rates and per-order variants) return
      // 404 / "No matching handler" for production seller accounts. Walmart's
      // Marketplace API genuinely doesn't expose a generic rate-shop endpoint.
      // The credentials remain useful for future label-purchase flows via
      // /v3/orders/{poId}/shipping (tracking + label) — but for rate-shopping
      // Walmart orders, point the user at their UPS / USPS / FedEx direct
      // accounts (which DO have rate APIs) instead.
      res.status(200).json({
        ok: false,
        provider,
        error: "Walmart's Marketplace API doesn't expose a rate-quote endpoint for this account. Use a real carrier (UPS / USPS / FedEx direct) for rate-shopping; this Walmart Shipping entry is kept around for future label-purchase flows that don't need a pre-purchase rate.",
      });
      return;
    }

    // Real-carrier rate quoters slot in here as they get implemented:
    //   case 'fedex':  return ratesFromFedex(creds, body)
    //   case 'usps':   return ratesFromUspsV3(creds, body)
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
