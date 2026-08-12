/**
 * PS-488 recovery — operator runner for migration 0092.
 *
 * FAIL-CLOSED BY DEFAULT. With no flags this INSPECTS and reports; it writes
 * nothing. Applying requires BOTH `--apply` and the exact confirmation token, and
 * the reviewed SQL digest must match. That is deliberately stricter than the 0089
 * runner, and it uses its own token and its own path so a stale 0089 confirmation
 * cannot drive it.
 *
 *   npx tsx scripts/apply-ps-488-return-identity-reconciliation.ts
 *   npx tsx scripts/apply-ps-488-return-identity-reconciliation.ts --apply \
 *     --confirm=APPLY-PS-488-0092-RETURN-IDENTITY-RECONCILIATION
 *
 * Everything the apply does — preflight, before snapshot, DDL, exact catalog
 * verification, after snapshot, unchanged-data and no-backfill assertions — runs in
 * ONE transaction. Any failure rolls the whole thing back; there is no partial
 * reconciliation. The PG session is always closed.
 *
 * This runner never regenerates billing, never backfills, and issues no
 * INSERT/UPDATE/DELETE of its own.
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

type Snapshot = { rows: string; invoiced: string; total: string; checksum: string };

/** Money facts that must be identical before and after. Schema-only migration. */
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

async function readCatalog(sql: postgres.Sql) {
  const [fk] = await sql<{ delete_action: string; validated: boolean; ref: string }[]>`
    select c.confdeltype as delete_action, c.convalidated as validated,
           t.relname::text as ref
    from pg_constraint c join pg_class t on t.oid = c.confrelid
    where c.conname = ${PS488_FK_NAME} and c.conrelid = ${`public.${PS488_TABLE}`}::regclass`;

  const [check] = await sql<{ definition: string; validated: boolean }[]>`
    select pg_get_constraintdef(oid) as definition, convalidated as validated
    from pg_constraint
    where conname = ${PS488_CHECK_NAME} and conrelid = ${`public.${PS488_TABLE}`}::regclass`;

  const indexes = await sql<{ name: string; definition: string; valid: boolean; ready: boolean }[]>`
    select c.relname::text as name, pg_get_indexdef(i.indexrelid) as definition,
           i.indisvalid as valid, i.indisready as ready
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = ${`public.${PS488_TABLE}`}::regclass`;

  return { fk, check, indexes };
}

function verifyCatalog(catalog: Awaited<ReturnType<typeof readCatalog>>): void {
  const fail = (message: string) => {
    throw new Error(`STOP: ${message}`);
  };

  if (!catalog.fk) fail(`FK ${PS488_FK_NAME} is missing after DDL`);
  // 'r' is RESTRICT. 'n' is SET NULL (the 0089 shape), 'c' is CASCADE.
  if (catalog.fk.delete_action !== 'r') {
    fail(`FK delete action is '${catalog.fk.delete_action}', expected 'r' (RESTRICT)`);
  }
  if (catalog.fk.ref !== 'returns') fail(`FK references ${catalog.fk.ref}, expected returns`);
  if (!catalog.fk.validated) fail('FK is not validated');

  if (!catalog.check) fail(`CHECK ${PS488_CHECK_NAME} is missing after DDL`);
  if (!catalog.check.validated) fail('CHECK is present but convalidated=false');
  for (const type of PS488_CANONICAL_RETURN_TYPES) {
    if (!catalog.check.definition.includes(type)) {
      fail(`CHECK definition does not mention ${type}: ${catalog.check.definition}`);
    }
  }

  const byName = new Map(catalog.indexes.map((i) => [i.name, i]));

  const unique = byName.get(PS488_UNIQUE_INDEX);
  if (!unique) fail(`unique index ${PS488_UNIQUE_INDEX} is missing`);
  else {
    const d = unique.definition.toLowerCase();
    if (!d.includes('unique')) fail(`${PS488_UNIQUE_INDEX} is not UNIQUE`);
    if (!d.includes('return_id') || !d.includes('line_type')) {
      fail(`${PS488_UNIQUE_INDEX} does not cover (return_id, line_type): ${unique.definition}`);
    }
    if (!d.includes('where') || !d.includes('not null')) {
      fail(`${PS488_UNIQUE_INDEX} is not partial on return_id IS NOT NULL`);
    }
    if (!unique.valid || !unique.ready) fail(`${PS488_UNIQUE_INDEX} is not valid/ready`);
  }

  const lookup = byName.get(PS488_LOOKUP_INDEX);
  if (!lookup) fail(`0089 lookup index ${PS488_LOOKUP_INDEX} was lost`);

  // The description-based indexes protect a different row set and predate this work.
  for (const name of PS488_PRESERVED_UNIQUE_INDEXES) {
    if (!byName.has(name)) fail(`pre-existing index ${name} was lost`);
  }
}

async function main(): Promise<void> {
  assert0089Untouched();
  const { sql: migrationSql, digest } = loadAuthorisedMigration();

  const suppliedDigest = argValue('digest');
  if (suppliedDigest && suppliedDigest !== digest) {
    throw new Error(`STOP: supplied digest ${suppliedDigest} does not match reviewed SQL ${digest}`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  console.log('PS-488 recovery runner — migration 0092');
  console.log(`  reviewed SQL digest : ${digest}`);
  console.log(`  0089 digest         : verified unchanged`);
  console.log(`  mode                : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}`);

  if (APPLY && argValue('confirm') !== PS488_RECOVERY_CONFIRMATION) {
    // Deliberately a no-op, not a partial run.
    throw new Error(
      `STOP: --apply requires --confirm=${PS488_RECOVERY_CONFIRMATION}. Nothing was written.`,
    );
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const before = await snapshot(sql);
    console.log(`  before: ${before.rows} rows, ${before.invoiced} invoiced, total ${before.total}`);

    if (!APPLY) {
      const catalog = await readCatalog(sql);
      console.log(`  current FK delete action : ${catalog.fk?.delete_action ?? '(missing)'}`);
      console.log(`  unique index present     : ${catalog.indexes.some((i) => i.name === PS488_UNIQUE_INDEX)}`);
      console.log(`  check present            : ${Boolean(catalog.check)}`);
      console.log('\nInspection only. Nothing was written.');
      return;
    }

    await sql.begin(async (tx) => {
      // The migration sets its own LOCAL timeouts; these are belt-and-braces for the
      // verification statements that run around it in the same transaction.
      await tx.unsafe(`SET LOCAL lock_timeout = '${PS488_LOCK_TIMEOUT}'`);
      await tx.unsafe(`SET LOCAL statement_timeout = '${PS488_STATEMENT_TIMEOUT}'`);

      await tx.unsafe(migrationSql.replace(/-->\s*statement-breakpoint/g, ';'));

      const catalog = await readCatalog(tx as unknown as postgres.Sql);
      verifyCatalog(catalog);

      const after = await snapshot(tx as unknown as postgres.Sql);
      if (after.rows !== before.rows) throw new Error(`STOP: row count moved ${before.rows} -> ${after.rows}`);
      if (after.total !== before.total) throw new Error(`STOP: total moved ${before.total} -> ${after.total}`);
      if (after.invoiced !== before.invoiced) throw new Error('STOP: invoiced count moved');
      if (after.checksum !== before.checksum) throw new Error('STOP: per-row checksum changed — data was mutated');

      console.log('  catalog verified, data unchanged — committing');
    });

    console.log('\nApplied. 0092 reconciliation committed.');
  } finally {
    // Always close, including on a thrown STOP, so no session leaks.
    await sql.end({ timeout: 5 });
  }
}

await main();
