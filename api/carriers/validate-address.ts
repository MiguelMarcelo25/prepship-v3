// @ts-nocheck
// Address validation through the USPS CarrierConnector. Same credentials as
// the USPS rate quoter, so any user who already added USPS as a carrier gets
// address validation without extra signup.
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
import { validateUspsAddress } from '../../src/connectors/carrier/usps.js';
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

    const result = await validateUspsAddress((credentials ?? {}) as Record<string, unknown>, {
      streetAddress,
      secondaryAddress: body?.secondaryAddress ? String(body.secondaryAddress) : undefined,
      city,
      state,
      ZIPCode,
    });
    res.status(200).json(result);
  } catch (err) {
    sendInternalServerError(res, 'carriers/validate-address', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
