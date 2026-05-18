// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// api/cron/sync-walmart-fees.ts
//
// Vercel-cron endpoint: nightly Walmart selling-fee sync. Iterates
// every active Walmart store_account and pulls a rolling 14-day
// window of fees. Schedule + cron-secret pairing live in vercel.json.
//
// Self-contained inline implementation (2026-05-13 revert). See
// the matching comment in api/carriers/walmart/fees.ts — the
// previous version imported from api/_lib/walmart-fees-sync.ts but
// that bundle path caused FUNCTION_INVOCATION_FAILED on cold-start.
// Inlining is safer until we've validated a better sharing path.
// The CLI backfill (scripts/backfill-walmart-fees.ts) still uses
// the shared helper since tsx has no such bundling issue.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Vercel sets this
// header automatically on cron-triggered requests when CRON_SECRET
// is configured in env. Manual operator triggers via curl with the
// same header work too.
// ──────────────────────────────────────────────────────────────────

import postgres from 'postgres';

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = new Set([
    'https://prepship.vercel.app',
    'https://prepshipv4.vercel.app',
  ]);
  const allow = origin && allowed.has(origin) ? origin : '';
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

// ── Walmart fees sync — inlined copy ──────────────────────────────
// Same shape as api/carriers/walmart/fees.ts's inline functions. If
// behavior needs to change, change BOTH copies; ../../_lib bundling
// proved unreliable. The CLI backfill still imports from the lib.

async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Walmart credentials missing clientId or clientSecret');
  }
  const channelType = String(creds?.channelType ?? '').trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'WM_QOS.CORRELATION_ID': `prepship-cron-${Date.now().toString(36)}`,
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
  const type = String(record.transactionType ?? record.paymentType ?? record.feeType ?? record.type ?? '').toLowerCase();
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

// Multiple endpoint paths Walmart has used for fees over time.
// Try them in order; if all 401, the developer-app permissions
// likely need updating. See matching comment in
// api/carriers/walmart/fees.ts.
const WALMART_FEES_ENDPOINT_PATHS = [
  '/v3/payments/transactionRecords',
  '/v3/payments',
];

async function fetchWalmartFeeTransactions(
  accessToken: string,
  fromDate: string,
  toDate: string,
  channelType: string,
): Promise<{ transactions: WalmartTransaction[]; fetchedCount: number }> {
  const errors: Array<{ path: string; status: number; body: string }> = [];
  for (const path of WALMART_FEES_ENDPOINT_PATHS) {
    try {
      return await fetchOneEndpoint(accessToken, fromDate, toDate, channelType, path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = msg.match(/\b(\d{3})\b/);
      const status = m ? Number(m[1]) : 0;
      errors.push({ path, status, body: msg });
      if (status === 400) break;
    }
  }
  const all401 = errors.length > 0 && errors.every((e) => e.status === 401);
  if (all401) {
    throw new Error(
      'Walmart Payments API is not enabled on this seller account. '
      + 'Fix: developer.walmart.com → My Apps → API Permissions, '
      + 'enable "Payments" / "Finance API", save, retry in ~5 minutes.',
    );
  }
  const last = errors[errors.length - 1];
  throw new Error(last ? `Walmart fees endpoint ${last.path} ${last.status}: ${last.body.slice(0, 300)}` : 'Walmart fees endpoint returned no response');
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'WM_QOS.CORRELATION_ID': `prepship-cron-${Date.now().toString(36)}-${safety}`,
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
      if (!entry) { entry = { total: 0, breakdown: {} }; map.set(orderId, entry); }
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

async function syncOneAccount(
  sql: ReturnType<typeof postgres>,
  storeAccountId: number,
  fromDate: string,
  toDate: string,
): Promise<{ ok: boolean; fetched?: number; ordersUpdated?: number; ordersMissing?: number; totalFeesUsd?: number; error?: string; note?: string }> {
  try {
    const acctRows = await sql<Array<{ id: number; provider: string; credentials: Record<string, unknown> | null }>>`
      SELECT id, provider, credentials FROM store_accounts WHERE id = ${storeAccountId} LIMIT 1
    `;
    if (acctRows.length === 0) return { ok: false, error: `store_account #${storeAccountId} not found` };
    const acct = acctRows[0];
    if (acct.provider !== 'walmart') {
      return { ok: false, error: `store_account #${storeAccountId} provider is "${acct.provider}", expected "walmart"` };
    }
    const creds = acct.credentials ?? {};
    const channelType = String((creds as { channelType?: unknown }).channelType ?? '').trim();
    const accessToken = await getWalmartAccessToken(creds);
    const { transactions, fetchedCount } = await fetchWalmartFeeTransactions(accessToken, fromDate, toDate, channelType);
    const feeMap = aggregateFeesByOrder(transactions);
    const customerOrderIds = Array.from(feeMap.keys());
    if (customerOrderIds.length === 0) {
      return { ok: true, fetched: fetchedCount, ordersUpdated: 0, ordersMissing: 0, totalFeesUsd: 0, note: 'No fee-bearing transactions in window' };
    }
    const matched = await sql<Array<{ id: number; key: string }>>`
      SELECT id, coalesce(external_order_id, order_number) AS key
      FROM orders
      WHERE (external_order_id = ANY (${customerOrderIds}::text[]))
         OR (order_number = ANY (${customerOrderIds}::text[]))
    `;
    let totalFees = 0; let updated = 0;
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
    return {
      ok: true,
      fetched: fetchedCount,
      ordersUpdated: updated,
      ordersMissing: Math.max(customerOrderIds.length - updated, 0),
      totalFeesUsd: Math.round(totalFees * 100) / 100,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/sync-walmart-fees]', `account=${storeAccountId}`, msg);
    return { ok: false, error: msg };
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'CRON_SECRET not configured' });
    return;
  }
  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== expected) {
    res.status(401).json({ error: 'Invalid cron secret' });
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    res.status(500).json({ error: 'DATABASE_URL not configured' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://x');
  const daysParam = Number(url.searchParams.get('days') ?? 14);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 14;
  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 10 });
  try {
    // Self-heal schema columns (idempotent). The supporting index is migration-owned.
    try {
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee NUMERIC(10, 2) NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_synced_at TIMESTAMPTZ`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_source TEXT`;
    } catch (err) {
      console.warn('[cron/sync-walmart-fees] column bootstrap failed:', err instanceof Error ? err.message : err);
    }

    const accounts = await sql<Array<{ id: number; label: string | null }>>`
      SELECT id, label FROM store_accounts
      WHERE provider = 'walmart' AND coalesce(active, true) = true
      ORDER BY id
    `;

    const accountResults: Array<{ storeAccountId: number; storeAccountLabel: string | null; [k: string]: unknown }> = [];
    const totals = { fetched: 0, ordersUpdated: 0, ordersMissing: 0, totalFeesUsd: 0, errors: 0 };
    for (const acct of accounts) {
      const r = await syncOneAccount(sql, acct.id, fromDate, toDate);
      accountResults.push({ storeAccountId: acct.id, storeAccountLabel: acct.label, ...r });
      if (r.ok) {
        totals.fetched += r.fetched ?? 0;
        totals.ordersUpdated += r.ordersUpdated ?? 0;
        totals.ordersMissing += r.ordersMissing ?? 0;
        totals.totalFeesUsd += r.totalFeesUsd ?? 0;
      } else {
        totals.errors += 1;
      }
    }
    totals.totalFeesUsd = Math.round(totals.totalFeesUsd * 100) / 100;

    res.status(200).json({
      ok: true,
      ranAt: new Date().toISOString(),
      windowDays: days,
      fromDate,
      toDate,
      accountsProcessed: accounts.length,
      totals,
      accountResults,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/sync-walmart-fees]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
