// @ts-nocheck
// Vercel-cron endpoint: nightly Walmart selling-fee sync.
// Provider API access is owned by src/connectors/store/walmart-fees.ts.

import postgres from 'postgres';
import { sendInternalServerError } from '../_lib/safe-error.js';
import { syncWalmartFeesAllAccounts } from '../_lib/walmart-fees-sync.js';

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
    const accountResults = await syncWalmartFeesAllAccounts(sql, fromDate, toDate);
    const totals = { fetched: 0, ordersUpdated: 0, ordersMissing: 0, totalFeesUsd: 0, errors: 0 };
    for (const r of accountResults) {
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
      accountsProcessed: accountResults.length,
      totals,
      accountResults,
    });
  } catch (err) {
    sendInternalServerError(res, 'cron/sync-walmart-fees', err);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
