#!/usr/bin/env tsx
import 'dotenv/config';
import postgres from 'postgres';
import { readVerifiedMigration, splitMigration, MIGRATION_RELPATH } from './ps-497-fulfillment-occurrences-digest.js';

// PS-497 / PS-489 Slice 1 — apply migration 0104 (the fulfillment_occurrences identity) to a
// database. It refuses to run unless the migration file matches its pinned SHA-256, dry-runs by
// default, and gates apply on `--apply --confirm=<token>`.
//
// Per user override unlock shipped data on 2026-08-25: 0104 is pure additive DDL. It creates a new
// relation, adds nullable projection columns to the order-lifecycle sidecars, and builds two PARTIAL
// claim uniqueness indexes CONCURRENTLY. It never touches orders/shipments, moves no row, and leaves
// 0090's quantity_state_check intact. This runner proves all of that before and after, verifying
// EXACT catalog definitions (not merely names) so a malformed same-named object fails closed.

const CONFIRMATION = 'apply-ps-497-fulfillment-occurrences-0104';

// Bounded operational timeouts (env-overridable, PARSED and RANGE-CHECKED into milliseconds). A
// syntactically numeric value is not a bounded value: Postgres treats 0 as "disabled", so 0 / 0ms /
// an absurd duration / a unitless (ambiguous) value are all rejected. The unit is REQUIRED and the
// result must fall inside an explicit [min, max] ms window.
function parseTimeoutMs(name: string, fallback: string, minMs: number, maxMs: number): number {
  const raw = (process.env[name] ?? fallback).trim();
  const m = /^(\d+)\s*(ms|s|min)$/.exec(raw);
  if (!m) throw new Error(`${name}='${raw}' is not a valid bounded timeout (expected <n>ms|s|min with an explicit unit)`);
  const n = Number(m[1]);
  const ms = m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
  if (!Number.isSafeInteger(ms)) throw new Error(`${name}='${raw}' overflows a safe integer of milliseconds`);
  if (ms < minMs || ms > maxMs) {
    throw new Error(`${name}='${raw}' (${ms}ms) is outside the bounded range [${minMs}ms, ${maxMs}ms] — 0/disabled and unbounded values are refused`);
  }
  return ms;
}
// lock waits stay tight; the transactional metadata DDL is fast; the CONCURRENTLY builds may be long
// but must still have a real operational ceiling.
const LOCK_TIMEOUT_MS = parseTimeoutMs('PS497_LOCK_TIMEOUT', '5s', 1, 300_000); // (0, 5min]
const TXN_STATEMENT_TIMEOUT_MS = parseTimeoutMs('PS497_TXN_STATEMENT_TIMEOUT', '60s', 1_000, 600_000); // [1s, 10min]
const CONCURRENT_STATEMENT_TIMEOUT_MS = parseTimeoutMs('PS497_CONCURRENT_STATEMENT_TIMEOUT', '3600s', 1_000, 21_600_000); // [1s, 6h]

// pg_get_indexdef / pg_get_constraintdef are always schema-qualified and canonicalized by Postgres,
// so these exact strings are stable across environments and pin uniqueness, access method, key
// order, owning schema+table, and the partial predicates / CHECK expressions.
const EXPECTED_INDEXDEF: Record<string, string> = {
  fulfillment_occurrences_key_unq:
    'CREATE UNIQUE INDEX fulfillment_occurrences_key_unq ON public.fulfillment_occurrences USING btree (occurrence_key)',
  fulfillment_occurrences_order_idx:
    'CREATE INDEX fulfillment_occurrences_order_idx ON public.fulfillment_occurrences USING btree (order_id, id)',
  fulfillment_occurrences_shipment_unq:
    'CREATE UNIQUE INDEX fulfillment_occurrences_shipment_unq ON public.fulfillment_occurrences USING btree (shipment_id) WHERE (shipment_id IS NOT NULL)',
  fulfillment_line_claims_occ_line_dir_unq:
    'CREATE UNIQUE INDEX fulfillment_line_claims_occ_line_dir_unq ON public.fulfillment_line_claims USING btree (occurrence_id, canonical_line_identity, direction) WHERE (occurrence_id IS NOT NULL)',
  fulfillment_line_claims_reverse_original_unq:
    "CREATE UNIQUE INDEX fulfillment_line_claims_reverse_original_unq ON public.fulfillment_line_claims USING btree (original_claim_id) WHERE ((direction = 'reverse'::text) AND (original_claim_id IS NOT NULL))",
};
const EXPECTED_CHECKDEF: Record<string, string> = {
  fulfillment_line_claims_supply_chk:
    "CHECK (((supply IS NULL) OR (supply = ANY (ARRAY['prepship'::text, 'external'::text, 'unknown'::text]))))",
  fulfillment_line_claims_occ_identity_present_chk:
    'CHECK (((occurrence_id IS NULL) OR (canonical_line_identity IS NOT NULL)))',
  // The occurrences relation's OWN identity CHECK, so a malformed same-named table that omits it
  // (and would silently accept invalid discriminator_kind values) fails closed.
  fulfillment_occurrences_kind_chk:
    "CHECK ((discriminator_kind = ANY (ARRAY['provider_shipment'::text, 'local_shipment'::text, 'whole_order'::text])))",
  // 0090's quantity-state guard verified by EXACT definition + validation state, not merely by name.
  fulfillment_line_claims_quantity_state_check:
    "CHECK ((((quantity IS NOT NULL) AND (quantity > 0)) OR ((quantity IS NULL) AND (status = 'review'::text))))",
};
// The occurrences relation's PRIMARY KEY, so a same-named table lacking the PK contract fails closed.
const EXPECTED_PK: Record<string, string> = {
  fulfillment_occurrences_pkey: 'PRIMARY KEY (id)',
};
// Every column is verified for exact type + nullability + default, on BOTH the sidecar projection
// columns and the new fulfillment_occurrences relation's own structural columns. `defaultKind`:
// 'none' = must have no default; 'nextval' = serial sequence default; 'now' = now().
const EXPECTED_COLUMNS = [
  { table: 'order_lifecycle_events', column: 'occurrence_id', type: 'integer', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_line_claims', column: 'occurrence_id', type: 'integer', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_line_claims', column: 'canonical_line_identity', type: 'text', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_line_claims', column: 'supply', type: 'text', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'id', type: 'integer', nullable: false, defaultKind: 'nextval' },
  { table: 'fulfillment_occurrences', column: 'order_id', type: 'integer', nullable: false, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'shipment_id', type: 'integer', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'occurrence_key', type: 'text', nullable: false, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'discriminator_kind', type: 'text', nullable: false, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'first_seen_source', type: 'text', nullable: false, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'superseded_by_occurrence_id', type: 'integer', nullable: true, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'effective_at', type: 'timestamp with time zone', nullable: false, defaultKind: 'none' },
  { table: 'fulfillment_occurrences', column: 'created_at', type: 'timestamp with time zone', nullable: false, defaultKind: 'now' },
  { table: 'fulfillment_occurrences', column: 'updated_at', type: 'timestamp with time zone', nullable: false, defaultKind: 'now' },
] as const;
// FKs verified for referenced SCHEMA + table + column, single-column key, validation state, and the
// exact update/delete actions + match type (all NO ACTION 'a', MATCH SIMPLE 's').
const EXPECTED_FKS = [
  { table: 'order_lifecycle_events', column: 'occurrence_id', refSchema: 'public', refTable: 'fulfillment_occurrences', refColumn: 'id' },
  { table: 'fulfillment_line_claims', column: 'occurrence_id', refSchema: 'public', refTable: 'fulfillment_occurrences', refColumn: 'id' },
  { table: 'fulfillment_occurrences', column: 'order_id', refSchema: 'public', refTable: 'orders', refColumn: 'id' },
  { table: 'fulfillment_occurrences', column: 'superseded_by_occurrence_id', refSchema: 'public', refTable: 'fulfillment_occurrences', refColumn: 'id' },
] as const;
const CONCURRENT_INDEXES = [
  'fulfillment_line_claims_occ_line_dir_unq',
  'fulfillment_line_claims_reverse_original_unq',
] as const;

type SchemaState = {
  occurrences_table: boolean;
  columns_ok: boolean;
  indexes_ok: boolean;
  checks_ok: boolean;
  pk_ok: boolean;
  seq_ok: boolean;
  fks_ok: boolean;
};
type Inspection = { state: SchemaState; mismatches: string[] };
type ClaimsSnapshot = { claim_count: string; by_status: string; h1: string; h2: string };

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}
function ready(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

async function main(): Promise<void> {
  // FIRST: bind to the exact reviewed bytes, before we ever connect. Resolved relative to the repo
  // root, so the operator's cwd cannot point this at a stale/modified file.
  const { text: migration, digest } = readVerifiedMigration();

  // Defense-in-depth over the (already digest-pinned) bytes. The digest is the real guarantee; these
  // refusals fail loudly if the pinned constant were ever changed to accept a non-additive file.
  const stripped = migration.replace(/--[^\n]*/g, '');
  if (/\b(update|delete\s+from|insert\s+into|truncate|copy|merge)\b/i.test(stripped)) {
    throw new Error('Migration refused: DML / COPY / MERGE (or a data-modifying CTE) detected');
  }
  if (/\balter\s+table\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(?:orders|shipments)"?/i.test(stripped)) {
    throw new Error('Migration refused: shipped/cancelled protected tables must not be altered');
  }
  if (/\bdrop\s+(?:table|column|index|constraint|trigger|function|schema)\b/i.test(stripped)) {
    throw new Error('Migration refused: destructive DROP detected');
  }
  if (/\bcreate\s+(?:or\s+replace\s+)?(?:trigger|function|procedure)\b/i.test(stripped)) {
    throw new Error('Migration refused: trigger/function/procedure creation is not additive DDL');
  }
  if (/\b(execute|perform)\b/i.test(stripped)) {
    throw new Error('Migration refused: dynamic SQL (EXECUTE/PERFORM) detected');
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    // Pin the schema so no check or DDL can be redirected by a caller's search_path to another
    // schema's same-named object.
    connection: { application_name: 'ps-497-migration-0104', search_path: 'public' },
  });

  // Bound EVERY operation from the very first read: a tight lock_timeout so no statement — inspect,
  // pre-audit, snapshot, or apply — can wait indefinitely on a lock (the exact failure the earlier
  // lock-timeout gap allowed), and a generous-but-bounded statement_timeout for the large read scans
  // and the CONCURRENTLY builds. The transactional phase tightens statement_timeout via SET LOCAL.
  await client.unsafe(`set lock_timeout = '${LOCK_TIMEOUT_MS}'; set statement_timeout = '${CONCURRENT_STATEMENT_TIMEOUT_MS}';`);

  // Positively attest this session's identity so the post-run leak check has a proven selector.
  const [appRow] = await client<{ app: string }[]>`select current_setting('application_name') as app`;
  if (appRow?.app !== 'ps-497-migration-0104') {
    throw new Error(`unexpected application_name '${appRow?.app}' — refusing to proceed under an unattested session identity`);
  }
  console.log(`[ps-497-0104] session application_name=${appRow.app}`);

  // Exact-catalog inspection. `ready` requires EVERY object to match its exact definition, so a
  // malformed same-named table/index/column/FK/CHECK can never satisfy already_applied.
  const inspect = async (): Promise<Inspection> => {
    const mismatches: string[] = [];

    const tableRows = await client<{ has_table: boolean }[]>`
      select to_regclass('public.fulfillment_occurrences') is not null as has_table
    `;
    const has_table = tableRows[0]?.has_table ?? false;

    const colRows = await client<
      { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('order_lifecycle_events','fulfillment_line_claims','fulfillment_occurrences')
    `;
    let columnsOk = true;
    for (const want of EXPECTED_COLUMNS) {
      const got = colRows.find((r) => r.table_name === want.table && r.column_name === want.column);
      if (!got) { columnsOk = false; mismatches.push(`column:${want.table}.${want.column} missing`); continue; }
      if (got.data_type !== want.type) { columnsOk = false; mismatches.push(`column:${want.table}.${want.column} type=${got.data_type} want ${want.type}`); }
      const wantNullable = want.nullable ? 'YES' : 'NO';
      if (got.is_nullable !== wantNullable) { columnsOk = false; mismatches.push(`column:${want.table}.${want.column} nullable=${got.is_nullable} want ${wantNullable}`); }
      const def = got.column_default;
      if (want.defaultKind === 'none') {
        if (def !== null) { columnsOk = false; mismatches.push(`column:${want.table}.${want.column} unexpected default ${def}`); }
      } else if (want.defaultKind === 'nextval') {
        // Exact default: the id must default from THIS table's own sequence, not merely some nextval.
        if (def !== "nextval('fulfillment_occurrences_id_seq'::regclass)") {
          columnsOk = false;
          mismatches.push(`column:${want.table}.${want.column} default=${def} want nextval('fulfillment_occurrences_id_seq'::regclass)`);
        }
      } else if (want.defaultKind === 'now') {
        if (def !== 'now()') { columnsOk = false; mismatches.push(`column:${want.table}.${want.column} default=${def} want now()`); }
      }
    }

    const idxRows = await client<{ name: string; def: string; valid: boolean }[]>`
      select c.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${Object.keys(EXPECTED_INDEXDEF)})
    `;
    let indexesOk = true;
    for (const [name, want] of Object.entries(EXPECTED_INDEXDEF)) {
      const got = idxRows.find((r) => r.name === name);
      if (!got) { indexesOk = false; mismatches.push(`index:${name} missing`); continue; }
      if (!got.valid) { indexesOk = false; mismatches.push(`index:${name} INVALID`); }
      if (got.def !== want) { indexesOk = false; mismatches.push(`index:${name} def mismatch: ${got.def}`); }
    }

    const chkRows = await client<{ name: string; def: string; validated: boolean }[]>`
      select con.conname as name, pg_get_constraintdef(con.oid) as def, con.convalidated as validated
      from pg_constraint con
      join pg_class r on r.oid = con.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname in ('fulfillment_line_claims','fulfillment_occurrences')
        and con.conname = any(${Object.keys(EXPECTED_CHECKDEF)})
    `;
    let checksOk = true;
    for (const [name, want] of Object.entries(EXPECTED_CHECKDEF)) {
      const got = chkRows.find((r) => r.name === name);
      if (!got) { checksOk = false; mismatches.push(`check:${name} missing`); continue; }
      if (!got.validated) { checksOk = false; mismatches.push(`check:${name} NOT VALIDATED`); }
      if (got.def !== want) { checksOk = false; mismatches.push(`check:${name} def mismatch: ${got.def}`); }
    }

    const fkRows = await client<
      { tbl: string; col: string; refschema: string; ref: string; refcol: string; upd: string; del: string; mt: string; keylen: number | null; validated: boolean }[]
    >`
      select r.relname as tbl, a.attname as col, ns.nspname as refschema, cr.relname as ref, ca.attname as refcol,
             con.confupdtype as upd, con.confdeltype as del, con.confmatchtype as mt, array_length(con.conkey, 1) as keylen,
             con.convalidated as validated
      from pg_constraint con
      join pg_class r on r.oid = con.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      join pg_class cr on cr.oid = con.confrelid
      join pg_namespace ns on ns.oid = cr.relnamespace
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      join pg_attribute ca on ca.attrelid = con.confrelid and ca.attnum = con.confkey[1]
      where con.contype = 'f' and n.nspname = 'public'
        and ((r.relname = 'order_lifecycle_events' and a.attname = 'occurrence_id')
          or (r.relname = 'fulfillment_line_claims' and a.attname = 'occurrence_id')
          or (r.relname = 'fulfillment_occurrences' and a.attname in ('order_id','superseded_by_occurrence_id')))
    `;
    let fksOk = true;
    for (const want of EXPECTED_FKS) {
      const got = fkRows.find((r) => r.tbl === want.table && r.col === want.column);
      if (!got) { fksOk = false; mismatches.push(`fk:${want.table}.${want.column} missing`); continue; }
      if (got.refschema !== want.refSchema || got.ref !== want.refTable || got.refcol !== want.refColumn) {
        fksOk = false;
        mismatches.push(`fk:${want.table}.${want.column} -> ${got.refschema}.${got.ref}.${got.refcol} want ${want.refSchema}.${want.refTable}.${want.refColumn}`);
      }
      // NO ACTION on update/delete ('a'), MATCH SIMPLE ('s'), single-column key, and VALIDATED. A
      // weakened FK (ON DELETE CASCADE, composite key, or — the round-4 gap — NOT VALID) is a
      // different contract and fails closed.
      if (got.upd !== 'a' || got.del !== 'a' || got.mt !== 's' || got.keylen !== 1) {
        fksOk = false;
        mismatches.push(`fk:${want.table}.${want.column} upd=${got.upd} del=${got.del} match=${got.mt} keylen=${got.keylen} want a/a/s/1`);
      }
      if (!got.validated) {
        fksOk = false;
        mismatches.push(`fk:${want.table}.${want.column} NOT VALIDATED`);
      }
    }

    // PK bound to fulfillment_occurrences itself (r.relname), so a decoy PK of the expected name on
    // another public relation cannot satisfy pk_ok.
    const pkRows = await client<{ name: string; def: string }[]>`
      select con.conname as name, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class r on r.oid = con.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = 'fulfillment_occurrences'
        and con.contype = 'p' and con.conname = any(${Object.keys(EXPECTED_PK)})
    `;
    let pkOk = true;
    for (const [name, want] of Object.entries(EXPECTED_PK)) {
      const got = pkRows.find((r) => r.name === name);
      if (!got) { pkOk = false; mismatches.push(`pk:${name} missing`); continue; }
      if (got.def !== want) { pkOk = false; mismatches.push(`pk:${name} def mismatch: ${got.def}`); }
    }

    // The id column's default sequence must be OWNED BY public.fulfillment_occurrences.id, not just
    // "some nextval". pg_get_serial_sequence returns the owned sequence (schema-qualified) or NULL.
    const [seqRow] = await client<{ seq: string | null }[]>`
      select case
               when to_regclass('public.fulfillment_occurrences') is null then null
               else pg_get_serial_sequence('public.fulfillment_occurrences', 'id')
             end as seq
    `;
    const pkSeqOk = seqRow?.seq === 'public.fulfillment_occurrences_id_seq';
    if (!pkSeqOk) mismatches.push(`sequence: id owned-sequence=${seqRow?.seq} want public.fulfillment_occurrences_id_seq`);
    return {
      state: {
        occurrences_table: has_table,
        columns_ok: columnsOk,
        indexes_ok: indexesOk,
        checks_ok: checksOk,
        pk_ok: pkOk,
        seq_ok: pkSeqOk,
        fks_ok: fksOk,
      },
      mismatches,
    };
  };

  // The claim table is untouched by this migration. The integrity guard snapshots only rows that
  // existed BEFORE the apply (id <= a pre-apply high-water mark frozen ONCE). The checksum is a
  // BOUNDED, order-independent set hash (two numeric sums of per-row md5 halves) — no giant
  // string_agg is materialized, so memory is O(1) regardless of the historical row count.
  //
  // ASSUMPTION: fulfillment_line_claims.id is serial, so concurrent inserts land ABOVE the frozen
  // max and are ignored. CONSERVATIVE-RED SEMANTICS: a concurrent UPDATE/DELETE of a pre-apply row
  // trips a conservative red (drift proven, cause not attributed) — run in a quiet window / re-run.
  const highWaterMark = async (): Promise<string> => {
    const [row] = await client<{ max_id: string }[]>`
      select coalesce(max(id), 0)::text as max_id from public.fulfillment_line_claims
    `;
    return row?.max_id ?? '0';
  };
  const totalClaims = async (): Promise<number> => {
    const [row] = await client<{ n: string }[]>`
      select count(*)::text as n from public.fulfillment_line_claims
    `;
    return Number(row?.n ?? '0');
  };
  const snapshot = async (maxId: string): Promise<ClaimsSnapshot> => {
    const [state] = await client<ClaimsSnapshot[]>`
      select
        (select count(*)::text from public.fulfillment_line_claims where id <= ${maxId}::int) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (
             select status, count(*)::text as n from public.fulfillment_line_claims
             where id <= ${maxId}::int group by status
           ) s
        ) as by_status,
        coalesce((select sum(('x' || substr(md5(r), 1, 16))::bit(64)::bigint::numeric)::text
           from (select to_jsonb(row(
             id, lifecycle_event_id, order_id, shipment_id, line_key, sku, name, quantity,
             direction, original_claim_id, inventory_id, status, idempotency_key, attempts,
             last_error, applied_at, created_at, updated_at
           ))::text as r from public.fulfillment_line_claims where id <= ${maxId}::int) rows), '0') as h1,
        coalesce((select sum(('x' || substr(md5(r), 17, 16))::bit(64)::bigint::numeric)::text
           from (select to_jsonb(row(
             id, lifecycle_event_id, order_id, shipment_id, line_key, sku, name, quantity,
             direction, original_claim_id, inventory_id, status, idempotency_key, attempts,
             last_error, applied_at, created_at, updated_at
           ))::text as r from public.fulfillment_line_claims where id <= ${maxId}::int) rows), '0') as h2
    `;
    if (!state) throw new Error('PS-497 0104 claims snapshot returned no row');
    return state;
  };

  const reverseDuplicates = async (): Promise<number> => {
    const rows = await client<{ original_claim_id: number }[]>`
      select original_claim_id
      from public.fulfillment_line_claims
      where direction = 'reverse' and original_claim_id is not null
      group by original_claim_id
      having count(*) > 1
    `;
    return rows.length;
  };

  const dropInvalidConcurrentIndexes = async (): Promise<void> => {
    for (const name of CONCURRENT_INDEXES) {
      const [row] = await client<{ invalid: boolean }[]>`
        select (i.indisvalid = false) as invalid
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
        where n.nspname = 'public' and c.relname = ${name}
      `;
      if (row?.invalid) {
        console.log(`[ps-497-0104] dropping invalid index ${name} before rebuild`);
        await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
      }
    }
  };

  try {
    console.log(`[ps-497-0104] migration digest verified: ${digest}`);
    const before = await inspect();
    console.log(`[ps-497-0104] current=${JSON.stringify(before.state)}`);
    if (before.mismatches.length) console.log(`[ps-497-0104] mismatches=${JSON.stringify(before.mismatches)}`);
    if (ready(before.state)) {
      console.log('[ps-497-0104] already_applied=true');
      return;
    }

    const dupes = await reverseDuplicates();
    if (dupes > 0) {
      throw new Error(
        `Migration refused: ${dupes} original_claim_id value(s) already carry >1 reverse claim. ` +
          `The global reversal unique index cannot be built until an operator resolves them.`,
      );
    }

    if (!approved()) {
      const snap = await snapshot(await highWaterMark());
      console.log(`[ps-497-0104] claims=${snap.claim_count} by_status=${snap.by_status}`);
      console.log(`[ps-497-0104] reverse_duplicates=0`);
      console.log(`[ps-497-0104] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${MIGRATION_RELPATH}`);
      return;
    }

    const { transactional, concurrent } = splitMigration(migration);
    const beforeMaxId = await highWaterMark();
    const beforeTotal = await totalClaims();
    const beforeSnap = await snapshot(beforeMaxId);

    await client.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = '${LOCK_TIMEOUT_MS}'; set local statement_timeout = '${TXN_STATEMENT_TIMEOUT_MS}';`);
      const [t] = await tx<{ lt: string; st: string }[]>`select current_setting('lock_timeout') as lt, current_setting('statement_timeout') as st`;
      console.log(`[ps-497-0104] txn timeouts lock_timeout=${t?.lt} statement_timeout=${t?.st}`);
      await tx.unsafe(transactional);
    });

    // The transactional phase's SET LOCAL reverted on commit, so the session is back to the bounded
    // baseline (tight lock_timeout, generous statement_timeout) — exactly what the CONCURRENTLY
    // builds and the recovery DROP INDEX CONCURRENTLY need. Confirm and log it; no reset that would
    // drop back to an unbounded 0.
    const [ct] = await client<{ lt: string; st: string }[]>`select current_setting('lock_timeout') as lt, current_setting('statement_timeout') as st`;
    console.log(`[ps-497-0104] concurrent timeouts lock_timeout=${ct?.lt} statement_timeout=${ct?.st}`);
    await dropInvalidConcurrentIndexes();
    for (const statement of concurrent) {
      await client.unsafe(statement);
    }

    const afterSnap = await snapshot(beforeMaxId);
    const afterTotal = await totalClaims();
    const after = await inspect();

    if (!ready(after.state)) {
      throw new Error(
        `PS-497 0104 migration verification failed: ${JSON.stringify(after.state)} ` +
          `mismatches=${JSON.stringify(after.mismatches)}`,
      );
    }
    if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
      throw new Error(
        'Migration verification failed: a pre-existing claim (id <= the frozen high-water mark) was ' +
          'mutated or removed during the apply. The schema DDL is additive and applied successfully, so ' +
          'this is a conservative red from concurrent app activity — re-run in a quiet window to clear it.',
      );
    }
    if (afterTotal < beforeTotal) {
      throw new Error(`Migration verification failed: total claim count dropped ${beforeTotal} -> ${afterTotal}`);
    }

    console.log(`[ps-497-0104] applied=${JSON.stringify(after.state)}`);
    console.log(
      `[ps-497-0104] preexisting_claims_unchanged=true preexisting_rows=${afterSnap.claim_count} total_rows=${afterTotal}`,
    );
    console.log('[ps-497-0104] exact_catalog_verified=true quantity_state_check_intact=true');
    console.log('[ps-497-0104] orders_shipments_untouched=true no_backfill_performed=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-0104] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
