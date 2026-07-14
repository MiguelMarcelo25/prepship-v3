// PS-200 S1: v4 mirror of the legacy Vercel store-accounts function — CRUD
// for the store_accounts table (marketplace order sources — Walmart, Amazon,
// eBay, etc.). Mirrors imported-handlers/carrier-accounts.ts but writes to a
// separate table so credentials for stores stay isolated from credentials
// for shipping carriers.
// Uses the migration-owned credential account schema. The handler verifies
// readiness on entry instead of creating tables or indexes during requests.
//
// Endpoints (all under the same path, dispatched on req.method):
//   GET  /store-accounts            → list (filterable by source/pending)
//   POST /store-accounts            → upsert by (clientId, provider, accountIdentifier)
//
//   PATCH /store-accounts?id=N      -> partial update, including label/source
//   DELETE /store-accounts?id=N     -> delete a store account row
//
// Auth: Supabase JWT verified in-handler; the mounting route additionally
// enforces the credentials:read/write app permission (stricter than legacy).

import { sql } from '../../db/client.js';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../auth/verify-supabase-jwt';
import { sendInternalServerError } from '../safe-error';
import {
  ALLOWED_ACCOUNT_SOURCES,
  CREDENTIAL_PROVIDER_PATTERN,
  maskAccountIdentifier,
  normalizeCredentialAccountBody,
  normalizeCredentialAccountPatchBody,
  readJsonRequestBody,
} from '../credential-accounts';
import { corsHeaders } from '../http/cors';
import type { NodeStyleRequest, NodeStyleResponse } from '../node-handler.js';
import { ensureCredentialAccountRuntimeSchema } from '../../services/credential-account-schema';
import {
  deleteCredentialAccount,
  deleteSyntheticStoreClientForAccount,
  ensureSyntheticStoreClient,
  getCredentialAccountProvider,
  getCredentialAccountStoredCredentialKeys,
  listCredentialAccounts,
  patchCredentialAccount,
  upsertCredentialAccount,
} from '../../services/credential-accounts';

const TABLE = 'store_accounts';

// Provider validation: lowercase slug pattern instead of an explicit list.
// This used to be a hardcoded Set that drifted out of sync with the
// verifier's VERIFIERS map every time a new carrier was added — bug
// #lessonlearned. The pattern accepts any future provider key without an
// edit here. The credential-verification connector is the single source of
// truth for which providers can actually be tested; unknown providers there
// fall through to a clean "not yet implemented" response.
export default async function handler(
  req: NodeStyleRequest,
  res: NodeStyleResponse,
): Promise<void> {
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
    console.warn('[imported-store-accounts] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

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
      const rows = await listCredentialAccounts(sql, TABLE, { source: wantSource });
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
        bodyType,
      } = normalizeCredentialAccountBody(body);

      // Diagnostic: log key shape (never values) so a bad save can be traced
      // without dumping secrets. Drop a row that arrives with no credential
      // keys at all — the prior 4/30 Walmart row landed in that empty state
      // and there's no legitimate flow that should produce one.
      console.log('[imported-store-accounts:POST]', JSON.stringify({
        provider,
        accountIdentifier: maskAccountIdentifier(accountIdentifier),
        credentialKeys: credKeys,
        bodyKeys,
        bodyType,
        source,
      }));

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
        bodyType,
      });

      // Post-insert verification — log what actually landed in JSONB so a
      // future "credentials saved empty" bug doesn't require a code dive.
      try {
        const storedKeys = await getCredentialAccountStoredCredentialKeys(
          sql,
          TABLE,
          inserted?.id as number | undefined,
        );
        console.log('[imported-store-accounts:POST] post-insert', JSON.stringify({
          rowId: inserted?.id ?? null,
          storedCredentialKeys: storedKeys,
        }));
      } catch (vErr) {
        console.warn('[imported-store-accounts:POST] post-insert verify failed:', vErr instanceof Error ? vErr.message : vErr);
      }

      // Auto-create a `clients` row tied to a synthetic store_id so the
      // store appears in the Awaiting Shipment sidebar immediately —
      // without waiting for a Pull Orders run. The same offset scheme is
      // used by the per-provider order pullers, so when orders are pulled
      // they reuse this client_id rather than creating a duplicate.
      // Idempotent: skips if a clients row already exists for the synthetic
      // store_id (re-saves don't dupe).
      const accountId = inserted?.id as number | undefined;
      if (accountId != null) {
        try {
          const synthetic = await ensureSyntheticStoreClient(sql, { provider, accountId, label });
          if (synthetic?.created) {
            console.log('[imported-store-accounts:POST] auto-created clients row', JSON.stringify({
              provider,
              accountId,
              syntheticStoreId: synthetic.syntheticStoreId,
              clientName: synthetic.clientName,
            }));
          }
        } catch (clientErr) {
          console.warn(
            '[imported-store-accounts:POST] could not auto-create clients row:',
            clientErr instanceof Error ? clientErr.message : clientErr,
          );
        }
      }

      res.status(200).json({ data: inserted ?? null });
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
      if (!patch.hasSource && !patch.hasLabel && !patch.hasActive && !patch.hasCredentials) {
        res.status(400).json({
          error: 'PATCH body must include at least one of: source, label, active, credentials',
        });
        return;
      }
      if (patch.hasSource && patch.source == null) {
        res.status(400).json({
          error: `source must be one of: ${[...ALLOWED_ACCOUNT_SOURCES].join(', ')}`,
        });
        return;
      }

      const updated = await patchCredentialAccount(sql, TABLE, id, patch);
      if (!updated) {
        res.status(404).json({ error: `store_accounts row #${id} not found` });
        return;
      }

      res.status(200).json({ data: updated });
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
      const provider = await getCredentialAccountProvider(sql, TABLE, id);
      const deletedId = await deleteCredentialAccount(sql, TABLE, id);
      if (deletedId == null) {
        res.status(404).json({ error: `store_accounts row #${id} not found` });
        return;
      }

      let cascadedClientId: number | null = null;
      if (provider) {
        try {
          cascadedClientId = await deleteSyntheticStoreClientForAccount(sql, {
            provider,
            accountId: id,
          });
        } catch (cascadeErr) {
          console.warn(
            '[imported-store-accounts:DELETE] could not cascade-delete clients row:',
            cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
          );
        }
      }

      res.status(200).json({
        data: { id: deletedId, deleted: true, cascadedClientId },
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    sendInternalServerError(res, 'imported-store-accounts', err);
  }
}
