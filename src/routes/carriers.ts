import { Hono } from 'hono';
import postgres from 'postgres';
import verifyCarrierHandler from '../lib/imported-handlers/carriers-verify';
import walmartOrdersHandler from '../lib/imported-handlers/walmart-orders';
import ebayOrdersHandler from '../lib/imported-handlers/ebay-orders';
import shopifyOrdersHandler from '../lib/imported-handlers/shopify-orders';
import { runNodeHandler } from '../lib/node-handler';
import { requirePermission } from '../middleware/auth';
import { fullServiceCatalog } from '../lib/carrier-service-catalog';
import { probeCarrierAccountRates } from '../services/carrier-rates-probe';
import { syncWalmartFeesForAccount } from '../connectors/store/walmart-fees';
import { buildEbayAuthorizeUrl } from '../connectors/store/ebay';
import { env } from '../lib/env';

const app = new Hono();

app.all('/verify', requirePermission('credentials:write'), runNodeHandler(verifyCarrierHandler));

// PS-189: account→service availability is backend-owned. The FE service picker
// reads this catalog instead of keeping its own CARRIER_SERVICES copy (which
// also auto-defaulted usps_media_mail — a restricted service — on account
// switch). Static, read-only.
app.get('/service-catalog', (c) => c.json({ catalog: fullServiceCatalog() }));

// ── PS-200 S2: carrier ops cut over from the legacy Vercel functions ────────

// Settings "test rates" probe for one account — raw provider prices, no
// order context, no markups. Order-bound quoting stays owned by the rates
// services (PS-199/PS-203).
app.post('/rates', requirePermission('credentials:read'), async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const result = await probeCarrierAccountRates({
    carrierAccountId: body?.carrierAccountId != null ? Number(body.carrierAccountId) : null,
    storeAccountId: body?.storeAccountId != null ? Number(body.storeAccountId) : null,
    weightOz: body?.weightOz != null ? Number(body.weightOz) : null,
    toZip: typeof body?.toZip === 'string' ? body.toZip : null,
    fromZip: typeof body?.fromZip === 'string' ? body.fromZip : null,
    dimsL: body?.dimsL != null ? Number(body.dimsL) : null,
    dimsW: body?.dimsW != null ? Number(body.dimsW) : null,
    dimsH: body?.dimsH != null ? Number(body.dimsH) : null,
  });
  // Provider failures return HTTP 200 with ok:false — the FE branches on the
  // body (legacy contract), not the status code.
  return c.json(result);
});

// Marketplace order pulls (Settings → Pull Orders). store_orders is the
// PS-199 resolver's CACHE — these refresh it; the live lookup stays the owner.
app.all('/walmart/orders', requirePermission('settings:write'), runNodeHandler(walmartOrdersHandler));
app.all('/ebay/orders', requirePermission('settings:write'), runNodeHandler(ebayOrdersHandler));
app.all('/shopify/orders', requirePermission('settings:write'), runNodeHandler(shopifyOrdersHandler));

// Walmart selling-fee pull. The provider logic already lives in
// src/connectors/store/walmart-fees.ts (the legacy function was a thin
// wrapper over the same module) — this route replaces only the HTTP entry.
app.post('/walmart/fees', requirePermission('settings:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const storeAccountId = body?.storeAccountId != null ? Number(body.storeAccountId) : NaN;
  if (!Number.isFinite(storeAccountId) || storeAccountId <= 0) {
    return c.json({ error: 'storeAccountId is required' }, 400);
  }
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = String(body?.fromDate ?? defaultFrom.toISOString().slice(0, 10));
  const toDate = String(body?.toDate ?? now.toISOString().slice(0, 10));
  // Same short-lived client shape the legacy function used — the fees sync
  // takes a postgres client argument rather than the drizzle handle.
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  try {
    const result = await syncWalmartFeesForAccount(sql, storeAccountId, fromDate, toDate);
    return c.json({ ...result, fetchedAt: new Date().toISOString() }, result.ok ? 200 : 400);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
});

// eBay OAuth "Connect" — build the consent URL for an eBay Shipping carrier account so the
// operator can grant the sell.logistics scope WITHOUT hand-copying a refresh token. eBay redirects
// to the RuName's accept URL (api/oauth/ebay/callback), which exchanges the code and saves the
// refresh token back to THIS carrier account — the `state` param carries the carrier id.
app.get('/ebay/connect', requirePermission('credentials:write'), async (c) => {
  const carrierAccountId = Number(c.req.query('carrierAccountId'));
  if (!Number.isFinite(carrierAccountId) || carrierAccountId <= 0) {
    return c.json({ error: 'carrierAccountId is required' }, 400);
  }
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  try {
    const rows = await sql<Array<{ id: number; provider: string; credentials: Record<string, unknown> }>>`
      SELECT id, provider, credentials FROM carrier_accounts WHERE id = ${carrierAccountId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return c.json({ error: `carrier_accounts #${carrierAccountId} not found` }, 404);
    if (String(row.provider) !== 'ebay_shipping') {
      return c.json({ error: 'eBay Connect is only for eBay Shipping carrier accounts' }, 400);
    }
    const creds = (row.credentials && typeof row.credentials === 'object' ? row.credentials : {}) as Record<string, unknown>;
    const appId = String(creds.appId ?? creds.app_id ?? '').trim();
    const ruName = String(creds.ruName ?? creds.runame ?? '').trim();
    if (!appId) return c.json({ error: 'Save the eBay App ID on this carrier first, then Connect.' }, 400);
    if (!ruName) return c.json({ error: 'Save the eBay RuName on this carrier first, then Connect.' }, 400);
    // Provider endpoints + scopes live in the eBay connector (PS-032 boundary); this route just
    // supplies the account's appId/ruName and the state that ties the callback back here.
    const url = buildEbayAuthorizeUrl({
      appId,
      ruName,
      state: `carrier-${row.id}`,
      environment: typeof creds.environment === 'string' ? creds.environment : null,
    });
    return c.json({ url });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
});

export default app;
