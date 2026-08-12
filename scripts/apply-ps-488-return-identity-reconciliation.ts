/**
 * PS-488 recovery — operator runner for migration 0092.
 *
 * FAIL-CLOSED BY DEFAULT. With no flags this INSPECTS and reports; it writes
 * nothing. Applying requires BOTH `--apply` and the exact confirmation token, and the
 * migration on disk must be content-identical to the reviewed SQL. It uses its own
 * token and its own path so a stale 0089 confirmation cannot drive it.
 *
 *   npx tsx scripts/apply-ps-488-return-identity-reconciliation.ts
 *   npx tsx scripts/apply-ps-488-return-identity-reconciliation.ts --apply \
 *     --confirm=APPLY-PS-488-0092-RETURN-IDENTITY-RECONCILIATION
 *
 * ONE TRANSACTION covers: bounded timeouts, the table lock, the AUTHORITATIVE before
 * snapshot, the DDL, exact catalog verification, the after snapshot, and the
 * unchanged-data assertions. Any failure rolls all of it back. A read taken outside
 * the transaction is informational only and is never the protected before-state.
 *
 * EXACT CATALOG VERIFICATION. Protected objects are not checked by substring. The
 * unique index and the CHECK are compared against REFERENCE objects built in the same
 * transaction from the intended expression, so PostgreSQL normalises both sides and
 * equality is exact without guessing at its rendering. Objects that must merely
 * survive are compared by exact definition captured before the DDL.
 *
 * This runner never regenerates billing, never backfills, and issues no
 * INSERT/UPDATE/DELETE against billing data.
 */
import postgres from 'postgres';
import {
  PS488_CANONICAL_RETURN_TYPES,
  PS488_CHECK_NAME,
  PS488_FK_NAME,
  PS488_LOCK_TIMEOUT,
  PS488_LOOKUP_INDEX,
  PS488_PRESERVED_UNIQUE_INDEXES,
  PS488_RECOVERY_CONFIRMATION,
  PS488_STATEMENT_TIMEOUT,
  PS488_TABLE,
  PS488_UNIQUE_INDEX,
  assert0089Untouched,
  loadAuthorisedMigration,
} from './ps-488-migration-contract.js';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const argValue = (name: string): string | null => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const QUALIFIED = `public.${PS488_TABLE}`;

export type Snapshot = { rows: string; invoiced: string; total: string; checksum: string };

export type ForeignKeyFacts = {
  deleteAction: string;
  updateAction: string;
  matchType: string;
  deferrable: boolean;
  deferred: boolean;
  validated: boolean;
  sourceColumns: string[];
  targetColumns: string[];
  sourceSchema: string;
  targetSchema: string;
  targetTable: string;
};

export type IndexFacts = {
  name: string;
  definition: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  keyColumns: string[];
};

export type CatalogFacts = {
  fk: ForeignKeyFacts | null;
  checkDefinition: string | null;
  checkValidated: boolean | null;
  referenceCheckDefinition: string;
  uniqueIndex: IndexFacts | null;
  referenceUniqueDefinition: string;
  survivors: Record<string, string | null>;
};

/**
 * Strict verification of every protected object. Pure so the mutation matrix can
 * feed it synthetic catalogs and prove each individual mutation is rejected.
 */
export function verifyCatalog(facts: CatalogFacts, survivorsBefore: Record<string, string | null>): void {
  const fail = (message: string): never => {
    throw new Error(`STOP: ${message}`);
  };

  // ── Foreign key: every attribute pinned, not just the delete action ──────────
  const fk = facts.fk;
  if (!fk) fail(`FK ${PS488_FK_NAME} is missing after DDL`);
  else {
    if (fk.deleteAction !== 'r') fail(`FK delete action is '${fk.deleteAction}', expected 'r' (RESTRICT)`);
    if (fk.updateAction !== 'a') fail(`FK update action is '${fk.updateAction}', expected 'a' (NO ACTION)`);
    if (fk.matchType !== 's') fail(`FK match type is '${fk.matchType}', expected 's' (SIMPLE)`);
    if (fk.deferrable) fail('FK must not be DEFERRABLE');
    if (fk.deferred) fail('FK must not be INITIALLY DEFERRED');
    if (!fk.validated) fail('FK is not validated');
    if (fk.sourceSchema !== 'public') fail(`FK source schema is ${fk.sourceSchema}`);
    if (fk.targetSchema !== 'public') fail(`FK target schema is ${fk.targetSchema}`);
    if (fk.targetTable !== 'returns') fail(`FK references ${fk.targetTable}, expected returns`);
    if (fk.sourceColumns.join(',') !== 'return_id') {
      fail(`FK source columns are (${fk.sourceColumns.join(',')}), expected (return_id)`);
    }
    if (fk.targetColumns.join(',') !== 'id') {
      fail(`FK target columns are (${fk.targetColumns.join(',')}), expected (id)`);
    }
  }

  // ── CHECK: exact normalised definition, compared to a reference PostgreSQL
  //    rendered from the intended expression in this same transaction ───────────
  if (facts.checkDefinition === null) fail(`CHECK ${PS488_CHECK_NAME} is missing after DDL`);
  if (facts.checkValidated !== true) fail('CHECK is present but convalidated is not true');
  if (facts.checkDefinition !== facts.referenceCheckDefinition) {
    fail(
      `CHECK definition does not match the reviewed expression.\n  actual:   ${facts.checkDefinition}` +
        `\n  expected: ${facts.referenceCheckDefinition}`,
    );
  }
  // Cheap belt-and-braces on top of the exact match.
  for (const type of PS488_CANONICAL_RETURN_TYPES) {
    if (!facts.checkDefinition!.includes(type)) fail(`CHECK definition omits ${type}`);
  }

  // ── Unique index: exact definition, key order, partiality, validity ──────────
  const unique = facts.uniqueIndex;
  if (!unique) fail(`unique index ${PS488_UNIQUE_INDEX} is missing`);
  else {
    if (!unique.unique) fail(`${PS488_UNIQUE_INDEX} is not UNIQUE`);
    if (!unique.valid) fail(`${PS488_UNIQUE_INDEX} is not valid`);
    if (!unique.ready) fail(`${PS488_UNIQUE_INDEX} is not ready`);
    if (unique.keyColumns.join(',') !== 'return_id,line_type') {
      fail(`${PS488_UNIQUE_INDEX} keys are (${unique.keyColumns.join(',')}), expected (return_id,line_type)`);
    }
    if (unique.definition !== facts.referenceUniqueDefinition) {
      fail(
        `${PS488_UNIQUE_INDEX} definition does not match the reviewed expression.` +
          `\n  actual:   ${unique.definition}\n  expected: ${facts.referenceUniqueDefinition}`,
      );
    }
  }

  // ── Survivors: exact definition equality against the pre-DDL capture ─────────
  for (const name of [PS488_LOOKUP_INDEX, ...PS488_PRESERVED_UNIQUE_INDEXES]) {
    const before = survivorsBefore[name] ?? null;
    const after = facts.survivors[name] ?? null;
    if (before === null) fail(`${name} was absent before the DDL; the 0089 shape is not present`);
    if (after === null) fail(`${name} was lost by the DDL`);
    if (before !== after) {
      fail(`${name} definition changed.\n  before: ${before}\n  after:  ${after}`);
    }
  }
}

async function snapshot(sql: postgres.Sql): Promise<Snapshot> {
  const [row] = await sql<Snapshot[]>`
    select
      count(*)::text                                    as rows,
      count(*) filter (where invoiced)::text            as invoiced,
      coalesce(sum(total_cost), 0)::text                as total,
      coalesce(md5(string_agg(
        id::text || ':' || total_cost::text || ':' || coalesce(return_id::text, '-'),
        ',' order by id
      )), 'empty')                                      as checksum
    from public.billing_line_items`;
  return row!;
}

/** Exact definitions of the objects that must merely survive, keyed by name. */
async function survivorDefinitions(sql: postgres.Sql): Promise<Record<string, string | null>> {
  const names = [PS488_LOOKUP_INDEX, ...PS488_PRESERVED_UNIQUE_INDEXES];
  const rows = await sql<{ name: string; definition: string }[]>`
    select c.relname::text as name, pg_get_indexdef(c.oid) as definition
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ${sql(names)}`;
  const out: Record<string, string | null> = {};
  for (const name of names) out[name] = rows.find((r) => r.name === name)?.definition ?? null;
  return out;
}

/**
 * Builds reference objects from the intended expression so PostgreSQL renders both
 * sides identically, then reads the real objects. Names are neutralised so only the
 * structure is compared.
 */
async function readCatalog(sql: postgres.Sql): Promise<CatalogFacts> {
  await sql.unsafe(`
    CREATE TEMP TABLE ps488_reference (return_id integer, line_type text) ON COMMIT DROP;
    CREATE UNIQUE INDEX ps488_reference_unq
      ON ps488_reference (return_id, line_type) WHERE return_id IS NOT NULL;
    ALTER TABLE ps488_reference ADD CONSTRAINT ps488_reference_chk
      CHECK (return_id IS NULL OR line_type IN ('return_postage', 'return_processing_fee'));
  `);

  const neutraliseIndex = (definition: string, indexName: string, table: string): string =>
    definition
      .replace(new RegExp(`INDEX\\s+${indexName}\\s+ON\\s+[^\\s]+`), 'INDEX <name> ON <table>')
      .replace(new RegExp(table, 'g'), '<table>');

  const [refIndex] = await sql<{ def: string }[]>`
    select pg_get_indexdef(c.oid) as def from pg_class c where c.relname = 'ps488_reference_unq'`;
  const [refCheck] = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ps488_reference_chk'`;

  const [fkRow] = await sql<
    {
      confdeltype: string; confupdtype: string; confmatchtype: string;
      condeferrable: boolean; condeferred: boolean; convalidated: boolean;
      source_columns: string[]; target_columns: string[];
      source_schema: string; target_schema: string; target_table: string;
    }[]
  >`
    select c.confdeltype, c.confupdtype, c.confmatchtype,
           c.condeferrable, c.condeferred, c.convalidated,
           (select array_agg(a.attname order by u.ord)
              from unnest(c.conkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) as source_columns,
           (select array_agg(a.attname order by u.ord)
              from unnest(c.confkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = u.attnum) as target_columns,
           sn.nspname::text as source_schema, tn.nspname::text as target_schema,
           tc.relname::text as target_table
    from pg_constraint c
    join pg_class sc on sc.oid = c.conrelid
    join pg_namespace sn on sn.oid = sc.relnamespace
    join pg_class tc on tc.oid = c.confrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    where c.conname = ${PS488_FK_NAME} and c.conrelid = ${QUALIFIED}::regclass`;

  const [checkRow] = await sql<{ def: string; convalidated: boolean }[]>`
    select pg_get_constraintdef(oid) as def, convalidated
    from pg_constraint
    where conname = ${PS488_CHECK_NAME} and conrelid = ${QUALIFIED}::regclass`;

  const [uniqueRow] = await sql<
    { def: string; unique: boolean; valid: boolean; ready: boolean; keys: string[] }[]
  >`
    select pg_get_indexdef(i.indexrelid) as def, i.indisunique as unique,
           i.indisvalid as valid, i.indisready as ready,
           (select array_agg(a.attname order by k.ord)
              from unnest(i.indkey::int[]) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
              where k.ord <= i.indnkeyatts) as keys
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = ${PS488_UNIQUE_INDEX} and i.indrelid = ${QUALIFIED}::regclass`;

  return {
    fk: fkRow
      ? {
          deleteAction: fkRow.confdeltype,
          updateAction: fkRow.confupdtype,
          matchType: fkRow.confmatchtype,
          deferrable: fkRow.condeferrable,
          deferred: fkRow.condeferred,
          validated: fkRow.convalidated,
          sourceColumns: fkRow.source_columns ?? [],
          targetColumns: fkRow.target_columns ?? [],
          sourceSchema: fkRow.source_schema,
          targetSchema: fkRow.target_schema,
          targetTable: fkRow.target_table,
        }
      : null,
    checkDefinition: checkRow?.def ?? null,
    checkValidated: checkRow?.convalidated ?? null,
    referenceCheckDefinition: refCheck!.def,
    uniqueIndex: uniqueRow
      ? {
          name: PS488_UNIQUE_INDEX,
          definition: neutraliseIndex(uniqueRow.def, PS488_UNIQUE_INDEX, QUALIFIED),
          unique: uniqueRow.unique,
          valid: uniqueRow.valid,
          ready: uniqueRow.ready,
          keyColumns: uniqueRow.keys ?? [],
        }
      : null,
    referenceUniqueDefinition: neutraliseIndex(refIndex!.def, 'ps488_reference_unq', 'ps488_reference'),
    survivors: await survivorDefinitions(sql),
  };
}

async function main(): Promise<void> {
  assert0089Untouched();
  // Refuses outright if 0092 on disk is not the reviewed SQL.
  const { sql: migrationSql, digest } = loadAuthorisedMigration();

  const suppliedDigest = argValue('digest');
  if (suppliedDigest && suppliedDigest !== digest) {
    throw new Error(`STOP: supplied digest ${suppliedDigest} does not match the reviewed SQL ${digest}`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  console.log('PS-488 recovery runner — migration 0092');
  console.log(`  reviewed SQL digest : ${digest} (pinned)`);
  console.log('  0089 digest         : verified unchanged');
  console.log(`  mode                : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}`);

  if (APPLY && argValue('confirm') !== PS488_RECOVERY_CONFIRMATION) {
    throw new Error(
      `STOP: --apply requires --confirm=${PS488_RECOVERY_CONFIRMATION}. Nothing was written.`,
    );
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (!APPLY) {
      // Informational only — never the protected before-state.
      const info = await snapshot(sql);
      const [fk] = await sql<{ confdeltype: string }[]>`
        select confdeltype from pg_constraint where conname = ${PS488_FK_NAME}`;
      console.log(`  rows ${info.rows}, invoiced ${info.invoiced}, total ${info.total}`);
      console.log(`  current FK delete action : ${fk?.confdeltype ?? '(missing)'}`);
      console.log('\nInspection only. Nothing was written.');
      return;
    }

    await sql.begin(async (tx) => {
      const t = tx as unknown as postgres.Sql;

      // Bounded first, so every statement below — including the lock — is capped.
      await t.unsafe(`SET LOCAL lock_timeout = '${PS488_LOCK_TIMEOUT}'`);
      await t.unsafe(`SET LOCAL statement_timeout = '${PS488_STATEMENT_TIMEOUT}'`);

      // Take the DDL-level lock explicitly and up front, so contention fails fast
      // here under lock_timeout rather than midway through the reconciliation.
      await t.unsafe(`LOCK TABLE ${QUALIFIED} IN ACCESS EXCLUSIVE MODE`);

      // AUTHORITATIVE before-state: inside the transaction, after the lock, so
      // nothing can change between reading it and committing.
      const before = await snapshot(t);
      const survivorsBefore = await survivorDefinitions(t);
      console.log(`  before: ${before.rows} rows, ${before.invoiced} invoiced, total ${before.total}`);

      await t.unsafe(migrationSql.replace(/-->\s*statement-breakpoint/g, ';'));

      verifyCatalog(await readCatalog(t), survivorsBefore);

      const after = await snapshot(t);
      if (after.rows !== before.rows) throw new Error(`STOP: row count moved ${before.rows} -> ${after.rows}`);
      if (after.total !== before.total) throw new Error(`STOP: total moved ${before.total} -> ${after.total}`);
      if (after.invoiced !== before.invoiced) throw new Error('STOP: invoiced count moved');
      if (after.checksum !== before.checksum) throw new Error('STOP: per-row checksum changed — data was mutated');

      // Test-only injection point, refused outside NODE_ENV=test. Exists so the
      // PG17 suite can prove that a failure AFTER successful DDL and verification
      // still rolls the whole transaction back.
      if (process.env.PS488_FORCE_POST_VERIFY_FAILURE === '1') {
        if (process.env.NODE_ENV !== 'test') {
          throw new Error('STOP: PS488_FORCE_POST_VERIFY_FAILURE is test-only');
        }
        throw new Error('STOP: forced post-verification failure (test injection)');
      }

      console.log('  catalog verified exactly, data unchanged — committing');
    });

    console.log('\nApplied. 0092 reconciliation committed.');
  } finally {
    // Always close, including on a thrown STOP, so no session leaks.
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly; the contract test imports verifyCatalog.
if (process.argv[1] && process.argv[1].includes('apply-ps-488-return-identity-reconciliation')) {
  await main();
}
