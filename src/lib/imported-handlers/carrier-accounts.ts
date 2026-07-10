// @ts-nocheck
// Vercel serverless function: CRUD for the carrier_accounts table.
// Uses the migration-owned credential account schema. The handler verifies
// readiness on entry instead of creating tables or indexes during requests.
//
// Endpoints (all under the same path, dispatched on req.method):
//   GET  /api/carrier-accounts            → list (filterable by source/pending)
//   POST /api/carrier-accounts            → upsert by (clientId, provider, accountIdentifier)
//
//   PUT  /api/carrier-accounts?id=N     -> replace/update connection metadata
//   PATCH /api/carrier-accounts?id=N    -> partial update, including label/source
//   DELETE /api/carrier-accounts?id=N   -> delete a carrier account row
//
// Auth: Supabase JWT in Authorization: Bearer <token>.

import postgres from 'postgres';
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
import { ensureCredentialAccountRuntimeSchema } from '../../services/credential-account-schema';
import {
  backfillAwaitingSnapshotNickname,
  deleteCredentialAccount,
  getCredentialAccountSnapshot,
  getCredentialAccountStoredCredentialKeys,
  listCredentialAccounts,
  normalizeAssignedClientIds,
  patchCredentialAccount,
  replaceCarrierAccountClientAssignments,
  upsertCredentialAccount,
} from '../../services/credential-accounts';
import {
  carrierStoreLinkIdentifier,
  isStoreScopedCarrierProvider,
  resolveStoreAccountLink,
  storedCarrierAccountIdentifier,
  type StoreAccountIdentity,
} from '../../services/carrier-account-identity';

const TABLE = 'carrier_accounts';

async function loadActiveStoreAccountIdentities(sql: any): Promise<StoreAccountIdentity[]> {
  return sql<Array<{
    id: number;
    clientId: number | null;
    provider: string;
    label: string | null;
    accountIdentifier: string | null;
    credentials: Record<string, unknown>;
    active: boolean;
  }>>`
    SELECT id, client_id AS "clientId", provider, label,
           account_identifier AS "accountIdentifier", credentials, active
    FROM store_accounts
    WHERE active = true
  `;
}

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
    sendInternalServerError(
      res,
      'imported-carrier-accounts:config',
      new Error('DATABASE_URL not configured'),
    );
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
        credentials,
        source,
        clientId,
        credentialKeys: credKeys,
        bodyKeys,
        bodyType,
      } = normalizeCredentialAccountBody(body);

      const requestedStoreAccountId = Number(body.storeAccountId);
      let effectiveClientId = clientId;
      let accountIdentifier = storedCarrierAccountIdentifier({
        provider,
        label,
        credentials,
        storeAccountId: Number.isInteger(requestedStoreAccountId) ? requestedStoreAccountId : null,
      });

      if (isStoreScopedCarrierProvider(provider)) {
        if (!Number.isInteger(requestedStoreAccountId) || requestedStoreAccountId <= 0) {
          res.status(400).json({
            error: `${provider} requires the exact storeAccountId it belongs to.`,
            code: 'STORE_LINK_REQUIRED',
          });
          return;
        }
        const stores = await loadActiveStoreAccountIdentities(sql);
        const link = resolveStoreAccountLink({
          id: 0,
          clientId,
          provider,
          label,
          accountIdentifier: carrierStoreLinkIdentifier(requestedStoreAccountId),
          credentials,
          active: true,
        }, stores);
        if (!link.ok) {
          res.status(409).json({ error: link.reason, code: link.code });
          return;
        }
        effectiveClientId = link.store.clientId ?? clientId;
        accountIdentifier = carrierStoreLinkIdentifier(link.store.id);
      }

      // PS-200 S1 drift re-sync: the legacy Vercel handler grew this
      // diagnostic after a real incident (a 4/30 Walmart row saved with empty
      // credentials). Log key SHAPE only — never values — so a bad save can
      // be traced without dumping secrets.
      console.log('[imported-carrier-accounts:POST]', JSON.stringify({
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
        res.status(400).json({ error: 'A display label or non-secret account identifier is required.' });
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
        clientId: effectiveClientId,
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
        console.log('[imported-carrier-accounts:POST] post-insert', JSON.stringify({
          rowId: inserted?.id ?? null,
          storedCredentialKeys: storedKeys,
        }));
      } catch (vErr) {
        console.warn('[imported-carrier-accounts:POST] post-insert verify failed:', vErr instanceof Error ? vErr.message : vErr);
      }

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
      const [account] = await sql<Array<{
        id: number;
        clientId: number | null;
        provider: string;
        label: string | null;
        accountIdentifier: string | null;
        credentials: Record<string, unknown>;
        active: boolean;
      }>>`
        SELECT id, client_id AS "clientId", provider, label,
               account_identifier AS "accountIdentifier", credentials, active
        FROM carrier_accounts
        WHERE id = ${id}
        LIMIT 1
      `;
      if (account && isStoreScopedCarrierProvider(account.provider)) {
        const link = resolveStoreAccountLink(account, await loadActiveStoreAccountIdentities(sql));
        if (!link.ok) {
          res.status(409).json({ error: link.reason, code: link.code });
          return;
        }
        const expectedClientId = link.store.clientId ?? account.clientId;
        const exactAssignment = expectedClientId == null
          ? clientIds.length === 0
          : clientIds.length === 1 && clientIds[0] === expectedClientId;
        if (!exactAssignment) {
          res.status(409).json({
            error: 'Store-scoped carrier assignments must match the linked store account client.',
            code: 'STORE_CLIENT_MISMATCH',
          });
          return;
        }
      }
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
      // PS-200 S1 drift re-sync: the legacy handler also accepts
      // { credentials } (the Settings "Reconnect" JSONB-merge re-entry) and
      // { active } (the Rate Browser Hide/Show toggle). The shared
      // normalizer + patchCredentialAccount already support both — this
      // early-400 gate was the only thing blocking them on the v4 path.
      if (!patch.hasSource && !patch.hasLabel && !patch.hasCredentials && !patch.hasActive) {
        res.status(400).json({
          error: 'PATCH body must include at least one of: source, label, credentials, active',
        });
        return;
      }

      // Credential re-entry ("Reconnect") — log which KEYS are being merged,
      // never the values, so a stale-creds save can be traced without leaking
      // secrets. Mirrors the POST path's diagnostic.
      if (patch.hasCredentials) {
        console.log('[imported-carrier-accounts:PATCH] credentials merge', JSON.stringify({
          id,
          credentialKeys: patch.credentialKeys,
        }));
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

      if (patch.hasCredentials && patch.credentials) {
        const [account] = await sql<Array<{
          id: number;
          clientId: number | null;
          provider: string;
          label: string | null;
          accountIdentifier: string | null;
          credentials: Record<string, unknown>;
          active: boolean;
        }>>`
          SELECT id, client_id AS "clientId", provider, label,
                 account_identifier AS "accountIdentifier", credentials, active
          FROM carrier_accounts
          WHERE id = ${id}
          LIMIT 1
        `;
        if (account && isStoreScopedCarrierProvider(account.provider)) {
          const mergedCredentials = { ...(account.credentials ?? {}), ...patch.credentials };
          const link = resolveStoreAccountLink(
            { ...account, credentials: mergedCredentials },
            await loadActiveStoreAccountIdentities(sql),
          );
          if (!link.ok) {
            res.status(409).json({ error: link.reason, code: link.code });
            return;
          }
          if (link.derived) {
            await sql`
              UPDATE carrier_accounts
              SET account_identifier = ${carrierStoreLinkIdentifier(link.store.id)}, updated_at = NOW()
              WHERE id = ${id}
            `;
          }
        }
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
          // PS-163: the awaiting-only nickname backfill SQL now lives in the credential-accounts
          // service (single owner). This handler still decides WHEN to run it (real label change above).
          ordersUpdated = await backfillAwaitingSnapshotNickname(sql, before.label, patch.label);
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
    sendInternalServerError(res, 'imported-carrier-accounts', err);
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
