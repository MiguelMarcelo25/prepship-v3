#!/usr/bin/env tsx
import 'dotenv/config';
import postgres from 'postgres';
import { readVerifiedMigration, migrationStatements, MIGRATION_RELPATH } from './ps-497-claim-status-migration-digest.js';

// PS-497 Slice 2 — apply migration 0105 (claim status 'not_applicable' + quantity-state replacement).
// Dry-run by default; `--apply --confirm=<token>` required. Hardening for the Release A re-audit:
//   * it EXECUTES the statements parsed from the digest-pinned migration file (never a hardcoded copy),
//     so the 62a5b82d… digest cryptographically binds the SQL the runner actually applies (blocker 2);
//   * it recognises ONLY the seven exact 0104->0105 phases, each bound to public.fulfillment_line_claims,
//     contype='c', the exact normalized pg_get_constraintdef, and the exact validation state — every other
//     catalog shape (same name/wrong def, wrong contype, unvalidated successor, missing old check) is a
//     MALFORMED refusal, never a guessed "resumable" or "already_applied" (blocker 1);
//   * the byte-identical claim proof checksums EVERY column via to_jsonb(row) over the frozen id range,
//     not just id/quantity/status (addendum 1).
// It still pre-audits every status/quantity combination and STOPS on an unknown status (never rewrites
// data), runs each statement standalone under bounded timeouts, and adds+validates BOTH successor
// constraints before dropping the two legacy checks.

const CONFIRMATION = 'apply-ps-497-claim-not-applicable-status-0105';
const KNOWN_STATUSES = ['pending', 'applied', 'superseded', 'reversed', 'review', 'not_applicable'];

const V2_CHECK = 'fulfillment_line_claims_quantity_state_v2_check';
const DOMAIN_CHECK = 'fulfillment_line_claims_status_domain_check';
const OLD_QTY_CHECK = 'fulfillment_line_claims_quantity_state_check'; // 0090
const OLD_STATUS_CHECK = 'fulfillment_line_claims_status_check'; // 0070 inline (five-value)

// Exact PG17 pg_get_constraintdef renderings (captured from real PostgreSQL 17). Names alone are
// insufficient for a migration that changes the legal claim status/quantity contract, so each phase
// binds the constraint to its EXACT definition; a same-named but differently-defined constraint is
// refused as MALFORMED rather than accepted.
const EXPECTED_DEF: Record<string, string> = {
  [V2_CHECK]:
    "CHECK ((((quantity IS NOT NULL) AND (quantity > 0)) OR ((quantity IS NULL) AND (status = ANY (ARRAY['review'::text, 'not_applicable'::text, 'superseded'::text])))))",
  [DOMAIN_CHECK]:
    "CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'superseded'::text, 'reversed'::text, 'review'::text, 'not_applicable'::text])))",
  [OLD_QTY_CHECK]:
    "CHECK ((((quantity IS NOT NULL) AND (quantity > 0)) OR ((quantity IS NULL) AND (status = 'review'::text))))",
  [OLD_STATUS_CHECK]:
    "CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'superseded'::text, 'reversed'::text, 'review'::text])))",
};

// The six migration statements, in order — used ONLY to prove the parsed pinned file is the expected
// contract before any of it runs (the bytes executed are still the parsed migration, not these regexes).
const EXPECTED_STATEMENTS: RegExp[] = [
  /^ALTER TABLE public\.fulfillment_line_claims\s+ADD CONSTRAINT fulfillment_line_claims_quantity_state_v2_check\b[\s\S]*\bNOT VALID$/i,
  /^ALTER TABLE public\.fulfillment_line_claims\s+ADD CONSTRAINT fulfillment_line_claims_status_domain_check\b[\s\S]*\bNOT VALID$/i,
  /^ALTER TABLE public\.fulfillment_line_claims\s+VALIDATE CONSTRAINT fulfillment_line_claims_quantity_state_v2_check$/i,
  /^ALTER TABLE public\.fulfillment_line_claims\s+VALIDATE CONSTRAINT fulfillment_line_claims_status_domain_check$/i,
  /^ALTER TABLE public\.fulfillment_line_claims\s+DROP CONSTRAINT fulfillment_line_claims_quantity_state_check$/i,
  /^ALTER TABLE public\.fulfillment_line_claims\s+DROP CONSTRAINT fulfillment_line_claims_status_check$/i,
];

// The seven exact phases of the 0104->0105 transition (any other combination is MALFORMED).
type Phase =
  | 'phase_0104' // both successors absent; both legacy checks present+valid
  | 'phase_v2_added' // v2 present NOT VALID; domain absent; legacy present+valid
  | 'phase_both_added' // v2+domain present NOT VALID; legacy present+valid
  | 'phase_v2_validated' // v2 valid; domain NOT VALID; legacy present+valid
  | 'phase_both_validated' // v2+domain valid; both legacy present+valid
  | 'phase_0090_dropped' // v2+domain valid; 0090 absent; 0070 status present+valid
  | 'phase_0105'; // v2+domain valid; both legacy absent

// remainingSteps[phase] = the parsed-statement indices still to run, in order.
const REMAINING: Record<Phase, number[]> = {
  phase_0104: [0, 1, 2, 3, 4, 5],
  phase_v2_added: [1, 2, 3, 4, 5],
  phase_both_added: [2, 3, 4, 5],
  phase_v2_validated: [3, 4, 5],
  phase_both_validated: [4, 5],
  phase_0090_dropped: [5],
  phase_0105: [],
};

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

type ConState = { present: boolean; defExact: boolean; validated: boolean };
type ClaimsSnapshot = { claim_count: string; by_status: string; checksum_lo: string; checksum_hi: string };

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}
function normalizeDef(def: string): string {
  // pg_get_constraintdef appends ' NOT VALID' for an unvalidated constraint; validity is tracked
  // separately (convalidated), so the definition comparison is over the CHECK expression alone.
  return def.replace(/\s+/g, ' ').replace(/\s*NOT VALID\s*$/i, '').trim();
}

/** Validate that the parsed, digest-pinned migration is exactly the six expected statements, in order. */
function verifyParsedStatements(parsed: string[]): string[] {
  if (parsed.length !== EXPECTED_STATEMENTS.length) {
    throw new Error(`Migration parsed into ${parsed.length} statements; expected ${EXPECTED_STATEMENTS.length}`);
  }
  parsed.forEach((stmt, i) => {
    const normalized = stmt.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    const re = EXPECTED_STATEMENTS[i];
    if (!re || !re.test(normalized)) {
      throw new Error(`Migration statement ${i} does not match its expected class/order: ${normalized.slice(0, 120)}`);
    }
  });
  return parsed;
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

  // Parse+verify the pinned statements BEFORE connecting; these exact bytes are what we execute.
  const statements = verifyParsedStatements(migrationStatements(migration));

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = postgres(databaseUrl, {
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: 'ps-497-migration-0105', search_path: 'public' },
  });

  const conState = async (name: string): Promise<ConState> => {
    const [row] = await client<{ contype: string; validated: boolean | null; def: string }[]>`
      select con.contype::text as contype, con.convalidated as validated, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class r on r.oid = con.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = 'fulfillment_line_claims' and con.conname = ${name}
    `;
    if (!row) return { present: false, defExact: false, validated: false };
    const expected = EXPECTED_DEF[name];
    const defExact = row.contype === 'c' && expected !== undefined && normalizeDef(row.def) === normalizeDef(expected);
    return { present: true, defExact, validated: row.validated === true };
  };

  const classifyPhase = (v2: ConState, dom: ConState, q90: ConState, st70: ConState): Phase | 'malformed' => {
    // Any constraint that exists under a known name but with the wrong contype/definition = MALFORMED.
    for (const c of [v2, dom, q90, st70]) {
      if (c.present && !c.defExact) return 'malformed';
    }
    const legacyReady = q90.present && q90.validated && st70.present && st70.validated;
    if (!v2.present && !dom.present && legacyReady) return 'phase_0104';
    if (v2.present && !v2.validated && !dom.present && legacyReady) return 'phase_v2_added';
    if (v2.present && !v2.validated && dom.present && !dom.validated && legacyReady) return 'phase_both_added';
    if (v2.present && v2.validated && dom.present && !dom.validated && legacyReady) return 'phase_v2_validated';
    if (v2.present && v2.validated && dom.present && dom.validated && legacyReady) return 'phase_both_validated';
    if (v2.present && v2.validated && dom.present && dom.validated && !q90.present && st70.present && st70.validated) return 'phase_0090_dropped';
    if (v2.present && v2.validated && dom.present && dom.validated && !q90.present && !st70.present) return 'phase_0105';
    return 'malformed';
  };
  const inspect = async (): Promise<Phase | 'malformed'> => {
    const [v2, dom, q90, st70] = await Promise.all([
      conState(V2_CHECK), conState(DOMAIN_CHECK), conState(OLD_QTY_CHECK), conState(OLD_STATUS_CHECK),
    ]);
    return classifyPhase(v2, dom, q90, st70);
  };
  const highWaterMark = async (): Promise<string> => {
    const [row] = await client<{ m: string }[]>`select coalesce(max(id),0)::text as m from fulfillment_line_claims`;
    return row?.m ?? '0';
  };
  // Byte-identical proof over the frozen id range: two order-independent numeric sums of md5 halves of
  // to_jsonb(row) — EVERY protected column, O(1) memory. Any change to any field moves a checksum.
  const snapshot = async (maxId: string): Promise<ClaimsSnapshot> => {
    const [row] = await client<ClaimsSnapshot[]>`
      select
        (select count(*)::text from fulfillment_line_claims where id <= ${maxId}::int) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (select status, count(*)::text n from fulfillment_line_claims where id <= ${maxId}::int group by status) s) as by_status,
        coalesce((select sum(('x' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint::numeric)::text
           from fulfillment_line_claims t where t.id <= ${maxId}::int), '0') as checksum_lo,
        coalesce((select sum(('x' || substr(md5(to_jsonb(t)::text), 17, 16))::bit(64)::bigint::numeric)::text
           from fulfillment_line_claims t where t.id <= ${maxId}::int), '0') as checksum_hi
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
    console.log(`[ps-497-0105] phase=${before}`);
    if (before === 'malformed') {
      throw new Error('Refused: the claim-check catalog is not one of the seven exact 0104->0105 phases (same-named/wrong-def, wrong contype, unvalidated successor, or a missing legacy check). Resolve manually — never auto-guessed as resumable.');
    }
    if (before === 'phase_0105') { console.log('[ps-497-0105] already_applied=true (phase 0105)'); return; }

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

    // Resume-safe: execute only the parsed pinned statements still remaining for this exact phase, in order.
    for (const idx of REMAINING[before]) {
      const stmt = statements[idx];
      if (!stmt) throw new Error(`internal: no parsed statement at index ${idx}`);
      await client.unsafe(stmt);
    }

    const after = await inspect();
    const afterSnap = await snapshot(beforeMaxId);
    if (after !== 'phase_0105') throw new Error(`0105 verification failed: catalog is '${after}', not the exact phase_0105`);
    if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
      throw new Error('0105 verification failed: a pre-existing claim row changed (0105 alters only constraints, never data)');
    }
    console.log(`[ps-497-0105] applied=true phase=0105`);
    console.log(`[ps-497-0105] claims_unchanged=true rows=${afterSnap.claim_count} full_row_checksum_stable=true`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-0105] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
