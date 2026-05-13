// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// api/cron/sync-walmart-fees.ts
//
// Vercel-cron endpoint: nightly Walmart selling-fee sync. Runs the
// shared sync helper for every active Walmart store_account.
// Schedule + cron-secret pairing live in vercel.json.
//
// Why on Vercel (not Render): the existing Walmart fees fetcher
// (api/carriers/walmart/fees.ts) is a Vercel function. Keeping the
// cron co-located + sharing the helper at api/_lib/walmart-fees-sync.ts
// means one runtime, one log stream, one auth shape.
//
// Auth: Vercel cron-triggered requests carry the
//   Authorization: Bearer ${CRON_SECRET}
// header automatically when CRON_SECRET is set in env. We verify
// against process.env.CRON_SECRET. This means the route is reachable
// by anyone who knows the secret — which is fine for an internal
// cron, but the route is read-mostly (one INSERT/UPDATE-like effect
// per orders row) so accidental triggering is harmless.
//
// Default window: last 14 days. Walmart settlement lags delivery by
// 3-7 days, so 14 days catches: any settlements published since the
// last cron run (~24 hours), plus retroactive adjustments to recent
// orders. Operator can override with ?days=N query param.
//
// Response shape:
//   {
//     ok: true,
//     ranAt: ISO,
//     accountsProcessed: number,
//     totals: { fetched, ordersUpdated, ordersMissing, totalFeesUsd },
//     accountResults: [{ storeAccountId, storeAccountLabel, ... }]
//   }
// ──────────────────────────────────────────────────────────────────

import postgres from 'postgres';
import { syncWalmartFeesAllAccounts } from '../_lib/walmart-fees-sync';

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

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    // Vercel cron fires GET by default. POST supported so a manual
    // operator trigger via curl (with the secret) works too.
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth — Vercel cron sets Authorization: Bearer ${CRON_SECRET}
  // automatically when CRON_SECRET is configured in env.
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

  // Default 14-day window — captures both recent settlements +
  // retroactive adjustments to orders that already had fee data.
  // Operator can override via ?days=N for a wider sweep.
  const url = new URL(req.url ?? '/', 'http://x');
  const daysParam = Number(url.searchParams.get('days') ?? 14);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 14;
  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 10 });
  try {
    const accountResults = await syncWalmartFeesAllAccounts(sql, fromDate, toDate);
    const totals = accountResults.reduce(
      (acc, r) => {
        if (r.ok) {
          acc.fetched += r.fetched ?? 0;
          acc.ordersUpdated += r.ordersUpdated ?? 0;
          acc.ordersMissing += r.ordersMissing ?? 0;
          acc.totalFeesUsd += r.totalFeesUsd ?? 0;
        } else {
          acc.errors += 1;
        }
        return acc;
      },
      { fetched: 0, ordersUpdated: 0, ordersMissing: 0, totalFeesUsd: 0, errors: 0 },
    );
    totals.totalFeesUsd = Math.round(totals.totalFeesUsd * 100) / 100;

    res.status(200).json({
      ok: true,
      ranAt: new Date().toISOString(),
      windowDays: days,
      fromDate,
      toDate,
      accountsProcessed: accountResults.length,
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
