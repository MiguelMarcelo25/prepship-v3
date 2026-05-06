// @ts-nocheck
// Vercel serverless function: CRUD for the carrier_accounts table.
// Bootstraps the table on first call so we don't need a separate migration
// step. Same shape as src/db/schema/carrier-accounts.ts so a future move
// back to the Render backend is a noop.
//
// Endpoints (all under the same path, dispatched on req.method):
//   GET  /api/carrier-accounts            → list (filterable by source/pending)
//   POST /api/carrier-accounts            → upsert by (clientId, provider, accountIdentifier)
//
// Auth: Supabase JWT in Authorization: Bearer <token>.

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

const TABLE = 'carrier_accounts';

// Provider validation: lowercase slug pattern instead of an explicit list.
// This used to be a hardcoded Set that drifted out of sync with verify.ts's
// VERIFIERS map every time a new carrier was added — bug #lessonlearned.
// The pattern accepts any future provider key without an edit here. The
// verifier endpoint (api/carriers/verify.ts) is the single source of truth
// for which providers can actually be tested; unknown providers there fall
// through to a clean "not yet implemented" response.
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const ALLOWED_SOURCES = new Set(['admin', 'portal']);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = new Set([
    'https://prepship.vercel.app',
    'https://prepship-eta.vercel.app',
    'http://localhost:5173',
  ]);
  const allow = origin && allowed.has(origin) ? origin : '';
  const headers: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

let tableEnsured = false;

async function ensureTable(sql: ReturnType<typeof postgres>): Promise<void> {
  if (tableEnsured) return;
  // One statement per call — multi-statement raw SQL is unreliable through
  // pgbouncer in transaction-pool mode. ENABLE ROW LEVEL SECURITY keeps
  // Supabase's anon/authenticated REST keys out of this table — credentials
  // must never be readable by frontend client SDKs. Our Vercel functions
  // use the postgres superuser (DATABASE_URL), which bypasses RLS.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      provider TEXT NOT NULL,
      label TEXT,
      account_identifier TEXT,
      credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'admin',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS carrier_accounts_client_provider_account_idx
      ON ${TABLE} (
        COALESCE(client_id, -1),
        provider,
        COALESCE(account_identifier, '')
      )`,
    `ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`,
  ];
  for (const stmt of stmts) {
    try {
      await sql.unsafe(stmt);
    } catch (err) {
      console.warn(
        '[carrier-accounts] bootstrap statement failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  tableEnsured = true;
}

interface JwtPayload {
  sub?: string;
  email?: string;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

function readBody(req: any): Promise<unknown> {
  // Vercel runtimes vary in how they expose the body — sometimes a parsed
  // object, sometimes the raw string, sometimes neither. Handle each case.
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.resolve({});
      }
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Auth gate
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

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    res.status(500).json({ error: 'DATABASE_URL not configured' });
    return;
  }
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 5,
  });

  try {
    await ensureTable(sql);

    if (req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://x');
      const source = url.searchParams.get('source');
      const pending = url.searchParams.get('pending');
      // pending=1 means "source=portal AND not yet linked into the markup
      // table" — for now just filters by source since we don't have a
      // reviewed_at column. Tightening can come later.
      const wantSource = source && ALLOWED_SOURCES.has(source) ? source : null;
      const rows = wantSource
        ? await sql<Array<Record<string, unknown>>>`
            SELECT id, client_id AS "clientId", provider, label, account_identifier AS "accountIdentifier",
                   source, active, created_at AS "createdAt"
            FROM ${sql(TABLE)}
            WHERE source = ${wantSource}
            ORDER BY created_at DESC
            LIMIT 200
          `
        : await sql<Array<Record<string, unknown>>>`
            SELECT id, client_id AS "clientId", provider, label, account_identifier AS "accountIdentifier",
                   source, active, created_at AS "createdAt"
            FROM ${sql(TABLE)}
            ORDER BY created_at DESC
            LIMIT 200
          `;
      res.status(200).json({ data: rows, pending: pending === '1' });
      return;
    }

    if (req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const provider = String(body?.provider ?? '').toLowerCase();
      const label = body?.label != null ? String(body.label).slice(0, 200) : null;
      const accountIdentifier = body?.accountIdentifier != null ? String(body.accountIdentifier).slice(0, 200) : null;
      const credentials = body?.credentials && typeof body.credentials === 'object' ? body.credentials : {};
      const source = ALLOWED_SOURCES.has(String(body?.source ?? '')) ? String(body.source) : 'admin';
      const clientId = body?.clientId != null && Number.isFinite(Number(body.clientId)) ? Number(body.clientId) : null;

      // Diagnostic: log key shape (never values) so a bad save can be traced
      // without dumping secrets. Drop a row that arrives with no credential
      // keys at all — the prior 4/30 Walmart row landed in that empty state
      // and there's no legitimate flow that should produce one.
      const credKeys = Object.keys(credentials).sort();
      console.log('[carrier-accounts:POST]', JSON.stringify({
        provider,
        accountIdentifier: accountIdentifier ? `${String(accountIdentifier).slice(0, 8)}…` : null,
        credentialKeys: credKeys,
        bodyKeys: Object.keys(body ?? {}).sort(),
        bodyType: typeof body,
        source,
      }));

      if (!PROVIDER_PATTERN.test(provider)) {
        res.status(400).json({ error: `Invalid provider slug: ${provider}` });
        return;
      }
      if (!accountIdentifier) {
        res.status(400).json({ error: 'accountIdentifier is required' });
        return;
      }
      if (credKeys.length === 0) {
        res.status(400).json({
          error: 'No credential fields received. Make sure all required fields are filled in before saving.',
          meta: { bodyKeys: Object.keys(body ?? {}).sort() },
        });
        return;
      }

      // Upsert on the natural key. ON CONFLICT updates label/credentials so
      // re-submitting the same account from the portal vs admin merges.
      // postgres.js auto-stringifies plain objects for jsonb columns; passing
      // the object directly (rather than JSON.stringify + ::jsonb cast) is
      // the library's documented happy path and avoids a class of cast bugs.
      const inserted = await sql<Array<Record<string, unknown>>>`
        INSERT INTO ${sql(TABLE)} (client_id, provider, label, account_identifier, credentials, source)
        VALUES (${clientId}, ${provider}, ${label}, ${accountIdentifier}, ${credentials as Record<string, unknown>}, ${source})
        ON CONFLICT (COALESCE(client_id, -1), provider, COALESCE(account_identifier, ''))
        DO UPDATE SET
          label = EXCLUDED.label,
          credentials = EXCLUDED.credentials,
          updated_at = NOW()
        RETURNING id, client_id AS "clientId", provider, label, account_identifier AS "accountIdentifier",
                  source, active, created_at AS "createdAt"
      `;

      // Post-insert verification — log what actually landed in JSONB so a
      // future "credentials saved empty" bug doesn't require a code dive.
      try {
        const verifyRow = await sql<Array<{ credentials: unknown }>>`
          SELECT credentials FROM ${sql(TABLE)} WHERE id = ${inserted[0]?.id as number}
        `;
        const stored = verifyRow[0]?.credentials;
        const storedKeys = stored && typeof stored === 'object' && !Array.isArray(stored)
          ? Object.keys(stored as Record<string, unknown>).sort()
          : [];
        console.log('[carrier-accounts:POST] post-insert', JSON.stringify({
          rowId: inserted[0]?.id ?? null,
          storedCredentialKeys: storedKeys,
          storedType: typeof stored,
        }));
      } catch (vErr) {
        console.warn('[carrier-accounts:POST] post-insert verify failed:', vErr instanceof Error ? vErr.message : vErr);
      }

      res.status(200).json({ data: inserted[0] ?? null });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url ?? '', 'http://x');
      const idStr = url.searchParams.get('id');
      const id = idStr != null ? Number(idStr) : NaN;
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'id query parameter is required' });
        return;
      }
      const deleted = await sql<Array<{ id: number }>>`
        DELETE FROM ${sql(TABLE)}
        WHERE id = ${id}
        RETURNING id
      `;
      if (deleted.length === 0) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }
      res.status(200).json({ data: { id: deleted[0].id, deleted: true } });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carrier-accounts]', msg);
    res.status(500).json({ error: msg });
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
