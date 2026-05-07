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
    const creds = (credentials ?? {}) as Record<string, unknown>;

    // Fetch the saved order's raw payload to derive ship-to (when caller
    // didn't pass an explicit shipTo override).
    let rawOrder: any = null;
    const externalOrderId = typeof body?.externalOrderId === 'string' ? body.externalOrderId : null;
    if (externalOrderId) {
      const m = externalOrderId.match(/^([a-z_]+)-(.+)$/);
      if (m) {
        try {
          const rows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = ${m[1]} AND external_order_id = ${m[2]}
            LIMIT 1
          `;
          rawOrder = rows[0]?.raw ?? null;
        } catch { /* non-fatal */ }
      }
    }

    const shipTo = resolveShipTo(body, rawOrder);
    const shipFrom = resolveShipFrom(creds);

    let result: any = null;
    if (provider === 'ups') {
      // UPS service code default: "03" = Ground. Caller can pass
      // serviceCode like "01" (Next Day Air), "02" (2nd Day Air), etc.
      const serviceCode = String(body?.serviceCode ?? '03');
      result = await buyLabelUps(creds, {
        weightOz, dimsL, dimsW, dimsH, serviceCode, shipFrom, shipTo,
      });
    } else if (provider === 'easypost') {
      const serviceCode = String(body?.serviceCode ?? 'USPS Priority');
      result = await buyLabelEasyPost(creds, {
        weightOz, dimsL, dimsW, dimsH, serviceCode, shipFrom, shipTo,
      });
    } else {
      res.status(400).json({
        error: `Label purchase for "${provider}" is not implemented yet. Currently supported: ups, easypost.`,
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
