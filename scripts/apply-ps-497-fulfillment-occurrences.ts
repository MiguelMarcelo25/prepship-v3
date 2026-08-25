#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// PS-497 / PS-489 Slice 1 — apply migration 0104 (the fulfillment_occurrences identity) to a
// database. Dry run by default; `--apply --confirm=<token>` is required to touch the database.
//
// Per user override unlock shipped data on 2026-08-25: 0104 is pure additive DDL. It creates a new
// relation, adds nullable projection columns to the order-lifecycle sidecars, and builds two
// PARTIAL claim uniqueness indexes CONCURRENTLY. It never touches orders/shipments, moves no row,
// and leaves 0090's quantity_state_check intact. This runner proves all of that before and after.
//
// The migration file carries a `-- >>> NON-TRANSACTIONAL <<<` sentinel: everything above runs in a
// single transaction (metadata-only DDL); everything below is CREATE INDEX CONCURRENTLY / VALIDATE
// and must run outside any transaction, one statement at a time.

const CONFIRMATION = 'apply-ps-497-fulfillment-occurrences-0104';
const migrationPath = 'drizzle/0104_ps497_fulfillment_occurrences.sql';
const NON_TX_SENTINEL = '-- >>> NON-TRANSACTIONAL <<<';

const REQUIRED_INDEXES = [
  'fulfillment_occurrences_key_unq',
  'fulfillment_occurrences_order_idx',
  'fulfillment_occurrences_shipment_unq',
  'fulfillment_line_claims_occ_line_dir_unq',
  'fulfillment_line_claims_reverse_original_unq',
] as const;

const CONCURRENT_INDEXES = [
  'fulfillment_line_claims_occ_line_dir_unq',
  'fulfillment_line_claims_reverse_original_unq',
] as const;

const REQUIRED_CONSTRAINTS = [
  'fulfillment_line_claims_supply_chk',
  'fulfillment_line_claims_occ_identity_present_chk',
] as const;

type SchemaState = {
  occurrences_table: boolean;
  event_occurrence_column: boolean;
  claim_occurrence_column: boolean;
  claim_identity_column: boolean;
  claim_supply_column: boolean;
  indexes_present_valid: boolean;
  constraints_present: boolean;
  quantity_state_check_intact: boolean;
};

type ClaimsSnapshot = {
  claim_count: string;
  by_status: string;
  claim_checksum: string;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}

function ready(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

/** Split the migration into its transactional block and the ordered non-transactional statements. */
function splitMigration(sql: string): { transactional: string; concurrent: string[] } {
  // Anchor on the sentinel as its own line so a mention of the marker text inside a comment
  // cannot be mistaken for the real split point.
  const marker = `\n${NON_TX_SENTINEL}`;
  const markerAt = sql.indexOf(marker);
  if (markerAt < 0) throw new Error(`migration is missing the ${NON_TX_SENTINEL} sentinel line`);
  const transactional = sql.slice(0, markerAt);
  const concurrent = sql
    .slice(markerAt + marker.length)
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((stmt) => stmt.length > 0);
  return { transactional, concurrent };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-497-migration-0104' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        to_regclass('public.fulfillment_occurrences') is not null as occurrences_table,
        exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='order_lifecycle_events'
            and column_name='occurrence_id') as event_occurrence_column,
        exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='fulfillment_line_claims'
            and column_name='occurrence_id') as claim_occurrence_column,
        exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='fulfillment_line_claims'
            and column_name='canonical_line_identity') as claim_identity_column,
        exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='fulfillment_line_claims'
            and column_name='supply') as claim_supply_column,
        (
          select count(*) = ${REQUIRED_INDEXES.length}
          from pg_class c
          join pg_index i on i.indexrelid = c.oid
          where c.relname = any(${[...REQUIRED_INDEXES]}) and i.indisvalid
        ) as indexes_present_valid,
        (
          select count(*) = ${REQUIRED_CONSTRAINTS.length}
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          where rel.relname = 'fulfillment_line_claims'
            and con.conname = any(${[...REQUIRED_CONSTRAINTS]})
            and con.convalidated
        ) as constraints_present,
        exists (select 1 from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          where rel.relname = 'fulfillment_line_claims'
            and con.conname = 'fulfillment_line_claims_quantity_state_check') as quantity_state_check_intact
    `;
    if (!state) throw new Error('PS-497 0104 schema inspection returned no row');
    return state;
  };

  // This migration touches no claim ROW. But it runs ONLINE: the two CONCURRENTLY index builds take
  // minutes on the live, growing claim table, and the app keeps inserting claims throughout. So the
  // integrity guard snapshots only the rows that existed BEFORE the apply (id <= a pre-apply
  // high-water mark frozen ONCE, never recomputed). Any UPDATE/DELETE of a pre-existing row still
  // trips it; benign concurrent inserts (which receive higher, sequence-generated ids) are ignored.
  //
  // ASSUMPTION (documented per the Hermes ruling): fulfillment_line_claims.id is serial /
  // sequence-generated, so every concurrent insert lands ABOVE the frozen max and cannot slip into
  // the bounded set. No writer supplies an explicit low id.
  //
  // CONSERVATIVE-RED SEMANTICS: the checksum proves DRIFT, not its cause. If the live app legitimately
  // UPDATEs a pre-apply claim (e.g. a status transition) or DELETEs one during the apply window, the
  // guard fails CLOSED — a conservative red — even though the migration itself changed nothing. That
  // is safe (no corruption; the schema apply already succeeded and an idempotent re-run reports
  // already_applied). Run the apply in a quiet window, or re-run to clear a benign concurrent-update red.
  const highWaterMark = async (): Promise<string> => {
    const [row] = await client<{ max_id: string }[]>`
      select coalesce(max(id), 0)::text as max_id from fulfillment_line_claims
    `;
    return row?.max_id ?? '0';
  };

  const totalClaims = async (): Promise<number> => {
    const [row] = await client<{ n: string }[]>`
      select count(*)::text as n from fulfillment_line_claims
    `;
    return Number(row?.n ?? '0');
  };

  // The checksum covers the PRIMARY KEY plus EVERY pre-migration column, null/type-preserving via
  // to_jsonb (JSON null is distinct from the string 'null'). It names only the 18 columns that
  // existed before 0104, so the new nullable columns never make before/after differ structurally.
  const snapshot = async (maxId: string): Promise<ClaimsSnapshot> => {
    const [state] = await client<ClaimsSnapshot[]>`
      select
        (select count(*)::text from fulfillment_line_claims where id <= ${maxId}::int) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (
             select status, count(*)::text as n from fulfillment_line_claims
             where id <= ${maxId}::int group by status
           ) s
        ) as by_status,
        (select coalesce(md5(string_agg(
            to_jsonb(row(
              id, lifecycle_event_id, order_id, shipment_id, line_key, sku, name, quantity,
              direction, original_claim_id, inventory_id, status, idempotency_key, attempts,
              last_error, applied_at, created_at, updated_at
            ))::text, ',' order by id)), 'empty')::text
           from fulfillment_line_claims where id <= ${maxId}::int) as claim_checksum
    `;
    if (!state) throw new Error('PS-497 0104 claims snapshot returned no row');
    return state;
  };

  // Uniqueness key #2 is GLOBAL over history: the CONCURRENTLY build cannot create over an existing
  // duplicate. Abort for operator resolution rather than fail mid-build (same class as the
  // shipments.label_shipment_id unique-index blocker).
  const reverseDuplicates = async (): Promise<number> => {
    const rows = await client<{ original_claim_id: number }[]>`
      select original_claim_id
      from fulfillment_line_claims
      where direction = 'reverse' and original_claim_id is not null
      group by original_claim_id
      having count(*) > 1
    `;
    return rows.length;
  };

  // A prior interrupted run can leave an INVALID index; `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
  // would then see it and skip forever. Drop any invalid one so the build re-creates it.
  const dropInvalidConcurrentIndexes = async (): Promise<void> => {
    for (const name of CONCURRENT_INDEXES) {
      const [row] = await client<{ invalid: boolean }[]>`
        select (i.indisvalid = false) as invalid
        from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = ${name}
      `;
      if (row?.invalid) {
        console.log(`[ps-497-0104] dropping invalid index ${name} before rebuild`);
        await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      }
    }
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-497-0104] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
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
      const before = await snapshot(await highWaterMark());
      console.log(`[ps-497-0104] claims=${before.claim_count} by_status=${before.by_status}`);
      console.log(`[ps-497-0104] reverse_duplicates=0`);
      console.log(
        `[ps-497-0104] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const raw = readFileSync(migrationPath, 'utf8');
    const stripped = raw.replace(/--[^\n]*/g, '');
    // DML — bare UPDATE/DELETE FROM/INSERT INTO/TRUNCATE. This also catches a writable CTE
    // (WITH x AS (INSERT/UPDATE/DELETE ...)) because its inner verb matches here.
    if (/\b(update|delete\s+from|insert\s+into|truncate)\b/i.test(stripped)) {
      throw new Error('Migration refused: DML (or a data-modifying CTE) detected in a DDL-only migration');
    }
    if (/\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i.test(stripped)) {
      throw new Error('Migration refused: shipped/cancelled protected tables must not be altered');
    }
    if (/\bdrop\s+(?:table|column)\b/i.test(stripped)) {
      throw new Error('Migration refused: destructive table/column DROP detected');
    }
    // No trigger/function/procedure creation (a rewrite hook) and no dynamic SQL: this migration is
    // pure additive DDL + anonymous DO blocks that only add constraints. EXECUTE would be dynamic SQL.
    if (/\bcreate\s+(?:or\s+replace\s+)?(?:trigger|function|procedure)\b/i.test(stripped)) {
      throw new Error('Migration refused: trigger/function/procedure creation is not part of this additive migration');
    }
    if (/\bexecute\b/i.test(stripped)) {
      throw new Error('Migration refused: dynamic SQL (EXECUTE) detected');
    }

    const { transactional, concurrent } = splitMigration(raw);
    // High-water mark taken before ANY apply work, so the after-check only compares rows that
    // predate the migration and cannot be tricked by the live app's concurrent inserts.
    const beforeMaxId = await highWaterMark();
    const beforeTotal = await totalClaims();
    const before = await snapshot(beforeMaxId);

    await client.begin(async (tx) => {
      await tx.unsafe(transactional);
    });

    await dropInvalidConcurrentIndexes();
    for (const statement of concurrent) {
      await client.unsafe(statement);
    }

    const after = await snapshot(beforeMaxId);
    const afterTotal = await totalClaims();
    const afterState = await inspect();

    if (!ready(afterState)) {
      throw new Error(`PS-497 0104 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    // Pre-existing claims (id <= beforeMaxId) must be byte-identical: the live app may only have
    // ADDED claims during the online apply, never mutated or removed a pre-existing one.
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(
        'Migration verification failed: a pre-existing claim (id <= the frozen high-water mark) was ' +
          'mutated or removed during the apply. The schema DDL is additive and applied successfully, so ' +
          'this is a conservative red from concurrent app activity — re-run in a quiet window to clear it.',
      );
    }
    if (afterTotal < beforeTotal) {
      throw new Error(`Migration verification failed: total claim count dropped ${beforeTotal} -> ${afterTotal}`);
    }

    console.log(`[ps-497-0104] applied=${JSON.stringify(afterState)}`);
    console.log(
      `[ps-497-0104] preexisting_claims_unchanged=true preexisting_rows=${after.claim_count} total_rows=${afterTotal}`,
    );
    console.log('[ps-497-0104] quantity_state_check_intact=true');
    console.log('[ps-497-0104] orders_shipments_untouched=true');
    console.log('[ps-497-0104] no_backfill_performed=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-0104] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
