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
import { timedFetch } from '../../src/lib/http/timing.js';
import { persistDirectCarrierLabel } from '../../src/services/direct-label-persistence.js';

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
  const statements = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_provider TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_account_id TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_order_id TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_order_number TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_status TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS canonical_status TEXT`,
    `CREATE INDEX IF NOT EXISTS orders_source_provider_idx ON orders (source_provider)`,
    `CREATE INDEX IF NOT EXISTS orders_canonical_status_idx ON orders (canonical_status)`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_provider TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_account_id TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS label_provider_key TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_status TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_provider TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_last_error TEXT`,
    `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS marketplace_confirmed_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS shipments_confirmation_status_idx ON shipments (confirmation_status)`,
    `CREATE TABLE IF NOT EXISTS fulfillment_outbox (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      shipment_id INTEGER,
      event_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_outbox_dedupe_idx ON fulfillment_outbox (dedupe_key)`,
    `CREATE INDEX IF NOT EXISTS fulfillment_outbox_due_idx ON fulfillment_outbox (status, next_run_at)`,
  ];
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
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
async function getUpsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) throw new Error('UPS clientId + clientSecret required');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await timedFetch('api.carriers.labels.external', 'https://onlinetools.ups.com/security/v1/oauth/token', {
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

  const res = await timedFetch('api.carriers.labels.external', 'https://onlinetools.ups.com/api/shipments/v2403/ship', {
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
  const createRes = await timedFetch('api.carriers.labels.external', 'https://api.easypost.com/v2/shipments', {
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
  const buyRes = await timedFetch('api.carriers.labels.external', `https://api.easypost.com/v2/shipments/${shipment.id}/buy`, {
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
    const res = await timedFetch('api.carriers.labels.external', `https://api.zippopotam.us/us/${five}`, {
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

  const res = await timedFetch('api.carriers.labels.external', 'https://shipp.to/api/supabase/login', {
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

  const res = await timedFetch('api.carriers.labels.external', 'https://shipp.to/api/shipping/quote', {
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

  const labelRes = await timedFetch('api.carriers.labels.external', 'https://shipp.to/api/shipping/label/create', {
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
      result = await buyLabelUps(creds, {
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
      result = await buyLabelEasyPost(creds, {
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
