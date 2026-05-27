// @ts-nocheck
// Diagnostic: probes Walmart Shipping API carrier access through the Walmart
// Shipping CarrierConnector. This confirms whether the seller developer app
// has SHIPPING API permission without touching orders, labels, or rates.
//
// Auth: Supabase JWT, same as other diagnostic endpoints.
// Body: { carrierAccountId: number } - the saved walmart_shipping
// carrier_account row whose credentials we should test against.

import postgres from 'postgres';
import { probeWalmartShippingCarriers } from '../../../src/connectors/carrier/walmart-shipping.js';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../../src/lib/auth/verify-supabase-jwt.js';
import { corsHeaders } from '../../../src/lib/http/cors.js';
import { sendInternalServerError } from '../../_lib/safe-error.js';

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
    res.status(405).json({ error: 'POST only - body { carrierAccountId }' });
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

    const result = await probeWalmartShippingCarriers((row.credentials ?? {}) as Record<string, unknown>);
    res.status(200).json(result);
  } catch (err) {
    sendInternalServerError(res, 'walmart-probe-carriers', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
