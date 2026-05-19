// @ts-nocheck
// Vercel serverless function: CRUD for the carrier_accounts table.
// Uses the migration-owned credential account schema. The handler verifies
// readiness on entry instead of creating tables or indexes during requests.
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
  normalizeCredentialAccountPatchBody,
  readJsonRequestBody,
} from '../credential-accounts';
import { corsHeaders } from '../http/cors';
import { ensureCredentialAccountRuntimeSchema } from '../../services/credential-account-schema';
import {
  deleteCredentialAccount,
  getCredentialAccountSnapshot,
  listCredentialAccounts,
  normalizeAssignedClientIds,
  patchCredentialAccount,
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
    await ensureCredentialAccountRuntimeSchema(sql, TABLE);

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
      const assignmentResult = await replaceCarrierAccountClientAssignments(sql, id, clientIds, {
        promotePortal: true,
      });
      if (!assignmentResult) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }
      res.status(200).json({ data: assignmentResult });
      return;
    }

    if (req.method === 'PATCH') {
      const url = new URL(req.url ?? '', 'http://x');
      const idStr = url.searchParams.get('id');
      const id = idStr != null ? Number(idStr) : NaN;
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'id query parameter is required' });
        return;
      }

      const body = await readJsonRequestBody(req);
      const patch = normalizeCredentialAccountPatchBody(body);
      if (!patch.hasSource && !patch.hasLabel) {
        res.status(400).json({
          error: 'PATCH body must include at least one of: source, label',
        });
        return;
      }
      if (patch.hasSource && patch.source == null) {
        res.status(400).json({
          error: `source must be one of: ${[...ALLOWED_ACCOUNT_SOURCES].join(', ')}`,
        });
        return;
      }

      const before = await getCredentialAccountSnapshot(sql, TABLE, id);
      if (!before) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }

      const updated = await patchCredentialAccount(sql, TABLE, id, patch);
      if (!updated) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }

      let ordersUpdated = 0;
      if (
        patch.hasLabel &&
        before.label != null &&
        before.label.length > 0 &&
        !patch.labelGoesNull &&
        patch.label != null &&
        patch.label !== before.label
      ) {
        try {
          const r1 = (await sql`
            UPDATE order_overrides ovr
            SET best_rate_json = jsonb_set(
              best_rate_json,
              '{providerAccountNickname}',
              to_jsonb(${patch.label}::text)
            )
            FROM orders o
            WHERE ovr.order_id = o.id
              AND o.order_status = 'awaiting_shipment'
              AND ovr.best_rate_json->>'providerAccountNickname' = ${before.label}
          `) as unknown as { count?: number };
          const r2 = (await sql`
            UPDATE order_overrides ovr
            SET best_rate_json = jsonb_set(
              best_rate_json,
              '{carrierNickname}',
              to_jsonb(${patch.label}::text)
            )
            FROM orders o
            WHERE ovr.order_id = o.id
              AND o.order_status = 'awaiting_shipment'
              AND ovr.best_rate_json->>'carrierNickname' = ${before.label}
          `) as unknown as { count?: number };
          ordersUpdated = Math.max(
            typeof r1.count === 'number' ? r1.count : 0,
            typeof r2.count === 'number' ? r2.count : 0,
          );
        } catch (err) {
          console.warn(
            '[carrier-accounts:PATCH] awaiting-snapshot backfill failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      res.status(200).json({ data: updated, ordersUpdated });
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
