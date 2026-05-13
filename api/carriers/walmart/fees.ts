// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// api/carriers/walmart/fees.ts
//
// Vercel serverless endpoint: user-triggered Walmart selling-fee
// pull. Powers the "Pull Fees" button in Settings → Carriers on
// each Walmart store row.
//
// Self-contained inline implementation (2026-05-13 revert). A
// previous version imported the core logic from
// api/_lib/walmart-fees-sync.ts but that bundle path produced
// FUNCTION_INVOCATION_FAILED at cold-start on Vercel — module-load
// failures, not runtime errors, surface as that error code. Rather
// than chase a bundler heuristic, this file owns its own copy of
// the fetch + classify + aggregate + UPDATE logic. The nightly
// cron + operator backfill script still use the shared helper —
// they were deployed at the same time and are easier to re-verify
// independently.
//
// Auth: Supabase JWT.
//
// POST body:
//   { storeAccountId: number, fromDate?: string, toDate?: string }
//
// Response (success):
//   { ok: true, fetched, ordersUpdated, ordersMissing, totalFeesUsd,
//     fromDate, toDate, fetchedAt, note? }
// Response (failure):
//   { ok: false, error: string }
// ──────────────────────────────────────────────────────────────────

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

// Mint a fresh Walmart OAuth token. Tokens expire ~15 min; we
// don't cache here since the function is short-lived.
async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Walmart credentials missing clientId or clientSecret');
  }
  const channelType = String(creds?.channelType ?? '').trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const correlationId = `prepship-fees-${Date.now().toString(36)}`;
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

// Defensive money parser — Walmart varies between strings,
// negatives, and { amount, currency } object shapes.
function parseFeeAmount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.abs(value) : 0;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }
  if (typeof value === 'object') {
    const amount = (value as { amount?: unknown; value?: unknown }).amount
      ?? (value as { value?: unknown }).value;
    return parseFeeAmount(amount);
  }
  return 0;
}

type FeeBucket = 'commission' | 'shippingCommission' | 'processingFee' | 'other';
function classifyFeeBucket(record: Record<string, unknown>): FeeBucket {
  const type = String(
    record.transactionType ?? record.paymentType ?? record.feeType ?? record.type ?? ''
  ).toLowerCase();
  const description = String(record.transactionDescription ?? record.description ?? '').toLowerCase();
  const combined = `${type} ${description}`;
  if (combined.includes('shipping') && combined.includes('commission')) return 'shippingCommission';
  if (combined.includes('shippingcommission')) return 'shippingCommission';
  if (combined.includes('processing') || combined.includes('payment_fee')) return 'processingFee';
  if (combined.includes('commission') || combined.includes('referral')) return 'commission';
  return 'other';
}

interface WalmartTransaction {
  customerOrderId?: string;
  transactionType?: string;
  transactionAmount?: unknown;
  transactionDescription?: string;
  commission?: unknown;
  referralFee?: unknown;
  shippingCommission?: unknown;
  processingFee?: unknown;
}

// Walmart's payments API has multiple endpoint paths that have
// shifted over years of API revisions. We try them in order of
// preferred granularity (transactionRecords gives per-fee detail;
// the legacy /v3/payments gives daily summaries). If the gateway
// returns 401 on ALL paths, the seller's developer app probably
// hasn't been granted the Payments / Finance API permission —
// surface a tailored error in that case.
const WALMART_FEES_ENDPOINT_PATHS = [
  '/v3/payments/transactionRecords',
  '/v3/payments',
];

async function fetchWalmartFeeTransactions(
  accessToken: string,
  fromDate: string,
  toDate: string,
  channelType: string,
): Promise<{ transactions: WalmartTransaction[]; fetchedCount: number; endpointUsed: string }> {
  const errors: Array<{ path: string; status: number; body: string }> = [];
  for (const path of WALMART_FEES_ENDPOINT_PATHS) {
    try {
      const result = await fetchOneEndpoint(accessToken, fromDate, toDate, channelType, path);
      return { ...result, endpointUsed: path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Capture the error and try the next path. Parse status from
      // the message if possible so we can decide whether to keep
      // trying (5xx, 401 → try next) or stop (400 → operator-side).
      const statusMatch = msg.match(/\b(\d{3})\b/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      errors.push({ path, status, body: msg });
      // Only retry on 401 / 404 / 5xx — those might be path-specific.
      // 400 with an invalid param applies to all paths equally.
      if (status === 400) {
        throw friendlyWalmartFeeError(errors);
      }
    }
  }
  // All paths failed.
  throw friendlyWalmartFeeError(errors);
}

// Convert Walmart's nest of error JSON + path-attempts into a
// short, operator-actionable message. The previous version threw
// the raw response which became a wall of JSON in the UI — this
// extracts the diagnosis and adds remediation steps.
function friendlyWalmartFeeError(errors: Array<{ path: string; status: number; body: string }>): Error {
  // If every attempt was a 401 / gateway unauthorized, this is a
  // permissions issue on the developer app, not bad credentials.
  // (Bad creds would have failed at the OAuth /v3/token step earlier.)
  const all401 = errors.length > 0 && errors.every((e) => e.status === 401);
  if (all401) {
    return new Error(
      'Walmart Payments API is not enabled on this seller account. '
      + 'The OAuth token works for /v3/orders (which is why "Pull Orders" succeeds) '
      + 'but the gateway rejects it for /v3/payments. Fix: go to '
      + 'developer.walmart.com → My Apps → API Permissions, enable '
      + '"Payments" / "Finance API" permissions on the developer app, save, '
      + 'and re-try in ~5 minutes (permission propagation lag).',
    );
  }
  const last = errors[errors.length - 1];
  if (!last) return new Error('Walmart fees endpoint returned no response');
  return new Error(`Walmart fees endpoint ${last.path} ${last.status}: ${last.body.slice(0, 300)}`);
}

async function fetchOneEndpoint(
  accessToken: string,
  fromDate: string,
  toDate: string,
  channelType: string,
  path: string,
): Promise<{ transactions: WalmartTransaction[]; fetchedCount: number }> {
  const transactions: WalmartTransaction[] = [];
  const PAGE_LIMIT = 200;
  let offset = 0;
  let safety = 0;
  while (safety < 100) {
    safety += 1;
    const correlationId = `prepship-fees-${Date.now().toString(36)}-${safety}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'WM_QOS.CORRELATION_ID': correlationId,
      'WM_SVC.NAME': 'Walmart Marketplace',
    };
    if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
    const url = new URL(`https://marketplace.walmartapis.com${path}`);
    url.searchParams.set('fromDate', fromDate);
    url.searchParams.set('toDate', toDate);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const txt = await res.text().then((s) => s.slice(0, 400)).catch(() => '');
      throw new Error(`Walmart ${path} ${res.status}: ${txt || res.statusText}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const records =
      ((data?.paymentTransactionsResponse as { transactions?: WalmartTransaction[] })?.transactions)
      ?? ((data?.elements as { transactions?: WalmartTransaction[] })?.transactions)
      ?? ((data as { transactions?: WalmartTransaction[] }).transactions)
      ?? ((data as { paymentRecords?: WalmartTransaction[] }).paymentRecords)
      ?? [];
    if (!Array.isArray(records) || records.length === 0) break;
    transactions.push(...records);
    if (records.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return { transactions, fetchedCount: transactions.length };
}

function aggregateFeesByOrder(transactions: WalmartTransaction[]): Map<string, { total: number; breakdown: Record<string, number> }> {
  const map = new Map<string, { total: number; breakdown: Record<string, number> }>();
  for (const tx of transactions) {
    const orderId = String(tx.customerOrderId ?? '').trim();
    if (!orderId) continue;
    const buckets: Array<{ bucket: FeeBucket; amount: number }> = [];
    if (tx.commission != null) buckets.push({ bucket: 'commission', amount: parseFeeAmount(tx.commission) });
    if (tx.referralFee != null) buckets.push({ bucket: 'commission', amount: parseFeeAmount(tx.referralFee) });
    if (tx.shippingCommission != null) buckets.push({ bucket: 'shippingCommission', amount: parseFeeAmount(tx.shippingCommission) });
    if (tx.processingFee != null) buckets.push({ bucket: 'processingFee', amount: parseFeeAmount(tx.processingFee) });
    if (buckets.length === 0) {
      const type = String(tx.transactionType ?? '').toLowerCase();
      if (type === 'sale' || type === 'payment' || type === 'payout') continue;
      const bucket = classifyFeeBucket(tx as Record<string, unknown>);
      const amount = parseFeeAmount(tx.transactionAmount);
      if (amount > 0) buckets.push({ bucket, amount });
    }
    for (const { bucket, amount } of buckets) {
      if (amount <= 0) continue;
      let entry = map.get(orderId);
      if (!entry) {
        entry = { total: 0, breakdown: {} };
        map.set(orderId, entry);
      }
      entry.total += amount;
      entry.breakdown[bucket] = (entry.breakdown[bucket] ?? 0) + amount;
    }
  }
  for (const v of map.values()) {
    v.total = Math.round(v.total * 100) / 100;
    for (const k of Object.keys(v.breakdown)) {
      v.breakdown[k] = Math.round(v.breakdown[k] * 100) / 100;
    }
  }
  return map;
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
  const storeAccountId = body?.storeAccountId != null ? Number(body.storeAccountId) : NaN;
  if (!Number.isFinite(storeAccountId) || storeAccountId <= 0) {
    res.status(400).json({ error: 'storeAccountId is required' });
    return;
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = String(body?.fromDate ?? defaultFrom.toISOString().slice(0, 10));
  const toDate = String(body?.toDate ?? now.toISOString().slice(0, 10));

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    // Self-heal schema columns (idempotent).
    try {
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee NUMERIC(10, 2) NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_synced_at TIMESTAMPTZ`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_source TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS orders_selling_fee_source_idx ON orders (selling_fee_source) WHERE selling_fee_source IS NOT NULL`;
    } catch (err) {
      console.warn('[walmart/fees] column bootstrap failed:', err instanceof Error ? err.message : err);
    }

    const acctRows = await sql<Array<{ id: number; provider: string; credentials: Record<string, unknown> | null }>>`
      SELECT id, provider, credentials
      FROM store_accounts
      WHERE id = ${storeAccountId}
      LIMIT 1
    `;
    if (acctRows.length === 0) {
      res.status(404).json({ ok: false, error: `store_account #${storeAccountId} not found` });
      return;
    }
    const acct = acctRows[0];
    if (acct.provider !== 'walmart') {
      res.status(400).json({
        ok: false,
        error: `store_account #${storeAccountId} provider is "${acct.provider}", expected "walmart"`,
      });
      return;
    }
    const creds = acct.credentials ?? {};
    const channelType = String((creds as { channelType?: unknown }).channelType ?? '').trim();

    const accessToken = await getWalmartAccessToken(creds);
    const { transactions, fetchedCount } = await fetchWalmartFeeTransactions(
      accessToken,
      fromDate,
      toDate,
      channelType,
    );

    const feeMap = aggregateFeesByOrder(transactions);
    const customerOrderIds = Array.from(feeMap.keys());

    if (customerOrderIds.length === 0) {
      res.status(200).json({
        ok: true,
        fetched: fetchedCount,
        ordersUpdated: 0,
        ordersMissing: 0,
        totalFeesUsd: 0,
        fromDate,
        toDate,
        fetchedAt: new Date().toISOString(),
        note: 'No fee-bearing transactions in window',
      });
      return;
    }

    const matched = await sql<Array<{ id: number; key: string }>>`
      SELECT id,
             coalesce(external_order_id, order_number) AS key
      FROM orders
      WHERE (external_order_id = ANY (${customerOrderIds}::text[]))
         OR (order_number = ANY (${customerOrderIds}::text[]))
    `;

    let totalFees = 0;
    let updated = 0;
    await sql.begin(async (trx) => {
      for (const row of matched) {
        const entry = feeMap.get(row.key);
        if (!entry) continue;
        totalFees += entry.total;
        await trx`
          UPDATE orders
          SET selling_fee = ${entry.total},
              selling_fee_breakdown = ${entry.breakdown as Record<string, number>}::jsonb,
              selling_fee_synced_at = NOW(),
              selling_fee_source = 'walmart',
              updated_at = NOW()
          WHERE id = ${row.id}
        `;
        updated += 1;
      }
    });

    res.status(200).json({
      ok: true,
      fetched: fetchedCount,
      ordersUpdated: updated,
      ordersMissing: Math.max(customerOrderIds.length - updated, 0),
      totalFeesUsd: Math.round(totalFees * 100) / 100,
      fromDate,
      toDate,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[walmart/fees]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
