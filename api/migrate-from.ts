// @ts-nocheck
// One-shot data migration helper. Connects to a source Postgres (OLD
// Supabase project) and copies rows into the project's own database
// (NEW, via DATABASE_URL env var) — for the tables the caller asks for.
// Idempotent: ON CONFLICT (id) DO NOTHING means re-running is safe.
//
// Auth: Supabase JWT (so anonymous internet can't trigger arbitrary DB
// reads against any URL).
//
// POST body:
//   { sourceUrl: string,
//     tables?: string[]  // defaults to ['store_accounts','carrier_accounts','store_orders']
//   }
// Response:
//   { ok: true, results: [{ table, sourceRows, copied, error? }, ...] }
//
// Remove this file after the migration is complete.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
import { errorMessage, sendInternalServerError } from './_lib/safe-error.js';

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

const ALLOWED_TABLES = new Set([
  'store_accounts',
  'carrier_accounts',
  'store_orders',
  'clients',
  'inventory',
  'orders',
  'order_overrides',
]);

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth: only signed-in PrepShip users can run this — no anonymous-internet
  // access to the migration endpoint, even though it's not destructive
  // against the destination DB.
  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token' }); return; }

  const body = (await readBody(req)) as Record<string, unknown>;
  const sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl : '';
  if (!sourceUrl.startsWith('postgresql://') && !sourceUrl.startsWith('postgres://')) {
    res.status(400).json({ error: 'sourceUrl must be a postgresql:// connection string' });
    return;
  }
  const requestedTables = Array.isArray(body?.tables) && body.tables.length > 0
    ? (body.tables as string[]).filter((t) => ALLOWED_TABLES.has(t))
    : ['store_accounts', 'carrier_accounts', 'store_orders'];

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured (destination)' }); return; }

  const source = postgres(sourceUrl, {
    max: 2, prepare: false, idle_timeout: 5, connect_timeout: 10,
    ssl: 'require',
  });
  const dest = postgres(dbUrl, {
    max: 2, prepare: false, idle_timeout: 5, connect_timeout: 10,
  });

  const results: Array<{ table: string; sourceRows?: number; copied?: number; error?: string }> = [];
  try {
    for (const table of requestedTables) {
      try {
        // Read columns that exist on BOTH source and dest. The intersection
        // is what we copy — a column on source but not dest is dropped;
        // a column on dest but not source is left at its default.
        const [srcCols, dstCols] = await Promise.all([
          source<Array<{ column_name: string }>>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${table}
          `,
          dest<Array<{ column_name: string }>>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${table}
          `,
        ]);
        const srcSet = new Set(srcCols.map((r) => r.column_name));
        const dstSet = new Set(dstCols.map((r) => r.column_name));
        const sharedCols = [...srcSet].filter((c) => dstSet.has(c));
        if (sharedCols.length === 0) {
          results.push({ table, error: 'no shared columns between source and destination' });
          continue;
        }

        // Read all rows from source. Limit to 5000 per table for safety;
        // bump if needed.
        const rows = await source.unsafe(
          `SELECT ${sharedCols.map((c) => `"${c}"`).join(',')} FROM "${table}" LIMIT 5000`,
        );
        if (rows.length === 0) {
          results.push({ table, sourceRows: 0, copied: 0 });
          continue;
        }

        // Insert into dest with ON CONFLICT DO NOTHING. order_overrides
        // uses order_id as PK; everything else uses id.
        const conflictKey = table === 'order_overrides' ? 'order_id' : 'id';
        const colList = sharedCols.map((c) => `"${c}"`).join(',');

        let copied = 0;
        // Insert in batches of 100 to keep statements small.
        const BATCH = 100;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          // Build values placeholder string $1,$2,... per batch row.
          const placeholders = batch
            .map((_, rowIdx) =>
              `(${sharedCols.map((__, colIdx) => `$${rowIdx * sharedCols.length + colIdx + 1}`).join(',')})`,
            )
            .join(',');
          const params: any[] = [];
          for (const row of batch) {
            for (const col of sharedCols) {
              params.push(row[col]);
            }
          }
          const result = await dest.unsafe(
            `INSERT INTO "${table}" (${colList}) VALUES ${placeholders}
             ON CONFLICT ("${conflictKey}") DO NOTHING`,
            params,
          );
          copied += result.count ?? 0;
        }

        // Bump SERIAL sequence past the imported max id so future
        // auto-generated ids don't collide. Only relevant for tables
        // whose PK is `id` and is SERIAL.
        if (conflictKey === 'id') {
          try {
            await dest.unsafe(
              `SELECT setval('${table}_id_seq',
                COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1,
                false)`,
            );
          } catch { /* table may not have a SERIAL or the sequence may be named differently — non-fatal */ }
        }

        results.push({ table, sourceRows: rows.length, copied });
      } catch (tableErr) {
        console.error(`[migrate-from] ${table} copy failed:`, errorMessage(tableErr));
        results.push({ table, error: 'table copy failed' });
      }
    }
    res.status(200).json({ ok: true, results });
  } catch (err) {
    sendInternalServerError(res, 'migrate-from', err);
  } finally {
    try { await source.end({ timeout: 1 }); } catch { /* ignore */ }
    try { await dest.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
