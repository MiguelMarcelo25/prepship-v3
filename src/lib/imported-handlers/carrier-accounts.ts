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

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../auth/verify-supabase-jwt';
import {
  ALLOWED_ACCOUNT_SOURCES,
  CREDENTIAL_PROVIDER_PATTERN,
  normalizeCredentialAccountBody,
  readJsonRequestBody,
} from '../credential-accounts';
import { corsHeaders } from '../http/cors';
import {
  deleteCredentialAccount,
  listCredentialAccounts,
  normalizeAssignedClientIds,
  replaceCarrierAccountClientAssignments,
  upsertCredentialAccount,
} from '../../services/credential-accounts';

const TABLE = 'carrier_accounts';

// Provider validation: lowercase slug pattern instead of an explicit list.
// This used to be a hardcoded Set that drifted out of sync with verify.ts's
// VERIFIERS map every time a new carrier was added — bug #lessonlearned.
// The pattern accepts any future provider key without an edit here. The
// verifier endpoint (api/carriers/verify.ts) is the single source of truth
// for which providers can actually be tested; unknown providers there fall
// through to a clean "not yet implemented" response.
let tableEnsured = false;

async function ensureTable(sql: ReturnType<typeof postgres>): Promise<void> {
  if (tableEnsured) return;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
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
    );
    CREATE UNIQUE INDEX IF NOT EXISTS carrier_accounts_client_provider_account_idx
      ON ${TABLE} (
        COALESCE(client_id, -1),
        provider,
        COALESCE(account_identifier, '')
      );

    -- Many-to-many junction: a carrier account can be assigned to
    -- multiple clients (operators reuse the same UPS/USPS/FedEx
    -- credentials across several DR Prepper sub-stores). The legacy
    -- carrier_accounts.client_id stays as a backward-compat anchor;
    -- the junction is the authoritative source of "which clients
    -- can use this carrier" going forward. ON DELETE CASCADE on both
    -- sides so dropping a client or carrier account auto-cleans
    -- orphan assignments.
    CREATE TABLE IF NOT EXISTS carrier_account_clients (
      carrier_account_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (carrier_account_id, client_id),
      CONSTRAINT carrier_account_clients_account_fk
        FOREIGN KEY (carrier_account_id) REFERENCES ${TABLE}(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS carrier_account_clients_client_idx
      ON carrier_account_clients(client_id);
  `);
  tableEnsured = true;
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
  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization' });
    return;
  }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    console.warn('[imported-carrier-accounts] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
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
      const wantSource = source && ALLOWED_ACCOUNT_SOURCES.has(source) ? source : null;
      const rows = await listCredentialAccounts(sql, TABLE, {
        source: wantSource,
        includeAssignments: true,
      });
      res.status(200).json({ data: rows, pending: pending === '1' });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonRequestBody(req);
      const {
        provider,
        label,
        accountIdentifier,
        credentials,
        source,
        clientId,
        credentialKeys: credKeys,
        bodyKeys,
      } = normalizeCredentialAccountBody(body);

      if (!CREDENTIAL_PROVIDER_PATTERN.test(provider)) {
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
          meta: { bodyKeys },
        });
        return;
      }

      const inserted = await upsertCredentialAccount(sql, TABLE, {
        provider,
        label,
        accountIdentifier,
        credentials,
        source,
        clientId,
        credentialKeys: credKeys,
        bodyKeys,
        bodyType: typeof body,
      });
      res.status(200).json({ data: inserted ?? null });
      return;
    }

    if (req.method === 'PUT') {
      // Set the full client-assignment list for a carrier account
      // (replace semantics — sending [] removes all assignments).
      // Used by the Settings UI's "Assign clients" popover.
      //
      // URL: PUT /api/carrier-accounts?id={carrierAccountId}
      // Body: { clientIds: number[] }
      const url = new URL(req.url ?? '', 'http://x');
      const idStr = url.searchParams.get('id');
      const id = idStr != null ? Number(idStr) : NaN;
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'id query parameter is required' });
        return;
      }
      const body = await readJsonRequestBody(req);
      const clientIds = normalizeAssignedClientIds(body);
      const assignmentResult = await replaceCarrierAccountClientAssignments(sql, id, clientIds);
      if (!assignmentResult) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }
      res.status(200).json({ data: assignmentResult });
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
      const deletedId = await deleteCredentialAccount(sql, TABLE, id);
      if (deletedId == null) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }
      res.status(200).json({ data: { id: deletedId, deleted: true } });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[carrier-accounts]', msg);
    res.status(500).json({ error: 'Carrier account request failed' });
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
