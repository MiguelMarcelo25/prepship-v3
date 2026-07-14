// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// Reusable core for the Walmart selling-fee sync flow. Extracted
// 2026-05-13 so every entry point shares one implementation. PS-200 S3
// consumers: the v4 "Pull Fees" route (src/routes/carriers.ts), the
// daily worker tick (src/services/sync-scheduler.ts runWalmartFeesTick
// — replaced the legacy Vercel cron), the legacy Vercel route
// (api/carriers/walmart/fees.ts via the api/_lib re-export shim, until
// PS-200 S8 deletes it), and the operator backfill script
// (scripts/backfill-walmart-fees.ts). Without this split, the entry
// points would inevitably drift out of sync on the next change.
//
// The helper takes a postgres client + store-account id + date
// window and does the full cycle:
//   1. Verify migration-owned selling_fee schema.
//   2. Read store-account credentials.
//   3. Mint a Walmart OAuth token.
//   4. Page through /v3/payments for the window, defensively
//      parsing whatever shape Walmart returns.
//   5. Aggregate fees per customerOrderId.
//   6. Match local orders + UPDATE selling_fee / breakdown /
//      synced_at / source inside a single transaction.
//   7. Return a structured result the caller can render or log.
//
// Caller responsibilities:
//   - Open + close the postgres connection. Helper does NOT
//     end() the client (callers may want to run multiple syncs
//     on the same connection).
//   - Auth gate. Helper trusts the caller has authenticated.
//   - Iteration over multiple store_accounts when needed.
// ──────────────────────────────────────────────────────────────────

import type postgres from 'postgres';

export interface WalmartFeesSyncResult {
  ok: true;
  fetched: number;
  ordersUpdated: number;
  ordersMissing: number;
  totalFeesUsd: number;
  fromDate: string;
  toDate: string;
  note?: string;
}

export interface WalmartFeesSyncError {
  ok: false;
  error: string;
}

export type WalmartFeesSyncOutcome = WalmartFeesSyncResult | WalmartFeesSyncError;

// Migration 0019 owns settled-fee columns. Readiness blocks sync when schema
// is incomplete.
async function ensureSellingFeeColumns(_sql: ReturnType<typeof postgres>): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0019 owns
  // selling-fee columns; sync verifies readiness before settled-fee updates.
  const { assertRuntimeSchemaReady } = await import('../../services/runtime-schema-readiness.js');
  await assertRuntimeSchemaReady();
}

// ── OAuth: mint a fresh Walmart access token ───────────────────────
// Tokens expire in ~15 minutes — we don't cache here since the
// caller is typically a short-lived function. Walmart's basic-auth
// pattern: clientId:clientSecret base64-encoded, swapped for an
// access_token via client_credentials grant.
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

// ── Defensive numeric parser ──────────────────────────────────────
// Walmart returns amounts as strings (sometimes negative for
// deductions, sometimes as { amount, currency } objects). Convert
// to a positive number representing the DEDUCTION magnitude.
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

// ── Fee classifier ────────────────────────────────────────────────
// Walmart uses inconsistent field names across endpoints
// (transactionType vs paymentType vs feeType). Look at several
// fields + description to bin reliably.
type FeeBucket = 'commission' | 'shippingCommission' | 'processingFee' | 'other';
function classifyFeeBucket(record: Record<string, unknown>): FeeBucket {
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

// ── Paginated fetch of Walmart payment transactions ───────────────
// PAGE_LIMIT = 200 (Walmart's API max). Page until we get a short
// page back or hit a safety cap of 100 pages (20k records) — far
// beyond a normal client's 30-day settlement volume.
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
    // Defensive shape extraction — Walmart wraps in different keys
    // across docs versions.
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

// ── Aggregate fees per customerOrderId ────────────────────────────
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
      // Skip non-fee transactions (sales/payouts).
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
  // Round to 2 decimals for stable storage.
  for (const v of map.values()) {
    v.total = Math.round(v.total * 100) / 100;
    for (const k of Object.keys(v.breakdown)) {
      v.breakdown[k] = Math.round(v.breakdown[k] * 100) / 100;
    }
  }
  return map;
}

// ── Main entry point ──────────────────────────────────────────────
// Run a full Walmart fees sync for one store account over a date
// window. Returns a structured result (success or error).
export async function syncWalmartFeesForAccount(
  sql: ReturnType<typeof postgres>,
  storeAccountId: number,
  fromDate: string,
  toDate: string,
): Promise<WalmartFeesSyncOutcome> {
  try {
    await ensureSellingFeeColumns(sql);

    // Read the store-account credentials.
    const acctRows = await sql<Array<{ id: number; provider: string; credentials: Record<string, unknown> | null }>>`
      SELECT id, provider, credentials
      FROM store_accounts
      WHERE id = ${storeAccountId}
      LIMIT 1
    `;
    if (acctRows.length === 0) {
      return { ok: false, error: `store_account #${storeAccountId} not found` };
    }
    const acct = acctRows[0];
    if (acct.provider !== 'walmart') {
      return {
        ok: false,
        error: `store_account #${storeAccountId} provider is "${acct.provider}", expected "walmart"`,
      };
    }
    const creds = acct.credentials ?? {};
    const channelType = String((creds as { channelType?: unknown }).channelType ?? '').trim();

    // Mint token + paginate fees.
    const accessToken = await getWalmartAccessToken(creds);
    const { transactions, fetchedCount } = await fetchWalmartFeeTransactions(
      accessToken,
      fromDate,
      toDate,
      channelType,
    );

    // Aggregate by customerOrderId.
    const feeMap = aggregateFeesByOrder(transactions);
    const customerOrderIds = Array.from(feeMap.keys());

    if (customerOrderIds.length === 0) {
      return {
        ok: true,
        fetched: fetchedCount,
        ordersUpdated: 0,
        ordersMissing: 0,
        totalFeesUsd: 0,
        fromDate,
        toDate,
        note: 'No fee-bearing transactions in window',
      };
    }

    // Match local orders by external_order_id OR order_number.
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

    return {
      ok: true,
      fetched: fetchedCount,
      ordersUpdated: updated,
      ordersMissing: Math.max(customerOrderIds.length - updated, 0),
      totalFeesUsd: Math.round(totalFees * 100) / 100,
      fromDate,
      toDate,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[walmart-fees-sync]', `account=${storeAccountId}`, msg);
    return { ok: false, error: msg };
  }
}

// ── Multi-account convenience ─────────────────────────────────────
// Iterate every active Walmart store account and run the sync for
// each. Used by the nightly cron + backfill script. Sequential
// (not parallel) so we don't fan-out OAuth + a wave of /v3/payments
// hits — Walmart has per-seller rate limits and being polite costs
// us nothing (the cron runs once a day).
export async function syncWalmartFeesAllAccounts(
  sql: ReturnType<typeof postgres>,
  fromDate: string,
  toDate: string,
): Promise<Array<WalmartFeesSyncOutcome & { storeAccountId: number; storeAccountLabel: string | null }>> {
  await ensureSellingFeeColumns(sql);
  const accounts = await sql<Array<{ id: number; label: string | null }>>`
    SELECT id, label
    FROM store_accounts
    WHERE provider = 'walmart'
      AND coalesce(active, true) = true
    ORDER BY id
  `;
  const results: Array<WalmartFeesSyncOutcome & { storeAccountId: number; storeAccountLabel: string | null }> = [];
  for (const acct of accounts) {
    const r = await syncWalmartFeesForAccount(sql, acct.id, fromDate, toDate);
    results.push({ ...r, storeAccountId: acct.id, storeAccountLabel: acct.label });
  }
  return results;
}
