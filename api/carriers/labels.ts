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
import { PDFDocument } from 'pdf-lib';
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
async function getUpsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) throw new Error('UPS clientId + clientSecret required');
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
    const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
    throw new Error(`UPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('UPS OAuth response missing access_token');
  return data.access_token;
}

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

// ─── UPS label purchase via /api/shipments/v2403/ship ───────────────
// Returns: { trackingNumber, labelDataBase64, cost, currency }
// UPS returns the label as base64 GIF. For browser display we wrap it
// as a data: URL — Vercel function size limits prevent us from saving
// the bytes anywhere else without a separate object-store dependency.
async function buyLabelUps(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    dimsL: number; dimsW: number; dimsH: number;
    serviceCode: string; // e.g. "03" = Ground, "01" = Next Day Air
    shipFrom: any;
    shipTo: any;
  },
): Promise<{ trackingNumber: string; labelUrl: string; cost: number; currency: string; raw: any }> {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('UPS accountNumber required');
  const token = await getUpsAccessToken(creds);

  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);

  const body = {
    ShipmentRequest: {
      Request: {
        SubVersion: '2403',
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: 'prepship-label' },
      },
      Shipment: {
        Description: 'Merchandise',
        Shipper: {
          Name: input.shipFrom.name,
          AttentionName: input.shipFrom.name,
          ShipperNumber: accountNumber,
          Phone: { Number: input.shipFrom.phone || '0000000000' },
          Address: {
            AddressLine: [input.shipFrom.street1],
            City: input.shipFrom.city,
            StateProvinceCode: input.shipFrom.state,
            PostalCode: input.shipFrom.zip,
            CountryCode: input.shipFrom.country,
          },
        },
        ShipTo: {
          Name: input.shipTo.name,
          AttentionName: input.shipTo.name,
          Phone: { Number: input.shipTo.phone || '0000000000' },
          Address: {
            AddressLine: [input.shipTo.street1, input.shipTo.street2].filter(Boolean),
            City: input.shipTo.city,
            StateProvinceCode: input.shipTo.state,
            PostalCode: input.shipTo.zip,
            CountryCode: input.shipTo.country,
          },
        },
        ShipFrom: {
          Name: input.shipFrom.name,
          AttentionName: input.shipFrom.name,
          Phone: { Number: input.shipFrom.phone || '0000000000' },
          Address: {
            AddressLine: [input.shipFrom.street1],
            City: input.shipFrom.city,
            StateProvinceCode: input.shipFrom.state,
            PostalCode: input.shipFrom.zip,
            CountryCode: input.shipFrom.country,
          },
        },
        PaymentInformation: {
          ShipmentCharge: {
            Type: '01', // 01 = transportation charges
            BillShipper: { AccountNumber: accountNumber },
          },
        },
        Service: { Code: input.serviceCode },
        Package: {
          Description: 'Merchandise',
          Packaging: { Code: '02' }, // 02 = customer-supplied
          Dimensions: {
            UnitOfMeasurement: { Code: 'IN' },
            Length: String(input.dimsL),
            Width: String(input.dimsW),
            Height: String(input.dimsH),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(weightLb),
          },
        },
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  };

  const res = await fetch('https://onlinetools.ups.com/api/shipments/v2403/ship', {
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
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* leave as text */ }
  if (!res.ok) {
    const errMsg = data?.response?.errors?.[0]?.message ?? text.slice(0, 600);
    throw new Error(`UPS Shipping ${res.status}: ${errMsg}`);
  }

  const shipResult = data?.ShipmentResponse?.ShipmentResults;
  const trackingNumber =
    shipResult?.PackageResults?.TrackingNumber ??
    shipResult?.PackageResults?.[0]?.TrackingNumber ??
    null;
  const labelImageBase64 =
    shipResult?.PackageResults?.ShippingLabel?.GraphicImage ??
    shipResult?.PackageResults?.[0]?.ShippingLabel?.GraphicImage ??
    null;
  const cost = Number(
    shipResult?.ShipmentCharges?.TotalCharges?.MonetaryValue ?? 0,
  );
  const currency = String(
    shipResult?.ShipmentCharges?.TotalCharges?.CurrencyCode ?? 'USD',
  );

  if (!trackingNumber) throw new Error('UPS Shipping response missing TrackingNumber');
  if (!labelImageBase64) throw new Error('UPS Shipping response missing label image');

  // Wrap the GIF base64 as a data URL so the FE can directly embed/print
  // without an extra fetch round-trip. UPS labels are ~30-50KB so this
  // stays well under any reasonable URL length limit for fetch responses.
  const labelUrl = `data:image/gif;base64,${labelImageBase64}`;

  return { trackingNumber, labelUrl, cost, currency, raw: data };
}

// ─── EasyPost label purchase: POST /shipments/{id}/buy ───────────────
// EasyPost uses a two-step flow: rate quote returns a shipment_id + rate
// objects with their own ids; buying selects which rate to commit. Since
// our /carriers/rates endpoint discards the EasyPost ids before
// returning, we re-quote here to get fresh ids, then buy. Costs nothing
// extra (rate quotes are free) and avoids stale-id failures.
async function buyLabelEasyPost(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    dimsL: number; dimsW: number; dimsH: number;
    serviceCode: string; // e.g. "USPS Priority" — we match on carrier+service
    shipFrom: any;
    shipTo: any;
  },
): Promise<{ trackingNumber: string; labelUrl: string; cost: number; currency: string; shipmentId: string; raw: any }> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('EasyPost apiKey required');
  const basic = Buffer.from(`${apiKey}:`).toString('base64');
  const headers = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Step 1: create shipment, get rate ids
  const shipBody = {
    shipment: {
      from_address: {
        name: input.shipFrom.name,
        street1: input.shipFrom.street1,
        city: input.shipFrom.city,
        state: input.shipFrom.state,
        zip: input.shipFrom.zip,
        country: input.shipFrom.country,
        phone: input.shipFrom.phone,
      },
      to_address: {
        name: input.shipTo.name,
        street1: input.shipTo.street1,
        street2: input.shipTo.street2 || '',
        city: input.shipTo.city,
        state: input.shipTo.state,
        zip: input.shipTo.zip,
        country: input.shipTo.country,
        phone: input.shipTo.phone,
      },
      parcel: {
        length: input.dimsL,
        width: input.dimsW,
        height: input.dimsH,
        weight: input.weightOz,
      },
    },
  };
  const createRes = await fetch('https://api.easypost.com/v2/shipments', {
    method: 'POST', headers, body: JSON.stringify(shipBody),
  });
  if (!createRes.ok) {
    const t = await createRes.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`EasyPost create-shipment ${createRes.status}: ${t}`);
  }
  const shipment = (await createRes.json()) as any;

  // Step 2: pick the rate matching serviceCode (or cheapest if no match)
  const rates: any[] = Array.isArray(shipment?.rates) ? shipment.rates : [];
  if (rates.length === 0) throw new Error('EasyPost shipment has no rates — check carrier connections in EasyPost dashboard');
  const wantSvc = String(input.serviceCode ?? '').toLowerCase();
  let rate =
    rates.find((r) => `${r.carrier} ${r.service}`.toLowerCase() === wantSvc) ??
    rates.find((r) => String(r.service).toLowerCase() === wantSvc) ??
    rates.find((r) => `${r.carrier}_${r.service}`.toLowerCase() === wantSvc.replace(/\s+/g, '_'));
  if (!rate) {
    // Fallback: pick the cheapest. The user gets *some* label rather than
    // a hard failure, and the response includes which service was actually
    // used so they can adjust if needed.
    rate = rates.reduce((cheapest: any, r: any) =>
      Number(r.rate) < Number(cheapest.rate) ? r : cheapest,
    rates[0]);
  }

  // Step 3: buy the chosen rate
  const buyRes = await fetch(`https://api.easypost.com/v2/shipments/${shipment.id}/buy`, {
    method: 'POST', headers, body: JSON.stringify({ rate: { id: rate.id } }),
  });
  if (!buyRes.ok) {
    const t = await buyRes.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`EasyPost buy-shipment ${buyRes.status}: ${t}`);
  }
  const purchased = (await buyRes.json()) as any;

  return {
    trackingNumber: String(purchased.tracking_code ?? ''),
    labelUrl: String(purchased.postage_label?.label_url ?? ''),
    cost: Number(purchased.selected_rate?.rate ?? rate.rate ?? 0),
    currency: String(purchased.selected_rate?.currency ?? rate.currency ?? 'USD'),
    shipmentId: String(purchased.id ?? shipment.id),
    raw: purchased,
  };
}

const SHIPP_PROVIDER_ID_OFFSET = 10_000_000;

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function slugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function shippSplitSetCookie(header: string): string[] {
  if (!header) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function shippCookieHeaderFrom(res: any, data: any): string {
  const getSetCookie = typeof res?.headers?.getSetCookie === 'function'
    ? res.headers.getSetCookie.bind(res.headers)
    : null;
  const setCookies: string[] = getSetCookie
    ? getSetCookie()
    : shippSplitSetCookie(String(res?.headers?.get?.('set-cookie') ?? ''));
  const cookiePairs = setCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean);

  const accessToken = String(data?.session?.access_token ?? data?.access_token ?? '').trim();
  const refreshToken = String(data?.session?.refresh_token ?? data?.refresh_token ?? '').trim();
  if (accessToken && !cookiePairs.some((cookie) => cookie.startsWith('sb-access-token='))) {
    cookiePairs.push(`sb-access-token=${encodeURIComponent(accessToken)}`);
  }
  if (refreshToken && !cookiePairs.some((cookie) => cookie.startsWith('sb-refresh-token='))) {
    cookiePairs.push(`sb-refresh-token=${encodeURIComponent(refreshToken)}`);
  }

  return cookiePairs.join('; ');
}

function shippRequiredString(value: unknown, fallback: string): string {
  const v = String(value ?? '').trim();
  return v || fallback;
}

function shippCountryCode(value: unknown, fallback = 'US'): string {
  const v = shippRequiredString(value, fallback).toUpperCase();
  if (v === 'USA' || v === 'UNITED STATES' || v === 'UNITED STATES OF AMERICA') return 'US';
  return v.slice(0, 2) || fallback;
}

function shippBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function shippFirstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

const shippZipCache = new Map<string, { city?: string; state?: string }>();

async function shippLookupUsZip(zip: unknown): Promise<{ city?: string; state?: string }> {
  const five = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(five)) return {};
  const cached = shippZipCache.get(five);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.zippopotam.us/us/${five}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const empty = {};
      shippZipCache.set(five, empty);
      return empty;
    }
    const data = await res.json() as any;
    const place = Array.isArray(data?.places) ? data.places[0] : null;
    const result = {
      city: shippFirstString(place?.['place name']),
      state: shippFirstString(place?.['state abbreviation']),
    };
    shippZipCache.set(five, result);
    return result;
  } catch {
    return {};
  }
}

function shippCarrierCode(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  return normalized.replace(/[^a-z0-9_]+/g, '').replace(/^_+|_+$/g, '') || null;
}

function shippCarrierName(value: unknown): string | null {
  const code = shippCarrierCode(value);
  if (code === 'fedex') return 'FedEx';
  if (code === 'ups') return 'UPS';
  if (code === 'stamps_com') return 'USPS';
  if (code === 'dhl_express') return 'DHL';
  const raw = String(value ?? '').trim();
  return raw || null;
}

function shippRawCarrier(rate: any): unknown {
  return rate?.carrierType ?? rate?.carrier ?? rate?.carrierCode ?? rate?.carrierName;
}

function shippRateServiceName(rate: any): string {
  return String(rate?.serviceName ?? rate?.serviceType ?? 'Shipp').trim();
}

function shippServiceCodeForRate(rate: any): string {
  const carrierCode = shippCarrierCode(shippRawCarrier(rate));
  const carrierPrefix = carrierCode && carrierCode !== 'shipp' ? `${carrierCode}_` : '';
  return `shipp_${carrierPrefix}${slugRateService(shippRateServiceName(rate))}`;
}

function shippDateDays(deliveryDate: unknown, deliveryDay: unknown): number {
  const dateString = String(deliveryDate ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const start = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const end = Date.parse(`${dateString}T00:00:00Z`);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return Math.max(0, Math.ceil((end - start) / 86_400_000));
    }
  }
  const numeric = Number(deliveryDay);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function shippRefNumber(input: { externalOrderId?: string | null; orderNumber?: string | null; rawOrder?: any }): string | undefined {
  const candidates = [
    input.orderNumber,
    input.externalOrderId,
    input.rawOrder?.purchaseOrderId,
    input.rawOrder?.orderId,
    input.rawOrder?.OrderId,
    input.rawOrder?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value.slice(0, 80);
  }
  return undefined;
}

function shippHasRawShipTo(rawOrder: any): boolean {
  if (!rawOrder) return false;
  if (rawOrder?.shippingInfo?.postalAddress) return true;
  if (Array.isArray(rawOrder?.fulfillmentStartInstructions)
    && rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo) return true;
  if (rawOrder?.ShippingAddress) return true;
  if (rawOrder?.shipTo || rawOrder?.ship_to) return true;
  return false;
}

function shippShipTo(rawOrder: any, toZip?: string, explicitShipTo?: any) {
  const wmAddr = rawOrder?.shippingInfo?.postalAddress ?? null;
  const ebayContact = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const ebayAddr = ebayContact?.contactAddress ?? null;
  const amazonAddr = rawOrder?.ShippingAddress ?? null;
  const ssAddr = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const explicit = explicitShipTo && typeof explicitShipTo === 'object' ? explicitShipTo : null;
  const addr = explicit ?? wmAddr ?? ebayAddr ?? amazonAddr ?? ssAddr;
  const postalCode = String(
    addr?.postalCode ??
      addr?.zip ??
      addr?.PostalCode ??
      addr?.postal_code ??
      toZip ??
      '94601',
  ).replace(/[^0-9-]/g, '').slice(0, 10);

  return {
    name: String(addr?.name ?? ebayContact?.fullName ?? addr?.Name ?? ssAddr?.name ?? 'Buyer'),
    phone: String(
      addr?.phone ??
        rawOrder?.shippingInfo?.phone ??
        ebayContact?.primaryPhone?.phoneNumber ??
        addr?.Phone ??
        ssAddr?.phone ??
        '0000000000',
    ),
    company_name: String(addr?.company ?? ebayContact?.companyName ?? addr?.CompanyName ?? ''),
    address_line1: String(
      addr?.street1 ??
        addr?.address1 ??
        addr?.addressLine1 ??
        addr?.AddressLine1 ??
        ssAddr?.street1 ??
        '1 Main St',
    ),
    address_line2: String(
      addr?.street2 ??
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

function shippShipFrom(
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
    company_name: String(creds?.shipFromCompany ?? creds?.shipFromName ?? shipFromInput?.company ?? shipFromInput?.name ?? ''),
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

async function shippLogin(creds: Record<string, unknown>): Promise<{ apiKey: string; cookieHeader: string; email: string }> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const email = String(creds?.email ?? '').trim();
  const password = String(creds?.password ?? '').trim();
  if (!apiKey || !email || !password) {
    throw new Error('Shipp requires apiKey, email, and password on the carrier account credentials.');
  }

  const res = await fetch('https://shipp.to/api/supabase/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!res.ok) {
    throw new Error(`Shipp login ${res.status}: ${text.slice(0, 600) || res.statusText}`);
  }

  const cookieHeader = shippCookieHeaderFrom(res, data);
  if (!cookieHeader) {
    throw new Error('Shipp login succeeded but did not return a session cookie.');
  }

  return { apiKey, cookieHeader, email };
}

async function quoteShippRates(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    toZip?: string;
    fromZip?: string;
    dimsL?: number;
    dimsW?: number;
    dimsH?: number;
    shipFrom?: any;
    shipTo?: any;
    rawOrder?: any;
    externalOrderId?: string | null;
    orderNumber?: string | null;
  },
): Promise<{ session: { apiKey: string; cookieHeader: string }; rates: any[] }> {
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('Shipp label creation requires box dimensions (length, width, height).');
  }

  const session = await shippLogin(creds);
  const from = shippShipFrom(creds, { fromZip: input.fromZip, shipFrom: input.shipFrom });
  const to = shippShipTo(input.rawOrder, input.toZip, input.shipTo);
  const hasShipTo = Boolean(input.shipTo?.street1) || shippHasRawShipTo(input.rawOrder);
  const toZipPlace = await shippLookupUsZip(to.postal_code);
  const fromHasExplicitCity = Boolean(shippFirstString(creds?.shipFromCity, input.shipFrom?.city));
  const fromHasExplicitState = Boolean(shippFirstString(creds?.shipFromState, input.shipFrom?.state));
  const fromZipPlace = (!fromHasExplicitCity || !fromHasExplicitState)
    ? await shippLookupUsZip(from.postal_code)
    : {};
  const weightLb = Math.max(0.01, Math.round((Number(input.weightOz || 16) / 16) * 100) / 100);
  const refNumber = shippRefNumber(input);

  const shippingInfo: Record<string, unknown> = {
    fromCompanyName: shippRequiredString(from.company_name, shippRequiredString(from.name, 'Seller')),
    fromName: shippRequiredString(from.name, 'Seller'),
    fromStreet1: shippRequiredString(from.address_line1, 'Warehouse'),
    fromStreet2: String(from.address_line2 ?? ''),
    fromCity: shippRequiredString(fromHasExplicitCity ? from.city_locality : shippFirstString(fromZipPlace.city, from.city_locality), 'Carson'),
    fromState: shippRequiredString(fromHasExplicitState ? from.state_province : shippFirstString(fromZipPlace.state, from.state_province), 'CA').slice(0, 2).toUpperCase(),
    fromZipcode: shippRequiredString(from.postal_code, '90248'),
    fromCountry: shippCountryCode(from.country_code),
    fromPhone: shippRequiredString(from.phone, '0000000000'),
    fromIsResidential: shippBool(creds?.shipFromIsResidential, false),
    toCompanyName: String(to.company_name ?? ''),
    toName: shippRequiredString(hasShipTo ? to.name : shippFirstString(to.name), 'Buyer'),
    toStreet1: shippRequiredString(hasShipTo ? to.address_line1 : shippFirstString(to.address_line1), '1 Main St'),
    toStreet2: String(to.address_line2 ?? ''),
    toCity: shippRequiredString(hasShipTo ? to.city_locality : shippFirstString(toZipPlace.city, to.city_locality), 'Oakland'),
    toState: shippRequiredString(hasShipTo ? to.state_province : shippFirstString(toZipPlace.state, to.state_province), 'CA').slice(0, 2).toUpperCase(),
    toZipcode: shippRequiredString(to.postal_code, input.toZip ?? '94601'),
    toCountry: shippCountryCode(to.country_code),
    toPhone: shippRequiredString(to.phone, '0000000000'),
    toIsResidential: shippBool(creds?.toIsResidential, true),
    requireSignature: shippBool(creds?.requireSignature, false),
    shipDate: new Date().toISOString().slice(0, 10),
  };
  if (refNumber) shippingInfo.refNumber = refNumber;

  const quoteBody = {
    shippingInfo,
    packageLineItems: [
      {
        weight: { value: weightLb },
        dimensions: {
          length: Number(input.dimsL),
          width: Number(input.dimsW),
          height: Number(input.dimsH),
        },
        description: String(creds?.packageDescription ?? 'Merchandise'),
        itemDescription: String(creds?.packageDescription ?? 'Merchandise'),
        customsValue: { amount: 0, currency: 'USD' },
        countryOfManufacture: 'US',
      },
    ],
  };

  const res = await fetch('https://shipp.to/api/shipping/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': session.apiKey,
      Cookie: session.cookieHeader,
    },
    body: JSON.stringify(quoteBody),
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!res.ok) {
    throw new Error(`Shipp quote ${res.status}: ${text.slice(0, 800) || res.statusText}`);
  }

  const rates: any[] = Array.isArray(data?.rates) ? data.rates : [];
  if (!rates.length) {
    const errors = Array.isArray(data?.errors) && data.errors.length
      ? ` Carrier errors: ${JSON.stringify(data.errors).slice(0, 500)}`
      : '';
    throw new Error(`Shipp returned 0 rates for this shipment.${errors}`);
  }

  return { session, rates };
}

function selectShippRate(rates: any[], requestedServiceCode: unknown): any {
  const wanted = normalizeProviderKey(requestedServiceCode);
  const sorted = [...rates]
    .filter((rate) => Number(rate?.price ?? 0) > 0)
    .sort((a, b) => Number(a?.price ?? 0) - Number(b?.price ?? 0));
  const exact = sorted.find((rate) => shippServiceCodeForRate(rate) === wanted);
  if (exact) return exact;

  const wantedSlug = wanted.replace(/^shipp_/, '');
  const fuzzy = sorted.find((rate) => {
    const carrierCode = shippCarrierCode(shippRawCarrier(rate));
    const serviceSlug = slugRateService(shippRateServiceName(rate));
    return wantedSlug === serviceSlug || wantedSlug === `${carrierCode}_${serviceSlug}`;
  });
  if (fuzzy) return fuzzy;

  throw new Error(`Shipp did not return the selected service ${String(requestedServiceCode ?? '')}. Please browse rates again.`);
}

function shippTrackingFromLabel(label: any): string {
  return String(
    label?.data?.tracking_number ??
      label?.tracking_number ??
      label?.ShipmentResponse?.ShipmentResults?.ShipmentIdentificationNumber ??
      label?.output?.transactionShipments?.[0]?.masterTrackingNumber ??
      '',
  );
}

async function pdfDataUrlFromParts(parts: Array<{ base64: string; format?: string }>): Promise<string | null> {
  const pdf = await PDFDocument.create();
  let pages = 0;

  for (const part of parts) {
    const base64 = String(part.base64 ?? '').trim();
    if (!base64) continue;
    const format = String(part.format ?? 'application/pdf').toLowerCase();
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (format === 'application/pdf' || format === 'pdf') {
      const src = await PDFDocument.load(bytes);
      const copied = await pdf.copyPages(src, src.getPageIndices());
      copied.forEach((page) => {
        pdf.addPage(page);
        pages += 1;
      });
    } else if (format === 'image/png' || format === 'png') {
      const image = await pdf.embedPng(bytes);
      pdf.addPage([image.width, image.height]).drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
      pages += 1;
    }
  }

  if (!pages) return null;
  const merged = await pdf.save();
  return `data:application/pdf;base64,${Buffer.from(merged).toString('base64')}`;
}

async function shippLabelUrl(label: any, carrierCode: string | null): Promise<string | null> {
  if (label?.data?.packages) {
    const parts = (Array.isArray(label.data.packages) ? label.data.packages : [])
      .map((pkg: any) => ({
        base64: String(pkg?.label ?? ''),
        format: String(pkg?.label_format ?? 'application/pdf'),
      }));
    return pdfDataUrlFromParts(parts);
  }

  if (carrierCode === 'fedex' && label?.output?.transactionShipments?.[0]?.pieceResponses) {
    const docs = label.output.transactionShipments[0].pieceResponses
      .flatMap((piece: any) => Array.isArray(piece?.packageDocuments) ? piece.packageDocuments : [])
      .map((doc: any) => ({
        base64: String(doc?.encodedLabel ?? ''),
        format: 'application/pdf',
      }));
    return pdfDataUrlFromParts(docs);
  }

  if (carrierCode === 'ups' && label?.ShipmentResponse?.ShipmentResults?.PackageResults) {
    const packages = Array.isArray(label.ShipmentResponse.ShipmentResults.PackageResults)
      ? label.ShipmentResponse.ShipmentResults.PackageResults
      : [label.ShipmentResponse.ShipmentResults.PackageResults];
    const firstGraphic = packages
      .map((pkg: any) => String(pkg?.ShippingLabel?.GraphicImage ?? ''))
      .find(Boolean);
    return firstGraphic ? `data:image/gif;base64,${firstGraphic}` : null;
  }

  return null;
}

async function buyLabelShipp(
  creds: Record<string, unknown>,
  input: {
    serviceCode: string;
    weightOz: number;
    dimsL: number;
    dimsW: number;
    dimsH: number;
    shipFrom?: any;
    shipTo?: any;
    rawOrder?: any;
    externalOrderId?: string | null;
    orderNumber?: string | null;
  },
): Promise<{
  trackingNumber: string;
  labelUrl: string | null;
  cost: number;
  currency: string;
  shipmentId: string | null;
  carrierCode: string | null;
  carrierName: string | null;
  serviceName: string;
  serviceCode: string;
  selectedRate: any;
  raw: any;
}> {
  const { session, rates } = await quoteShippRates(creds, input);
  const selectedRate = selectShippRate(rates, input.serviceCode);
  const quotedShipmentId = String(selectedRate?.quoted_shipment_id ?? '').trim();
  if (!quotedShipmentId) {
    throw new Error('Shipp selected rate is missing quoted_shipment_id. Please browse rates again.');
  }

  const serviceType = String(selectedRate?.serviceType ?? selectedRate?.serviceName ?? '').trim();
  if (!serviceType) {
    throw new Error('Shipp selected rate is missing serviceType. Please browse rates again.');
  }

  const labelRes = await fetch('https://shipp.to/api/shipping/label/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': session.apiKey,
      Cookie: session.cookieHeader,
    },
    body: JSON.stringify({
      quoted_shipment_id: quotedShipmentId,
      serviceType,
      saturdayDelivery: /saturday/i.test(shippRateServiceName(selectedRate)),
    }),
  });
  const text = await labelRes.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!labelRes.ok) {
    throw new Error(`Shipp label ${labelRes.status}: ${text.slice(0, 800) || labelRes.statusText}`);
  }

  const label = data?.label ?? data;
  const carrierCode = shippCarrierCode(shippRawCarrier(selectedRate));
  const carrierName = shippCarrierName(shippRawCarrier(selectedRate));
  const trackingNumber = shippTrackingFromLabel(label);
  const labelUrl = await shippLabelUrl(label, carrierCode);
  const canonicalServiceCode = shippServiceCodeForRate(selectedRate);

  if (!trackingNumber) {
    throw new Error('Shipp created a label but did not return a tracking number.');
  }
  if (!labelUrl) {
    throw new Error('Shipp created a label but PrepShip could not read the label PDF.');
  }

  return {
    trackingNumber,
    labelUrl,
    cost: Number(selectedRate?.price ?? 0),
    currency: 'USD',
    shipmentId: quotedShipmentId,
    carrierCode,
    carrierName,
    serviceName: shippRateServiceName(selectedRate),
    serviceCode: canonicalServiceCode,
    selectedRate,
    raw: data,
  };
}

async function persistShippShipment(
  sql: any,
  args: {
    body: Record<string, any>;
    provider: string;
    carrierAccountId: number;
    syntheticProviderId: number;
    carrierLabel: string | null;
    result: Awaited<ReturnType<typeof buyLabelShipp>>;
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
    deliveryDays: shippDateDays(args.result.selectedRate?.deliveryDate, args.result.selectedRate?.deliveryDay),
  };

  // Per user override `unlock shipped data` on 2026-05-14: direct Shipp
  // labels never enter ShipStation, so this function persists the canonical
  // PrepShip shipment and advances only currently-awaiting orders to shipped.
  return sql.begin(async (tx: any) => {
    const [order] = await tx`
      SELECT id, client_id, order_number, order_status
      FROM orders
      WHERE id = ${orderId}
      FOR UPDATE
    `;
    if (!order) throw new Error('Order not found');
    if (order.order_status === 'shipped' || order.order_status === 'cancelled') {
      throw new Error(`Cannot create Shipp label for ${order.order_status} order`);
    }

    const [shipment] = await tx`
      INSERT INTO shipments (
        order_id, client_id, order_number,
        carrier_code, service_code, tracking_number,
        ship_date, create_date, weight_oz, dims_l, dims_w, dims_h,
        cost, other_cost, label_url, label_created_at, label_format,
        label_carrier, label_service, label_tracking, label_cost,
        label_ship_date, label_provider, label_shipment_id,
        selected_rate_json, selected_pid, selected_package_id,
        provider_account_id, provider_account_nickname,
        voided, source, is_return, created_at, updated_at
      )
      VALUES (
        ${order.id}, ${order.client_id}, ${order.order_number},
        ${args.result.carrierCode}, ${args.result.serviceCode}, ${args.result.trackingNumber},
        NOW(), NOW(), ${Number(args.body.weightOz ?? 0)}, ${Number(args.body.dimsL ?? args.body.length ?? 0) || null},
        ${Number(args.body.dimsW ?? args.body.width ?? 0) || null}, ${Number(args.body.dimsH ?? args.body.height ?? 0) || null},
        ${args.result.cost.toFixed(2)}, ${'0.00'}, ${args.result.labelUrl}, NOW(), ${args.result.labelUrl?.startsWith('data:application/pdf') ? 'pdf' : 'image'},
        ${args.result.carrierCode}, ${args.result.serviceCode}, ${args.result.trackingNumber}, ${args.result.cost.toFixed(2)},
        NOW(), ${args.syntheticProviderId}, ${null},
        ${sql.json(selectedRateJson)}, ${args.syntheticProviderId}, ${args.body.customPackageId != null ? String(args.body.customPackageId) : null},
        ${args.syntheticProviderId}, ${args.carrierLabel ?? 'Shipp'},
        ${false}, ${'shipp'}, ${false}, NOW(), NOW()
      )
      RETURNING id
    `;

    await tx`
      UPDATE orders
      SET order_status = 'shipped', updated_at = NOW()
      WHERE id = ${order.id}
    `;

    await tx`
      DELETE FROM print_queue_orders
      WHERE order_id = ${String(order.id)}
    `;

    return {
      localShipmentId: shipment.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
    };
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
      const result = await buyLabelShipp(creds, {
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
          shippShipmentId: result.shipmentId,
          selectedServiceCode: result.serviceCode,
        },
      });
      return;
    }

    const shipTo = resolveShipTo(body, rawOrder);
    const shipFrom = resolveShipFrom(creds);

    let result: any = null;
    if (providerKey === 'ups') {
      // UPS service code default: "03" = Ground. Caller can pass
      // serviceCode like "01" (Next Day Air), "02" (2nd Day Air), etc.
      const serviceCode = String(body?.serviceCode ?? '03');
      result = await buyLabelUps(creds, {
        weightOz, dimsL, dimsW, dimsH, serviceCode, shipFrom, shipTo,
      });
    } else if (providerKey === 'easypost') {
      const serviceCode = String(body?.serviceCode ?? 'USPS Priority');
      result = await buyLabelEasyPost(creds, {
        weightOz, dimsL, dimsW, dimsH, serviceCode, shipFrom, shipTo,
      });
    } else {
      res.status(400).json({
        error: `Label purchase for "${provider}" is not implemented yet. Currently supported: ups, easypost, shipp.`,
      });
      return;
    }

    // Persist the shipment row so PrepShip has a record outside the
    // carrier's own dashboard. Lightweight schema — just enough to look
    // up by tracking number and reprint the label later.
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS shipments (
          id SERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          carrier_account_id INTEGER,
          external_order_id TEXT,
          tracking_number TEXT NOT NULL,
          label_url TEXT,
          cost NUMERIC(10,2),
          currency TEXT DEFAULT 'USD',
          weight_oz NUMERIC(10,2),
          dims_l NUMERIC(8,2), dims_w NUMERIC(8,2), dims_h NUMERIC(8,2),
          raw JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await sql`
        INSERT INTO shipments (
          provider, carrier_account_id, external_order_id, tracking_number,
          label_url, cost, currency, weight_oz, dims_l, dims_w, dims_h, raw
        )
        VALUES (
          ${provider}, ${carrierAccountId}, ${externalOrderId},
          ${result.trackingNumber}, ${result.labelUrl}, ${result.cost},
          ${result.currency}, ${weightOz}, ${dimsL}, ${dimsW}, ${dimsH},
          ${result.raw as Record<string, unknown>}
        )
      `;
    } catch (persistErr) {
      console.warn('[carriers/labels] shipments insert failed:',
        persistErr instanceof Error ? persistErr.message : persistErr);
      // Non-fatal — the label itself was purchased successfully.
    }

    res.status(200).json({
      ok: true,
      provider,
      carrierLabel: label,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      labelFormat: provider === 'ups' ? 'GIF' : 'PDF',
      cost: result.cost,
      currency: result.currency,
      shipmentId: result.shipmentId ?? null,
      meta: { externalOrderId, hasRawOrder: rawOrder != null },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carriers/labels]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
