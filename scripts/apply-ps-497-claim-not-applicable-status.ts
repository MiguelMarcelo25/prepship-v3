#!/usr/bin/env tsx
import 'dotenv/config';
import postgres from 'postgres';
import { readVerifiedMigration, MIGRATION_RELPATH } from './ps-497-claim-status-migration-digest.js';

// PS-497 Slice 2 — apply migration 0105 (claim status 'not_applicable' + quantity-state replacement).
// Dry-run by default; `--apply --confirm=<token>` required. It refuses unless the file matches its pinned
// SHA-256, pre-audits every status/quantity combination and STOPS on an unknown status (never rewrites
// data), runs each statement standalone under bounded timeouts (so an ADD CONSTRAINT's AccessExclusive
// releases before a VALIDATE scan), adds+validates BOTH successor constraints before dropping 0090, and
// proves the claim table is byte-identical over the frozen pre-apply id range.

const CONFIRMATION = 'apply-ps-497-claim-not-applicable-status-0105';
const KNOWN_STATUSES = ['pending', 'applied', 'superseded', 'reversed', 'review', 'not_applicable'];
const V2_CHECK = 'fulfillment_line_claims_quantity_state_v2_check';
const DOMAIN_CHECK = 'fulfillment_line_claims_status_domain_check';
const OLD_CHECK = 'fulfillment_line_claims_quantity_state_check';
// 0070's inline column CHECK on status (auto-named <table>_<column>_check) still only admits the five
// original statuses; it must be dropped LAST — after the six-value domain check is validated — so a
// status domain is enforced the whole time and 'not_applicable' becomes insertable.
const OLD_STATUS_CHECK = 'fulfillment_line_claims_status_check';

const TIMEOUT_RE = /^(\d+)\s*(ms|s|min)$/;
function timeoutMs(name: string, fallback: string, minMs: number, maxMs: number): number {
  const raw = (process.env[name] ?? fallback).trim();
  const m = TIMEOUT_RE.exec(raw);
  if (!m) throw new Error(`${name}='${raw}' is not a valid bounded timeout (<n>ms|s|min)`);
  const n = Number(m[1]);
  const ms = m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
  if (!Number.isSafeInteger(ms) || ms < minMs || ms > maxMs) {
    throw new Error(`${name}='${raw}' (${ms}ms) outside [${minMs}, ${maxMs}]ms — 0/disabled/unbounded refused`);
  }
  return ms;
}
const LOCK_TIMEOUT_MS = timeoutMs('PS497_LOCK_TIMEOUT', '5s', 1, 300_000);
const STATEMENT_TIMEOUT_MS = timeoutMs('PS497_0105_STATEMENT_TIMEOUT', '3600s', 1_000, 21_600_000);

type Phase = { v2_present: boolean; v2_validated: boolean; domain_present: boolean; domain_validated: boolean; old_present: boolean; old_status_present: boolean };
type ClaimsSnapshot = { claim_count: string; by_status: string; checksum: string };

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}
function isPhase0104(p: Phase): boolean {
  return !p.v2_present && !p.domain_present && p.old_present && p.old_status_present;
}
function isPhase0105(p: Phase): boolean {
  return p.v2_present && p.v2_validated && p.domain_present && p.domain_validated && !p.old_present && !p.old_status_present;
}

async function main(): Promise<void> {
  const { text: migration, digest } = readVerifiedMigration();
  const stripped = migration.replace(/--[^\n]*/g, '');
  if (/\b(update|delete\s+from|insert\s+into|truncate|copy|merge)\b/i.test(stripped)) {
    throw new Error('Migration refused: DML detected');
  }
  if (/\balter\s+table\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(?:orders|shipments)"?/i.test(stripped)) {
    throw new Error('Migration refused: orders/shipments must not be altered');
  }
  if (/\bdrop\s+(?:table|column)\b/i.test(stripped)) {
    throw new Error('Migration refused: DROP TABLE/COLUMN detected (0105 only drops a CONSTRAINT)');
  }
  if (/\b(execute|perform)\b/i.test(stripped) || /\bcreate\s+(?:or\s+replace\s+)?(?:trigger|function|procedure)\b/i.test(stripped)) {
    throw new Error('Migration refused: dynamic SQL / trigger / function detected');
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = postgres(databaseUrl, {
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: 'ps-497-migration-0105', search_path: 'public' },
  });

  const hasCon = async (name: string): Promise<{ present: boolean; validated: boolean }> => {
    const [row] = await client<{ validated: boolean | null }[]>`
      select con.convalidated as validated
      from pg_constraint con
      join pg_class r on r.oid = con.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = 'fulfillment_line_claims' and con.conname = ${name}
    `;
    return { present: row !== undefined, validated: row?.validated === true };
  };
  const inspect = async (): Promise<Phase> => {
    const v2 = await hasCon(V2_CHECK);
    const domain = await hasCon(DOMAIN_CHECK);
    const old = await hasCon(OLD_CHECK);
    const oldStatus = await hasCon(OLD_STATUS_CHECK);
    return { v2_present: v2.present, v2_validated: v2.validated, domain_present: domain.present, domain_validated: domain.validated, old_present: old.present, old_status_present: oldStatus.present };
  };
  const highWaterMark = async (): Promise<string> => {
    const [row] = await client<{ m: string }[]>`select coalesce(max(id),0)::text as m from fulfillment_line_claims`;
    return row?.m ?? '0';
  };
  const snapshot = async (maxId: string): Promise<ClaimsSnapshot> => {
    const [row] = await client<ClaimsSnapshot[]>`
      select
        (select count(*)::text from fulfillment_line_claims where id <= ${maxId}::int) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (select status, count(*)::text n from fulfillment_line_claims where id <= ${maxId}::int group by status) s) as by_status,
        coalesce((select sum(('x' || substr(md5(id || ':' || coalesce(quantity::text,'~') || ':' || status), 1, 16))::bit(64)::bigint::numeric)::text
           from fulfillment_line_claims where id <= ${maxId}::int), '0') as checksum
    `;
    if (!row) throw new Error('0105 claims snapshot returned no row');
    return row;
  };

  try {
    console.log(`[ps-497-0105] migration digest verified: ${digest}`);
    await client.unsafe(`set lock_timeout = '${LOCK_TIMEOUT_MS}'; set statement_timeout = '${STATEMENT_TIMEOUT_MS}';`);
    const [appRow] = await client<{ app: string }[]>`select current_setting('application_name') as app`;
    if (appRow?.app !== 'ps-497-migration-0105') throw new Error(`unexpected application_name '${appRow?.app}'`);

    const before = await inspect();
    console.log(`[ps-497-0105] phase=${JSON.stringify(before)}`);
    if (isPhase0105(before)) { console.log('[ps-497-0105] already_applied=true (phase 0105)'); return; }
    if (!isPhase0104(before) && !(before.v2_present || before.domain_present)) {
      throw new Error('unexpected pre-state: neither the 0104 phase nor a resumable 0105 intermediate');
    }

    // Pre-audit: statuses must be within the known domain; STOP on any unknown (never rewrite).
    const statusRows = await client<{ status: string }[]>`select distinct status from fulfillment_line_claims`;
    const unknown = statusRows.map((r) => r.status).filter((s) => !KNOWN_STATUSES.includes(s));
    if (unknown.length) throw new Error(`Refused: unknown claim status values present: ${unknown.join(', ')} — resolve before applying`);
    // Pre-audit: every existing row must already satisfy the v2 contract (no rewrite needed).
    const [badRow] = await client<{ bad: string }[]>`
      select count(*)::text as bad from fulfillment_line_claims
      where not ((quantity is not null and quantity > 0) or (quantity is null and status in ('review','not_applicable','superseded')))
    `;
    const bad = badRow?.bad ?? '0';
    if (Number(bad) > 0) throw new Error(`Refused: ${bad} row(s) would violate the new quantity-state contract — resolve before applying (no auto-rewrite)`);

    if (!approved()) {
      const snap = await snapshot(await highWaterMark());
      console.log(`[ps-497-0105] claims=${snap.claim_count} by_status=${snap.by_status} unknown_statuses=0 v2_violations=0`);
      console.log(`[ps-497-0105] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${MIGRATION_RELPATH}`);
      return;
    }

    const beforeMaxId = await highWaterMark();
    const beforeSnap = await snapshot(beforeMaxId);

    // Resume-safe: run only the steps not yet done, in order (add both -> validate both -> drop old LAST).
    let p = before;
    if (!p.v2_present) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT ${V2_CHECK} CHECK ((quantity IS NOT NULL AND quantity > 0) OR (quantity IS NULL AND status IN ('review','not_applicable','superseded'))) NOT VALID`);
    if (!p.domain_present) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT ${DOMAIN_CHECK} CHECK (status IN ('pending','applied','superseded','reversed','review','not_applicable')) NOT VALID`);
    if (!p.v2_validated) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT ${V2_CHECK}`);
    if (!p.domain_validated) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT ${DOMAIN_CHECK}`);
    p = await inspect();
    // Drop the two superseded checks only once BOTH replacements are validated (a status domain and a
    // quantity-state contract are enforced the entire time). Order: 0090 quantity-state, then 0070 status.
    if (p.v2_validated && p.domain_validated) {
      if (p.old_present) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT ${OLD_CHECK}`);
      if (p.old_status_present) await client.unsafe(`ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT ${OLD_STATUS_CHECK}`);
    }

    const after = await inspect();
    const afterSnap = await snapshot(beforeMaxId);
    if (!isPhase0105(after)) throw new Error(`0105 verification failed: ${JSON.stringify(after)}`);
    if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
      throw new Error('0105 verification failed: a pre-existing claim status/quantity changed (0105 alters only constraints)');
    }
    console.log(`[ps-497-0105] applied=${JSON.stringify(after)} phase=0105`);
    console.log(`[ps-497-0105] claims_unchanged=true rows=${afterSnap.claim_count} no_status_or_quantity_rewritten=true`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-0105] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
