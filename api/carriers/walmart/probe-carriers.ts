// @ts-nocheck
// Diagnostic: hits Walmart's `GET /v3/shipping/labels/carriers` directly to
// confirm whether the seller's developer app has SHIPPING API permission —
// independent of any order data, dims, weights, or rate calculation. This
// is step 1 in Walmart's official integration testing checklist (per the
// boss's handoff doc Nov 2025). If this returns data, the app has Shipping
// scope and the 500 on /shipping-estimates is request-shape or
// ship-from-mismatch related. If this returns 401/403, the seller's app
// is missing the Shipping API permission and no shipping endpoint will
// ever work for them.
//
// Auth: Supabase JWT, same as other diagnostic endpoints.
// Body: { carrierAccountId: number }  — the saved walmart_shipping
//   carrier_account row whose credentials we should test against.

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../../src/lib/auth/verify-supabase-jwt';
import { corsHeaders } from '../../../src/lib/http/cors';

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

async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Walmart probe-carriers requires clientId + clientSecret on the carrier_account credentials');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'WM_QOS.CORRELATION_ID': `prepship-probe-${Date.now().toString(36)}`,
      'WM_SVC.NAME': 'Walmart Marketplace',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`Walmart token ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('Walmart token response missing access_token');
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
    res.status(405).json({ error: 'POST only — body { carrierAccountId }' });
    return;
  }

  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    console.warn('[walmart-probe-carriers] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    const body = (await readBody(req)) as Record<string, unknown>;
    const carrierAccountId = Number(body?.carrierAccountId);
    if (!Number.isFinite(carrierAccountId)) {
      res.status(400).json({ error: 'carrierAccountId is required (number)' });
      return;
    }

    const rows = await sql<Array<{ provider: string; credentials: any }>>`
      SELECT provider, credentials FROM carrier_accounts
      WHERE id = ${carrierAccountId} LIMIT 1
    `;
    if (rows.length === 0) {
      res.status(404).json({ error: `carrier_account ${carrierAccountId} not found` });
      return;
    }
    const row = rows[0];
    if (row.provider !== 'walmart_shipping' && row.provider !== 'walmart') {
      res.status(400).json({ error: `carrier_account ${carrierAccountId} provider is "${row.provider}", expected walmart or walmart_shipping` });
      return;
    }
    const creds = (row.credentials ?? {}) as Record<string, unknown>;

    // Step A: prove OAuth token works (Marketplace API access).
    const accessToken = await getWalmartAccessToken(creds);

    // Step B: probe Shipping API access via /v3/shipping/labels/carriers.
    const correlationId = `prepship-probe-${Date.now().toString(36)}`;
    const partnerId = String(creds?.partnerId ?? creds?.sellerId ?? '').trim();
    const channelType = String(creds?.channelType ?? '').trim();
    const headers: Record<string, string> = {
      'WM_SEC.ACCESS_TOKEN': accessToken,
      'WM_QOS.CORRELATION_ID': correlationId,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_MARKET': 'us',
      Accept: 'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;
    if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;

    const carriersRes = await fetch(
      'https://marketplace.walmartapis.com/v3/shipping/labels/carriers',
      { method: 'GET', headers },
    );
    const carriersText = await carriersRes.text().catch(() => '');
    let carriersJson: any = null;
    try { carriersJson = JSON.parse(carriersText); } catch { /* leave as text */ }

    res.status(200).json({
      ok: carriersRes.ok,
      step_a_oauth: 'success',
      step_b_carriers_endpoint: {
        status: carriersRes.status,
        ok: carriersRes.ok,
        body: carriersJson ?? carriersText.slice(0, 1500),
      },
      correlationId,
      interpretation: carriersRes.ok
        ? 'OAuth + Shipping API access both working. The remaining 500 on /shipping-estimates is request-shape or ship-from-mismatch related.'
        : `Shipping API returned ${carriersRes.status}. If 401/403 → the developer app is missing Shipping API permission (developer.walmart.com → My Apps → API Permissions). If 500 → seller account isn't enrolled in Walmart Shipping Solutions. Either way, the issue is on Walmart's side, not in our request.`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
