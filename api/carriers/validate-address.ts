// @ts-nocheck
// Address validation via USPS's OAuth Address API. Same credentials as
// the USPS rate quoter (consumer key + secret), so any user who already
// added USPS as a carrier gets address validation for free — no extra
// signup needed. Replicates EasyPost's POST /addresses/{id}/verify
// behavior using the underlying USPS source data.
//
// Auth: Supabase JWT.
//
// POST body:
//   {
//     carrierAccountId: number,            // any USPS carrier_account row
//     streetAddress: string,
//     secondaryAddress?: string,           // apt/suite/floor
//     city: string,
//     state: string,
//     ZIPCode: string,
//   }
//
// Response (success): the standardized address + deliverability flag.
// Response (failure): { ok: false, error }.

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../src/lib/auth/verify-supabase-jwt.js';
import { corsHeaders } from '../../src/lib/http/cors.js';
import { sendInternalServerError } from '../_lib/safe-error.js';

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

async function getUspsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const consumerKey = String(creds?.consumerKey ?? creds?.clientId ?? '').trim();
  const consumerSecret = String(creds?.consumerSecret ?? creds?.clientSecret ?? '').trim();
  if (!consumerKey || !consumerSecret) {
    throw new Error('USPS consumerKey + consumerSecret required');
  }
  const res = await fetch('https://api.usps.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: consumerKey,
      client_secret: consumerSecret,
    }),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
    throw new Error(`USPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('USPS OAuth response missing access_token');
  return data.access_token;
}

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'POST, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    console.warn('[validate-address] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    const body = (await readBody(req)) as Record<string, any>;
    const carrierAccountId = Number(body?.carrierAccountId);
    const streetAddress = String(body?.streetAddress ?? '').trim();
    const city = String(body?.city ?? '').trim();
    const state = String(body?.state ?? '').trim();
    const ZIPCode = String(body?.ZIPCode ?? body?.zipCode ?? body?.zip ?? '').trim();
    if (!Number.isFinite(carrierAccountId) || !streetAddress || (!ZIPCode && (!city || !state))) {
      res.status(400).json({
        error: 'carrierAccountId, streetAddress, and either ZIPCode OR (city + state) are required',
      });
      return;
    }

    // Caller can target any USPS-capable carrier_account — we only need
    // valid USPS OAuth credentials. The carrier_account row's provider
    // is "usps" if added via Settings → USPS, but EasyPost rows also
    // have valid creds for USPS-equivalent pricing if EasyPost is the
    // carrier they're shipping with.
    const carrierRows = await sql<Array<{ provider: string; credentials: any }>>`
      SELECT provider, credentials FROM carrier_accounts
      WHERE id = ${carrierAccountId} LIMIT 1
    `;
    if (carrierRows.length === 0) {
      res.status(404).json({ error: `carrier_account ${carrierAccountId} not found` });
      return;
    }
    const { provider, credentials } = carrierRows[0];
    if (provider !== 'usps') {
      res.status(400).json({
        error: `validate-address requires a USPS carrier_account; got "${provider}". Add USPS in Settings to enable address validation.`,
      });
      return;
    }
    const creds = (credentials ?? {}) as Record<string, unknown>;

    const accessToken = await getUspsAccessToken(creds);

    // USPS Addresses v3 API. The address-validation endpoint accepts
    // GET with query params (NOT POST — different from older API
    // versions). Returns the standardized version + DPV (Delivery
    // Point Validation) flags indicating whether USPS thinks mail
    // can actually be delivered to that address.
    const url = new URL('https://api.usps.com/addresses/v3/address');
    url.searchParams.set('streetAddress', streetAddress);
    if (body?.secondaryAddress) url.searchParams.set('secondaryAddress', String(body.secondaryAddress));
    if (city) url.searchParams.set('city', city);
    if (state) url.searchParams.set('state', state);
    if (ZIPCode) url.searchParams.set('ZIPCode', ZIPCode);

    const uspsRes = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const text = await uspsRes.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* leave as text */ }
    if (!uspsRes.ok) {
      const errMsg = data?.error?.message ?? text.slice(0, 600);
      res.status(uspsRes.status).json({
        ok: false,
        error: `USPS Address ${uspsRes.status}: ${errMsg}`,
      });
      return;
    }

    // Map USPS's response to a normalized shape that mirrors EasyPost's
    // verifications.delivery format — easier for the FE to consume the
    // same way regardless of which validator backed the call.
    const addr = data?.address ?? {};
    const additionalInfo = data?.additionalInfo ?? {};
    res.status(200).json({
      ok: true,
      deliverable: additionalInfo?.DPVConfirmation === 'Y' || additionalInfo?.DPVConfirmation === 'D',
      standardized: {
        streetAddress: addr.streetAddress ?? '',
        secondaryAddress: addr.secondaryAddress ?? '',
        city: addr.city ?? '',
        state: addr.state ?? '',
        ZIPCode: addr.ZIPCode ?? '',
        ZIPPlus4: addr.ZIPPlus4 ?? '',
        carrierRoute: addr.carrierRoute ?? null,
      },
      additionalInfo: {
        // DPV (Delivery Point Validation): 'Y' = deliverable, 'N' = not,
        // 'D' = deliverable but with secondary info issues.
        DPVConfirmation: additionalInfo.DPVConfirmation ?? null,
        business: additionalInfo.business ?? null,
        centralDeliveryPoint: additionalInfo.centralDeliveryPoint ?? null,
        vacant: additionalInfo.vacant ?? null,
      },
      raw: data,
    });
  } catch (err) {
    sendInternalServerError(res, 'carriers/validate-address', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
