// @ts-nocheck
// Vercel serverless function: CRUD for the store_accounts table (marketplace order sources — Walmart, Amazon, eBay, etc.). Mirrors api/carrier-accounts.ts but writes to a separate table so credentials for stores stay isolated from credentials for shipping carriers.
// Bootstraps the table on first call so we don't need a separate migration
// step. Same shape as src/db/schema/carrier-accounts.ts so a future move
// back to the Render backend is a noop.
//
// Endpoints (all under the same path, dispatched on req.method):
//   GET  /api/store-accounts            → list (filterable by source/pending)
//   POST /api/store-accounts            → upsert by (clientId, provider, accountIdentifier)
//
// Auth: Supabase JWT in Authorization: Bearer <token>.

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../src/lib/auth/verify-supabase-jwt';
import { corsHeaders } from '../src/lib/http/cors';

const TABLE = 'store_accounts';

// Provider validation: lowercase slug pattern instead of an explicit list.
// This used to be a hardcoded Set that drifted out of sync with verify.ts's
// VERIFIERS map every time a new carrier was added — bug #lessonlearned.
// The pattern accepts any future provider key without an edit here. The
// verifier endpoint (api/carriers/verify.ts) is the single source of truth
// for which providers can actually be tested; unknown providers there fall
// through to a clean "not yet implemented" response.
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const ALLOWED_SOURCES = new Set(['admin', 'portal']);

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
    `CREATE UNIQUE INDEX IF NOT EXISTS store_accounts_client_provider_account_idx
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
        '[store-accounts] bootstrap statement failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // One-time migration: move any rows that were saved to carrier_accounts
  // back when the UI was a single combined section but actually represent
  // marketplace stores (Walmart, Amazon, eBay, etc.). We preserve the
  // original `id` so store_orders.carrier_account_id (which currently
  // points at the integer ID in carrier_accounts) stays valid after the
  // row's home table changes — column rename is cosmetic and can wait.
  // After moving, we DELETE the original rows + advance the SERIAL
  // sequence past the highest preserved id so future POSTs don't collide.
  try {
    await sql.unsafe(`
      INSERT INTO ${TABLE} (id, client_id, provider, label, account_identifier,
                            credentials, source, active, created_at, updated_at)
      SELECT id, client_id, provider, label, account_identifier,
             credentials, source, active, created_at, updated_at
      FROM carrier_accounts
      WHERE provider IN (
        'walmart','amazon','amazon_shipping','ebay','shopify','etsy',
        'tiktok_shop','woocommerce','bigcommerce'
      )
      ON CONFLICT (
        COALESCE(client_id, -1), provider, COALESCE(account_identifier, '')
      ) DO NOTHING
    `);
    await sql.unsafe(`
      DELETE FROM carrier_accounts
      WHERE provider IN (
        'walmart','amazon','amazon_shipping','ebay','shopify','etsy',
        'tiktok_shop','woocommerce','bigcommerce'
      )
    `);
    await sql.unsafe(`
      SELECT setval('store_accounts_id_seq',
        GREATEST(COALESCE((SELECT MAX(id) FROM ${TABLE}), 0) + 1, 1),
        false)
    `);
  } catch (err) {
    console.warn(
      '[store-accounts] one-time store migration failed (likely empty source table):',
      err instanceof Error ? err.message : err,
    );
  }

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
    console.warn('[store-accounts] Invalid token:', verified.reason);
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
      console.log('[store-accounts:POST]', JSON.stringify({
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
        console.log('[store-accounts:POST] post-insert', JSON.stringify({
          rowId: inserted[0]?.id ?? null,
          storedCredentialKeys: storedKeys,
          storedType: typeof stored,
        }));
      } catch (vErr) {
        console.warn('[store-accounts:POST] post-insert verify failed:', vErr instanceof Error ? vErr.message : vErr);
      }

      // Auto-create a `clients` row tied to a synthetic store_id so the
      // store appears in the Awaiting Shipment sidebar immediately —
      // without waiting for a Pull Orders run. The same offset scheme is
      // used by the per-provider order pullers (api/carriers/<provider>/orders.ts),
      // so when orders are pulled they reuse this client_id rather than
      // creating a duplicate. Idempotent: skips if a clients row already
      // exists for the synthetic store_id (re-saves don't dupe).
      const SYNTHETIC_STORE_OFFSETS: Record<string, number> = {
        walmart:      9_000_000,
        amazon:       9_100_000,
        shopify:      9_200_000,
        etsy:         9_300_000,
        tiktok_shop:  9_400_000,
        ebay:         9_500_000,
        woocommerce:  9_600_000,
        bigcommerce:  9_700_000,
      };
      const accountId = inserted[0]?.id as number | undefined;
      if (accountId != null) {
        const offset = SYNTHETIC_STORE_OFFSETS[provider] ?? 9_900_000;
        const syntheticStoreId = offset + accountId;
        try {
          const existing = await sql<Array<{ id: number }>>`
            SELECT id FROM clients
            WHERE store_ids @> ARRAY[${syntheticStoreId}]::integer[]
            LIMIT 1
          `;
          if (existing.length === 0) {
            // Friendly client name — try to make it human-readable based
            // on the provider slug + the user-supplied label.
            const providerLabels: Record<string, string> = {
              walmart: 'Walmart Marketplace',
              amazon: 'Amazon Marketplace',
              ebay: 'eBay',
              shopify: 'Shopify',
              etsy: 'Etsy',
              tiktok_shop: 'TikTok Shop',
              woocommerce: 'WooCommerce',
              bigcommerce: 'BigCommerce',
            };
            const baseName = providerLabels[provider] ?? provider.toUpperCase();
            const friendly = label && !new RegExp(provider, 'i').test(label)
              ? `${baseName} — ${label}`
              : (label || baseName);
            await sql`
              INSERT INTO clients (name, store_ids, active, is_test)
              VALUES (${friendly}, ARRAY[${syntheticStoreId}]::integer[], true, false)
            `;
            console.log('[store-accounts:POST] auto-created clients row', JSON.stringify({
              provider,
              accountId,
              syntheticStoreId,
              clientName: friendly,
            }));
          }
        } catch (clientErr) {
          console.warn(
            '[store-accounts:POST] could not auto-create clients row:',
            clientErr instanceof Error ? clientErr.message : clientErr,
          );
        }
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
      // Look up provider before deleting so we can compute the matching
      // synthetic store_id and cascade-delete the auto-created clients row.
      const existing = await sql<Array<{ provider: string }>>`
        SELECT provider FROM ${sql(TABLE)} WHERE id = ${id} LIMIT 1
      `;
      const provider = existing[0]?.provider ?? null;

      const deleted = await sql<Array<{ id: number }>>`
        DELETE FROM ${sql(TABLE)}
        WHERE id = ${id}
        RETURNING id
      `;
      if (deleted.length === 0) {
        res.status(404).json({ error: `store_accounts row #${id} not found` });
        return;
      }

      // Cascade: remove the auto-created clients row whose store_ids array
      // is exactly [syntheticStoreId]. We deliberately use equality (not
      // containment) so we don't damage clients with multiple store_ids
      // — only the auto-created single-store clients get cleaned up.
      const SYNTHETIC_STORE_OFFSETS: Record<string, number> = {
        walmart:      9_000_000,
        amazon:       9_100_000,
        shopify:      9_200_000,
        etsy:         9_300_000,
        tiktok_shop:  9_400_000,
        ebay:         9_500_000,
        woocommerce:  9_600_000,
        bigcommerce:  9_700_000,
      };
      let cascadedClientId: number | null = null;
      if (provider) {
        const offset = SYNTHETIC_STORE_OFFSETS[provider] ?? 9_900_000;
        const syntheticStoreId = offset + id;
        try {
          const cascade = await sql<Array<{ id: number }>>`
            DELETE FROM clients
            WHERE store_ids = ARRAY[${syntheticStoreId}]::integer[]
            RETURNING id
          `;
          cascadedClientId = cascade[0]?.id ?? null;
        } catch (cascadeErr) {
          console.warn(
            '[store-accounts:DELETE] could not cascade-delete clients row:',
            cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
          );
        }
      }

      res.status(200).json({
        data: { id: deleted[0].id, deleted: true, cascadedClientId },
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[store-accounts]', msg);
    res.status(500).json({ error: msg });
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
