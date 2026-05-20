// @ts-nocheck
// One-click admin endpoint: fix the order_date stored UTC offset for
// orders / store_orders rows pulled by the direct marketplace pullers
// (Walmart, eBay) which were storing real UTC timestamps before the
// PT-clockface-stamped-Z fix landed.
//
// The conversion mirrors the puller's runtime behavior, applied directly
// in Postgres against existing rows:
//   timestamptz UTC moment
//     → AT TIME ZONE 'America/Los_Angeles'  (drops to PT clock face)
//     → AT TIME ZONE 'UTC'                  (re-stamps as if UTC)
// Result: the FE's UTC-mode renderer (kept for ShipStation parity) now
// displays the row at the correct PT clock time, matching the
// "Walmart - DJC" entries pulled via the legacy SS pipeline.
//
// Idempotency note: this endpoint shifts each row's order_date by the
// PT/UTC offset (7 or 8 hours depending on DST). Running it twice would
// double-shift. The endpoint only operates on rows whose store_id is in
// the synthetic ranges issued by api/store-accounts.ts (Walmart 9_000_000
// range, eBay 9_500_000 range) — these are the only rows the pullers ever
// touch, so the SS-derived "Walmart - DJC" rows are never affected.
//
// Auth: Supabase JWT, same as the other admin/data endpoints.
//
// Once verified working in production, this file can be deleted — future
// pulls already store correct timestamps via the puller-side fix.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
import { sendInternalServerError } from '../_lib/safe-error.js';

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

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    // Fallback: allow ?token=<jwt> in URL so the user can hit this from the
    // browser address bar without DevTools. They can grab their token via
    // localStorage on prepship-eta.vercel.app if they know how, or just
    // open this URL via a small helper page that injects it. For now the
    // simpler path is the bookmarklet pattern in the README of this fix.
    const url = new URL(req.url ?? '/', `https://${req.headers?.host ?? 'localhost'}`);
    const queryToken = url.searchParams.get('token') ?? '';
    if (!queryToken) { res.status(401).json({ error: 'Missing Authorization' }); return; }
    const verified = await verifySupabaseJwt(queryToken);
    if (!verified.ok) { res.status(401).json({ error: 'Invalid token' }); return; }
  } else {
    const verified = await verifySupabaseJwt(token);
    if (!verified.ok) { res.status(401).json({ error: 'Invalid token' }); return; }
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    // Walmart (synthetic store_ids 9_000_000–9_099_999).
    const ordersWalmart = await sql`
      UPDATE orders
      SET order_date = (order_date AT TIME ZONE 'America/Los_Angeles')::timestamp
                        AT TIME ZONE 'UTC'
      WHERE store_id BETWEEN 9000000 AND 9099999
        AND order_date IS NOT NULL
      RETURNING id
    `;
    const storeOrdersWalmart = await sql`
      UPDATE store_orders
      SET order_date = (order_date AT TIME ZONE 'America/Los_Angeles')::timestamp
                        AT TIME ZONE 'UTC'
      WHERE provider = 'walmart'
        AND order_date IS NOT NULL
      RETURNING id
    `;
    // eBay (synthetic store_ids 9_500_000–9_599_999).
    const ordersEbay = await sql`
      UPDATE orders
      SET order_date = (order_date AT TIME ZONE 'America/Los_Angeles')::timestamp
                        AT TIME ZONE 'UTC'
      WHERE store_id BETWEEN 9500000 AND 9599999
        AND order_date IS NOT NULL
      RETURNING id
    `;
    const storeOrdersEbay = await sql`
      UPDATE store_orders
      SET order_date = (order_date AT TIME ZONE 'America/Los_Angeles')::timestamp
                        AT TIME ZONE 'UTC'
      WHERE provider = 'ebay'
        AND order_date IS NOT NULL
      RETURNING id
    `;

    res.status(200).json({
      ok: true,
      walmart: { orders: ordersWalmart.length, store_orders: storeOrdersWalmart.length },
      ebay: { orders: ordersEbay.length, store_orders: storeOrdersEbay.length },
      note: 'Order_date timestamps shifted from raw-UTC to PT-clockface-stamped-Z so the FE displays them at the correct Pacific time, matching ShipStation-derived rows. This endpoint is one-shot — running it twice will double-shift the timestamps. Disable it once verified.',
    });
  } catch (err) {
    sendInternalServerError(res, 'admin/fix-marketplace-timestamps', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
