// @ts-nocheck
// Vercel serverless function: multi-account ShipStation carrier fan-out.
// Lives alongside the SPA build; Vercel's filesystem matching makes it win
// over the catch-all /api/* rewrite to Render in vercel.json.
//
// Reads three sources of ShipStation V2 credentials and tags each returned
// carrier with the account it came from so the Settings UI can group:
//   1. SHIPSTATION_API_KEY_V2          → "DR PREPPER"
//   2. SHIPSTATION_KFG_API_KEY_V2      → "KFG"
//   3. clients.ssApiKeyV2 in Postgres  → client.name (per-client header)
//
// Auth: requires a Supabase JWT in Authorization: Bearer <token>. Verified
// against SUPABASE_JWT_SECRET. Same gate as the Render API uses.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';

// Supabase project uses ES256 asymmetric keys; verify via JWKS first and
// fall back to HS256 with the legacy shared secret.
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

interface SsCarrier {
  carrier_id: string;
  carrier_code: string;
  nickname?: string;
  friendly_name?: string;
  services?: unknown[];
}

interface TaggedCarrier extends SsCarrier {
  source_client_name: string;
  source_client_id: number | null;
}

const SHIPSTATION_BASE = 'https://api.shipengine.com/v2';
const SHIPSTATION_TIMEOUT_MS = 8_000;

interface FetchResult {
  carriers: SsCarrier[];
  error: string | null;
  status: number | null;
}

function publicCarrierFetchError(result: FetchResult): string | null {
  if (!result.error) return null;
  if (result.status) return `ShipStation carrier request failed (${result.status})`;
  return 'ShipStation carrier request failed';
}

async function fetchSsCarriers(apiKeyV2: string): Promise<FetchResult> {
  if (!apiKeyV2) return { carriers: [], error: 'no key configured', status: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SHIPSTATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHIPSTATION_BASE}/carriers`, {
      headers: { 'API-Key': apiKeyV2, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      return { carriers: [], error: `ShipStation ${res.status}: ${body || res.statusText}`, status: res.status };
    }
    const data = (await res.json()) as { carriers?: SsCarrier[] };
    return {
      carriers: Array.isArray(data?.carriers) ? data.carriers : [],
      error: null,
      status: res.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { carriers: [], error: msg, status: null };
  } finally {
    clearTimeout(timer);
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = new Set([
    'https://prepship.vercel.app',
    'https://prepship-eta.vercel.app',
    'http://localhost:5173',
  ]);
  const allow = origin && allowed.has(origin) ? origin : '';
  const headers: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth: verify Supabase JWT
  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization' });
    return;
  }
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    res.status(500).json({ error: 'Server misconfigured (no JWT secret)' });
    return;
  }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    res.status(401).json({ error: 'Invalid token', reason: verified.reason });
    return;
  }

  // Fan out to ShipStation accounts in parallel. Dedupe by literal key value
  // so an env var that matches a DB row's ss_api_key_v2 doesn't get fetched
  // twice and surface the same carriers under two headers.
  interface Task {
    source: string;
    sourceId: number | null;
    keySource: string;
    keyValue: string;
    p: Promise<FetchResult>;
  }
  const tasks: Task[] = [];
  const seenKeys = new Set<string>();
  const queueTask = (t: Omit<Task, 'p'>) => {
    if (!t.keyValue) return;
    if (seenKeys.has(t.keyValue)) return;
    seenKeys.add(t.keyValue);
    tasks.push({ ...t, p: fetchSsCarriers(t.keyValue) });
  };

  queueTask({
    source: 'DR PREPPER',
    sourceId: null,
    keySource: 'env.SHIPSTATION_API_KEY_V2',
    keyValue: process.env.SHIPSTATION_API_KEY_V2 ?? '',
  });
  queueTask({
    source: 'KFG',
    sourceId: null,
    keySource: 'env.SHIPSTATION_KFG_API_KEY_V2',
    keyValue: process.env.SHIPSTATION_KFG_API_KEY_V2 ?? '',
  });

  // Per-client creds from DB (best-effort — failures don't fail the request).
  const diagnostics: Array<{ source: string; keySource: string; status: number | null; count: number; error: string | null }> = [];
  let dbError: string | null = null;
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const sql = postgres(dbUrl, {
        max: 1,
        prepare: false,
        idle_timeout: 5,
        connect_timeout: 5,
      });
      const rows = await sql<Array<{ id: number; name: string; ss_api_key_v2: string | null }>>`
        SELECT id, name, ss_api_key_v2
        FROM clients
        WHERE ss_api_key_v2 IS NOT NULL
          AND active = true
      `;
      await sql.end({ timeout: 1 });
      for (const c of rows) {
        if (c.ss_api_key_v2) {
          queueTask({
            source: c.name,
            sourceId: c.id,
            keySource: `clients.ss_api_key_v2 (id=${c.id})`,
            keyValue: c.ss_api_key_v2,
          });
        }
      }
    } catch (err) {
      dbError = (err as Error)?.message ?? String(err);
      console.error('[multi-carriers] db fan-out failed:', dbError);
    }
  } else {
    dbError = 'DATABASE_URL not configured';
  }

  const results = await Promise.all(tasks.map((t) => t.p));
  const aggregated: TaggedCarrier[] = [];
  const seenByAccount = new Set<string>();
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    const r = results[i];
    diagnostics.push({
      source: t.source,
      keySource: t.keySource,
      status: r.status,
      count: r.carriers.length,
      error: publicCarrierFetchError(r),
    });
    for (const c of r.carriers) {
      const key = `${t.source}:${c.carrier_id}`;
      if (seenByAccount.has(key)) continue;
      seenByAccount.add(key);
      aggregated.push({ ...c, source_client_name: t.source, source_client_id: t.sourceId });
    }
  }

  res.status(200).json({
    carriers: aggregated,
    _diagnostics: {
      dbError: dbError ? 'Client carrier credential lookup failed' : null,
      sources: diagnostics,
    },
  });
}
