// @ts-nocheck
// Vercel serverless function: CRUD for the carrier_accounts table.
// Uses the migration-owned credential account schema. The handler verifies
// readiness on entry instead of creating tables or indexes during requests.
//
// Endpoints (all under the same path, dispatched on req.method):
//   GET    /api/carrier-accounts            → list (filterable by source/pending)
//   POST   /api/carrier-accounts            → upsert by (clientId, provider, accountIdentifier)
//   PUT    /api/carrier-accounts?id=N       → replace the carrier's client-assignment
//                                             list. Body: { clientIds: number[] }
//                                             Side-effect: auto-promotes source
//                                             from 'portal' → 'admin' on the
//                                             same transaction (Option A,
//                                             2026-05-12 audit).
//   PATCH  /api/carrier-accounts?id=N       → partial update. Body accepts
//                                             ANY combination of:
//                                               { source: 'admin'|'portal' }   → flip source (explicit approval flow)
//                                               { label: string }              → rename the display label
//                                             Empty body returns 400.
//   DELETE /api/carrier-accounts?id=N       → delete the carrier_accounts row
//                                             (cascades to carrier_account_clients)
//
// Auth: Supabase JWT in Authorization: Bearer <token>.

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../src/lib/auth/verify-supabase-jwt.js';
import {
  ALLOWED_ACCOUNT_SOURCES,
  CREDENTIAL_PROVIDER_PATTERN,
  maskAccountIdentifier,
  normalizeCredentialAccountBody,
  normalizeCredentialAccountPatchBody,
  readJsonRequestBody,
} from '../src/lib/credential-accounts.js';
import { corsHeaders } from '../src/lib/http/cors.js';
import { ensureCredentialAccountRuntimeSchema } from '../src/services/credential-account-schema.js';
import {
  deleteCredentialAccount,
  getCredentialAccountSnapshot,
  getCredentialAccountStoredCredentialKeys,
  listCredentialAccounts,
  normalizeAssignedClientIds,
  patchCredentialAccount,
  replaceCarrierAccountClientAssignments,
  upsertCredentialAccount,
} from '../src/services/credential-accounts.js';

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
    console.warn('[carrier-accounts] Invalid token:', verified.reason);
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
        bodyType,
      } = normalizeCredentialAccountBody(body);

      // Diagnostic: log key shape (never values) so a bad save can be traced
      // without dumping secrets. Drop a row that arrives with no credential
      // keys at all — the prior 4/30 Walmart row landed in that empty state
      // and there's no legitimate flow that should produce one.
      console.log('[carrier-accounts:POST]', JSON.stringify({
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
        console.log('[carrier-accounts:POST] post-insert', JSON.stringify({
          rowId: inserted?.id ?? null,
          storedCredentialKeys: storedKeys,
        }));
      } catch (vErr) {
        console.warn('[carrier-accounts:POST] post-insert verify failed:', vErr instanceof Error ? vErr.message : vErr);
      }

      res.status(200).json({ data: inserted ?? null });
      return;
    }

    if (req.method === 'PUT') {
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
      // Partial-update endpoint. Two independent fields are
      // supported; the body can carry one, the other, or both:
      //
      //   { source: 'admin' | 'portal' }
      //     Source-flip flow (Option B from the 2026-05-12 audit).
      //     Used by the "Approve" button in the Pending Client
      //     Integrations card and on portal-source rows in the main
      //     Settings list. Lets the operator promote a submitted
      //     carrier without immediately assigning any clients.
      //
      //   { label: string }
      //     Rename flow (2026-05-12). Operator-friendly way to
      //     change the display name on a carrier account from
      //     Settings → Carriers. Label is trimmed and capped at 200
      //     characters to match the POST upsert path's slicing.
      //     Empty/whitespace-only labels become NULL so the row
      //     falls back to its account-identifier in the UI.
      //
      // URL: PATCH /api/carrier-accounts?id={carrierAccountId}
      const url = new URL(req.url ?? '', 'http://x');
      const idStr = url.searchParams.get('id');
      const id = idStr != null ? Number(idStr) : NaN;
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'id query parameter is required' });
        return;
      }

      const body = await readJsonRequestBody(req);
      const patch = normalizeCredentialAccountPatchBody(body);

      // Reject empty bodies up-front so the caller gets a clear
      // error instead of a successful no-op UPDATE.
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
        console.log('[carrier-accounts:PATCH] credentials merge', JSON.stringify({
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

      // Pre-fetch the OLD label so the rename-propagation step
      // (below) can target the right snapshots. Same query also
      // verifies the row exists — saves a roundtrip.
      const before = await getCredentialAccountSnapshot(sql, TABLE, id);
      if (!before) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }
      const oldLabel = before.label;

      const updated = await patchCredentialAccount(sql, TABLE, id, patch);

      if (!updated) {
        res.status(404).json({ error: `carrier_accounts row #${id} not found` });
        return;
      }

      // ── Rename propagation to AWAITING order snapshots ─────────
      // The orders table's display nickname comes from one of two
      // JSON fields inside order_overrides.best_rate_json:
      //   - providerAccountNickname  (preferred when present)
      //   - carrierNickname          (legacy fallback)
      //
      // When a rate is calculated, the carrier label gets snapshotted
      // into those fields. Renaming the master label later without
      // touching the snapshots leaves awaiting orders displaying the
      // OLD label — which is what the 2026-05-12 follow-up audit
      // reported ("i see wm ship even i edit the walmart").
      //
      // Scope: ONLY awaiting orders. Shipped + cancelled snapshots
      // stay frozen for audit-trail correctness AND because the
      // shipments table is under the lockdown (AGENTS.md). The two
      // UPDATEs are run in separate statements so each touches only
      // the field that actually matched the old label — otherwise a
      // bulk jsonb_set would overwrite the OTHER field with the new
      // label even when it didn't match, leaking the rename into
      // unrelated snapshots.
      let ordersUpdated = 0;
      if (
        patch.hasLabel &&
        oldLabel != null &&
        oldLabel.length > 0 &&
        !patch.labelGoesNull &&
        patch.label != null &&
        patch.label !== oldLabel
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
              AND ovr.best_rate_json->>'providerAccountNickname' = ${oldLabel}
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
              AND ovr.best_rate_json->>'carrierNickname' = ${oldLabel}
          `) as unknown as { count?: number };
          ordersUpdated = Math.max(
            typeof r1.count === 'number' ? r1.count : 0,
            typeof r2.count === 'number' ? r2.count : 0,
          );
        } catch (err) {
          // Backfill failures don't fail the rename itself — the
          // master label updated cleanly. Surface in logs only so
          // the operator's request succeeds even if backfill hit a
          // transient DB issue.
          console.warn(
            '[carrier-accounts:PATCH] awaiting-snapshot backfill failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      res.status(200).json({
        data: updated,
        // ordersUpdated: how many awaiting orders' display nicknames
        // were refreshed by this rename. UI uses this to confirm
        // ("Renamed + refreshed 12 awaiting orders").
        ordersUpdated,
      });
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
