// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// api/carriers/walmart/fees.ts
//
// Vercel serverless endpoint: pull seller-fee data from Walmart
// Marketplace API for a date range and UPDATE the local orders rows
// with the per-order fee total + breakdown. Powers the Analysis
// page's new "Selling Fees" + "Profit" columns.
//
// Flow:
//   1. Auth: Supabase JWT.
//   2. Look up the Walmart store-accounts credential row.
//   3. Mint a fresh OAuth access token (Walmart tokens live ~15 min).
//   4. Hit Walmart's payment-transactions endpoint for the date
//      range. Walmart returns per-fee-line records (commission,
//      shipping commission, etc.); we aggregate by customerOrderId.
//   5. For each matched local order, UPDATE selling_fee +
//      selling_fee_breakdown + selling_fee_synced_at + source.
//
// Lockdown note: this endpoint UPDATEs shipped/cancelled orders'
// fee columns (fees settle days AFTER delivery, so by the time we
// pull them the order is almost always already shipped). Operator
// typed `unlock shipped data` earlier in the 2026-05-12/13
// conversation that birthed this feature; that override authorizes
// per-order fee writes on shipped data.
//
// POST body:
//   {
//     storeAccountId: number,         // required — store_accounts.id
//     fromDate?: string,              // ISO date; defaults to 30 days ago
//     toDate?: string,                // ISO date; defaults to now
//   }
//
// Response shape (success):
//   {
//     ok: true,
//     fetched: number,        // transactions returned by Walmart
//     ordersUpdated: number,  // local orders matched + UPDATEd
//     ordersMissing: number,  // transactions whose customerOrderId
//                             // didn't match any local order (e.g.
//                             // very old orders pre-PrepShip)
//     totalFeesUsd: number,   // sum of all fees we wrote
//     fromDate: string,
//     toDate: string,
//     fetchedAt: string,
//   }
//
// Response shape (failure):
//   { ok: false, error: string, reason?: string }
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
    try {
      await jwtVerify(token, jwks);
      return { ok: true };
    } catch (err) {
      errors.push(`JWKS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      return { ok: true };
    } catch (err) {
      errors.push(`HS256: ${err instanceof Error ? err.message : String(err)}`);
    }
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

// Mint a fresh Walmart OAuth access token. Same flow as
// api/carriers/walmart/orders.ts — credentials live in store_accounts
// (clientId/clientSecret/channelType). Tokens expire in ~15 min; we
// don't cache here since each invocation is short-lived.
async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are required');
  }
  const channelType = String(creds?.channelType ?? '').trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const correlationId = `prepship-${Date.now().toString(36)}`;
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

// Defensive numeric parser — Walmart returns amounts as strings
// (sometimes negative for deductions, sometimes as objects with
// `amount` + `currency`). Convert whatever we get to a positive
// number representing the DEDUCTION magnitude (we want the fee as
// a positive cost, not as a signed marketplace credit/debit).
function parseFeeAmount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.abs(value) : 0;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }
  if (typeof value === 'object') {
    // Some Walmart responses wrap money values as { amount, currency }
    const amount = (value as { amount?: unknown; value?: unknown }).amount
      ?? (value as { value?: unknown }).value;
    return parseFeeAmount(amount);
  }
  return 0;
}

// Classify a transaction record into one of the four fee buckets we
// track. Walmart uses inconsistent field names across endpoints
// (transactionType vs paymentType vs feeType) — we look at several
// fields and the description to bin reliably.
function classifyFeeBucket(record: Record<string, unknown>): 'commission' | 'shippingCommission' | 'processingFee' | 'other' {
  const type = String(
    record.transactionType
    ?? record.paymentType
    ?? record.feeType
    ?? record.type
    ?? ''
  ).toLowerCase();
  const description = String(record.transactionDescription ?? record.description ?? '').toLowerCase();
  const combined = `${type} ${description}`;

  if (combined.includes('shipping') && combined.includes('commission')) return 'shippingCommission';
  if (combined.includes('shippingcommission')) return 'shippingCommission';
  if (combined.includes('processing') || combined.includes('payment_fee')) return 'processingFee';
  if (combined.includes('commission') || combined.includes('referral')) return 'commission';
  // Sales / payouts aren't fees — caller filters them out separately,
  // but if we get here treat as 'other'.
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

// Fetch one page of Walmart payment transactions. Walmart paginates
// via offset/limit; default limit is 200 (their API max). We page
// until we get a short page back (< limit) or hit a safety cap of
// 100 pages (20k records) — settlement volume shouldn't get near
// that for any single client over a 30-day window in practice.
async function fetchWalmartFeeTransactions(
  accessToken: string,
  fromDate: string,
  toDate: string,
  channelType: string,
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

    // Endpoint shape: Walmart's per-transaction records endpoint.
    // The exact path varies by docs version — we try the modern path
    // first and let the response shape drive parsing.
    const url = new URL('https://marketplace.walmartapis.com/v3/payments');
    url.searchParams.set('fromDate', fromDate);
    url.searchParams.set('toDate', toDate);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const txt = await res.text().then((s) => s.slice(0, 400)).catch(() => '');
      throw new Error(`Walmart /v3/payments ${res.status}: ${txt || res.statusText}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Walmart wraps the response in different shapes depending on
    // the API version. Be defensive: pluck the array from any of the
    // common keys we've seen in their docs.
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

// Walk the transaction list and roll up per-customerOrderId fee
// totals + per-bucket breakdown. Sale/refund records (positive
// payouts to seller) are ignored — we only care about deductions.
function aggregateFeesByOrder(transactions: WalmartTransaction[]): Map<string, { total: number; breakdown: Record<string, number> }> {
  const map = new Map<string, { total: number; breakdown: Record<string, number> }>();
  for (const tx of transactions) {
    const orderId = String(tx.customerOrderId ?? '').trim();
    if (!orderId) continue;

    // Some Walmart responses ship multiple fee fields per record
    // (e.g. commission AND shippingCommission on the same row).
    // Others ship one fee per row identified by transactionType.
    // Handle both: pull every known fee field, then fall back to
    // transactionType+transactionAmount.
    const buckets: Array<{ bucket: 'commission' | 'shippingCommission' | 'processingFee' | 'other'; amount: number }> = [];

    if (tx.commission != null) buckets.push({ bucket: 'commission', amount: parseFeeAmount(tx.commission) });
    if (tx.referralFee != null) buckets.push({ bucket: 'commission', amount: parseFeeAmount(tx.referralFee) });
    if (tx.shippingCommission != null) buckets.push({ bucket: 'shippingCommission', amount: parseFeeAmount(tx.shippingCommission) });
    if (tx.processingFee != null) buckets.push({ bucket: 'processingFee', amount: parseFeeAmount(tx.processingFee) });

    // If none of the per-field shapes matched, fall back to the
    // single transactionAmount + classify by type/description.
    if (buckets.length === 0) {
      const bucket = classifyFeeBucket(tx as Record<string, unknown>);
      // Skip rows that aren't deductions — sales/payouts shouldn't
      // contribute to "fees the marketplace took".
      const type = String(tx.transactionType ?? '').toLowerCase();
      if (type === 'sale' || type === 'payment' || type === 'payout') continue;
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
  // Round everything to 2 decimals for stable storage.
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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    res.status(401).json({ error: 'Invalid token', reason: verified.reason });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }

  const body = (await readBody(req)) as Record<string, unknown>;
  const storeAccountId = body?.storeAccountId != null ? Number(body.storeAccountId) : NaN;
  if (!Number.isFinite(storeAccountId) || storeAccountId <= 0) {
    res.status(400).json({ error: 'storeAccountId is required' });
    return;
  }

  // Default window: last 30 days. Operator can pass explicit dates
  // via fromDate / toDate (ISO yyyy-mm-dd) for a back-fill.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = String(body?.fromDate ?? defaultFrom.toISOString().slice(0, 10));
  const toDate = String(body?.toDate ?? now.toISOString().slice(0, 10));

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 5,
  });

  try {
    // Look up the store account row (credentials + provider check).
    const acctRows = await sql<Array<{ id: number; provider: string; credentials: Record<string, unknown> | null }>>`
      SELECT id, provider, credentials
      FROM store_accounts
      WHERE id = ${storeAccountId}
      LIMIT 1
    `;
    if (acctRows.length === 0) {
      res.status(404).json({ error: `store_account #${storeAccountId} not found` });
      return;
    }
    const acct = acctRows[0];
    if (acct.provider !== 'walmart') {
      res.status(400).json({
        error: `store_account #${storeAccountId} provider is "${acct.provider}", expected "walmart"`,
      });
      return;
    }
    const creds = acct.credentials ?? {};
    const channelType = String((creds as { channelType?: unknown }).channelType ?? '').trim();

    // Mint a fresh Walmart token + fetch the transaction page(s).
    const accessToken = await getWalmartAccessToken(creds);
    const { transactions, fetchedCount } = await fetchWalmartFeeTransactions(
      accessToken,
      fromDate,
      toDate,
      channelType,
    );

    // Aggregate to per-customerOrderId fee totals.
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
        note: 'No fee-bearing transactions found in window',
      });
      return;
    }

    // Pull the orders that match — we update by exact equality on
    // either order_number (the PrepShip-side display) or
    // external_order_id (the marketplace's id, which is what Walmart
    // sends back as customerOrderId).
    const matched = await sql<Array<{ id: number; key: string }>>`
      SELECT id,
             coalesce(external_order_id, order_number) AS key
      FROM orders
      WHERE (external_order_id = ANY (${customerOrderIds}::text[]))
         OR (order_number = ANY (${customerOrderIds}::text[]))
    `;

    // Per-order UPDATE — wrap in a transaction so partial failures
    // don't leave the FE seeing a half-applied sync.
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
