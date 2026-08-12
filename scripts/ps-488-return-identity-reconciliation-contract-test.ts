/**
 * PS-488 recovery — fast contract proof for migration 0092.
 *
 * Runs offline in seconds and pins the things that can be checked without a real
 * PostgreSQL: the reviewed SQL says what it must say, says nothing it must not, the
 * digest is stable and normalisation-independent, 0089 is untouched, and the schema
 * declaration matches the migration.
 *
 * This is NOT the behavioural proof. Exact catalog definitions, convalidated flags,
 * rollback, lock timeouts and session cleanup are proven only by
 * scripts/ps-488-return-identity-reconciliation-pg17.ts against real PostgreSQL 17.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyCatalog } from './apply-ps-488-return-identity-reconciliation.js';
import {
  PS488_0089_EXPECTED_DIGEST,
  PS488_0089_FILE,
  PS488_0092_EXPECTED_DIGEST,
  assertDisposablePostgresUrl,
  PS488_CHECK_NAME,
  PS488_FK_NAME,
  PS488_LOCK_TIMEOUT,
  PS488_LOOKUP_INDEX,
  PS488_MIGRATION_FILE,
  PS488_PRESERVED_UNIQUE_INDEXES,
  PS488_RECOVERY_CONFIRMATION,
  PS488_STATEMENT_TIMEOUT,
  PS488_UNIQUE_INDEX,
  assert0089Untouched,
  digestOfFile,
  loadAuthorisedMigration,
  normalisedDigest,
} from './ps-488-migration-contract.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * The migration is heavily commented on purpose — the prose names the things it
 * deliberately does NOT do (SET NULL, CONCURRENTLY). Assertions about what the
 * migration EXECUTES must therefore ignore comment lines, or the explanation trips
 * the check it is explaining.
 */
const executableOnly = (sql: string): string =>
  sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

const { sql: migration } = loadAuthorisedMigration();
const runner = readFileSync('scripts/apply-ps-488-return-identity-reconciliation.ts', 'utf8');
const schema = readFileSync('src/db/schema/billing.ts', 'utf8');

check('0089 is untouched at the digest Hermes independently computed', () => {
  assert0089Untouched();
  assert.equal(digestOfFile(PS488_0089_FILE), PS488_0089_EXPECTED_DIGEST);
});

check('the digest is normalisation-independent (CRLF vs LF must not change it)', () => {
  // core.autocrlf=true means a Windows checkout holds CRLF while CI holds LF. If the
  // digest moved with line endings the runner would refuse on one OS and accept on
  // the other for byte-identical content.
  const lf = 'a\nb\nc\n';
  const crlf = 'a\r\nb\r\nc\r\n';
  assert.equal(normalisedDigest(lf), normalisedDigest(crlf));
});

check('the migration repairs the FK to RESTRICT and never to CASCADE or SET NULL', () => {
  assert.match(migration, /ADD CONSTRAINT "billing_line_items_return_id_returns_id_fk"[\s\S]{0,200}ON DELETE RESTRICT/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i, 'a billing line must never be deleted with its return');
  // SET NULL may appear only in the prose explaining what 0089 did wrong.
  const statements = migration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(statements, /ON DELETE SET NULL/i, 'no executable statement may re-create SET NULL');
});

check('the raw partial unique index is present and partial', () => {
  assert.match(
    migration,
    new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS "${PS488_UNIQUE_INDEX}"[\\s\\S]{0,220}WHERE "return_id" IS NOT NULL`),
  );
  assert.match(migration, /\("return_id", "line_type"\)/, 'must key on (return_id, line_type)');
});

check('the canonical-type CHECK is added NOT VALID then validated', () => {
  assert.match(migration, new RegExp(`ADD CONSTRAINT "${PS488_CHECK_NAME}"`));
  assert.match(migration, /'return_postage'/);
  assert.match(migration, /'return_processing_fee'/);
  assert.match(migration, /NOT VALID/, 'added NOT VALID so validation takes a weaker lock');
  assert.match(migration, new RegExp(`VALIDATE CONSTRAINT "${PS488_CHECK_NAME}"`));
});

check('the frozen timeouts are the ones Hermes set', () => {
  assert.match(migration, new RegExp(`SET LOCAL lock_timeout = '${PS488_LOCK_TIMEOUT}'`));
  assert.match(migration, new RegExp(`SET LOCAL statement_timeout = '${PS488_STATEMENT_TIMEOUT}'`));
});

check('the migration mutates no data and runs no backfill', () => {
  const statements = migration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(statements, forbidden, `0092 is schema-only: ${forbidden} is not allowed`);
  }
});

check('0089 objects are preserved, not recreated or dropped', () => {
  assert.match(migration, new RegExp(`CREATE INDEX IF NOT EXISTS "${PS488_LOOKUP_INDEX}"`));
  assert.doesNotMatch(migration, /DROP\s+INDEX/i, 'no existing index may be dropped');
  assert.doesNotMatch(migration, /DROP\s+COLUMN/i, 'return_id must never be dropped');
  // The only DROP allowed is the FK, which must be re-added in the same transaction.
  const drops = migration.match(/DROP CONSTRAINT[^\n]*/gi) ?? [];
  assert.equal(drops.length, 1, `expected exactly one DROP CONSTRAINT, got ${drops.length}`);
  assert.match(drops[0]!, new RegExp(PS488_FK_NAME));
});

check('the migration is schema-qualified throughout', () => {
  assert.match(migration, /ALTER TABLE "public"\."billing_line_items"/);
  assert.match(migration, /REFERENCES "public"\."returns"/);
});

check('the migration uses a non-concurrent index build, as ruled', () => {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction, and the reviewed
  // contract requires the whole reconciliation to commit or roll back as one unit.
  // Scoped to executable statements: the prose explains why CONCURRENTLY was
  // rejected, and that explanation must be allowed to say the word.
  assert.doesNotMatch(executableOnly(migration), /CONCURRENTLY/i);
});

check('the runner is fail-closed and does not reuse the 0089 token', () => {
  assert.match(runner, new RegExp(PS488_RECOVERY_CONFIRMATION.replace(/-/g, '\\-')));
  assert.match(runner, /--apply requires --confirm/, 'apply without the exact token must be a no-op');
  assert.doesNotMatch(runner, /APPLY-PS-488-RETURN-ID\b/, 'the 0089 confirmation must not work here');
  assert.match(runner, /sql\.end\(/, 'the PG session must always be closed');
  assert.match(runner, /finally/, 'session cleanup must be in a finally block');
});

check('the runner asserts data is unchanged and refuses on drift', () => {
  for (const proof of ['row count moved', 'total moved', 'per-row checksum changed']) {
    assert.ok(runner.includes(proof), `runner must assert: ${proof}`);
  }
});

check('the runner preserves the pre-existing description-based unique indexes', () => {
  for (const name of PS488_PRESERVED_UNIQUE_INDEXES) {
    assert.ok(
      runner.includes('PS488_PRESERVED_UNIQUE_INDEXES') || runner.includes(name),
      `runner must verify ${name} survives`,
    );
  }
});

check('the Drizzle schema now declares RESTRICT and the unique index', () => {
  assert.match(schema, /onDelete: 'restrict'/, 'schema must not still declare set null');
  assert.doesNotMatch(schema, /returns\.id, \{ onDelete: 'set null' \}/);
  assert.match(schema, new RegExp(`uniqueIndex\\('${PS488_UNIQUE_INDEX}'\\)`));
});

check('the schema documents the CHECK as migration-owned rather than approximating it', () => {
  // Declaring it in Drizzle would emit a second, subtly different definition and make
  // drizzle-kit propose dropping a validated production constraint.
  assert.match(schema, /MIGRATION-OWNED/);
  assert.ok(schema.includes(PS488_CHECK_NAME), 'the schema must name the migration-owned constraint');
});

check('the authorised migration path is the 0092 file and nothing else', () => {
  assert.equal(PS488_MIGRATION_FILE, 'drizzle/0092_ps488_return_identity_reconciliation.sql');
});

check('the reviewed 0092 digest is PINNED, not computed from whatever is on disk', () => {
  // Computing the digest from the file only proves the file matches itself. The
  // constant is what binds execution to reviewed content.
  assert.match(PS488_0092_EXPECTED_DIGEST, /^[0-9a-f]{64}$/);
  assert.equal(loadAuthorisedMigration().digest, PS488_0092_EXPECTED_DIGEST);
  const contract = readFileSync('scripts/ps-488-migration-contract.ts', 'utf8');
  assert.match(contract, /digest !== PS488_0092_EXPECTED_DIGEST/, 'the loader must enforce the pin');
});

check('a modified 0092 is refused even with no --digest supplied', () => {
  const original = readFileSync(PS488_MIGRATION_FILE, 'utf8');
  try {
    writeFileSync(PS488_MIGRATION_FILE, `${original}\n-- tampered\n`);
    assert.throws(() => loadAuthorisedMigration(), /not the reviewed SQL/);
  } finally {
    writeFileSync(PS488_MIGRATION_FILE, original);
  }
  // Prove the restore was exact, or every later run would fail confusingly.
  assert.equal(loadAuthorisedMigration().digest, PS488_0092_EXPECTED_DIGEST);
});

// ── Mutation matrix ─────────────────────────────────────────────────────────────
// Each case mutates ONE protected fact and proves verifyCatalog rejects it. Without
// this, the verifier could silently stop checking something and every test would
// still pass.
const GOOD_FK = {
  deleteAction: 'r', updateAction: 'a', matchType: 's',
  deferrable: false, deferred: false, validated: true,
  sourceColumns: ['return_id'], targetColumns: ['id'],
  sourceSchema: 'public', targetSchema: 'public', targetTable: 'returns',
};
const REF_CHECK = "CHECK (((return_id IS NULL) OR (line_type = ANY (ARRAY['return_postage'::text, 'return_processing_fee'::text]))))";
const REF_UNIQUE = 'CREATE UNIQUE INDEX <name> ON <table> USING btree (return_id, line_type) WHERE (return_id IS NOT NULL)';
const GOOD_SURVIVORS = Object.fromEntries(
  [PS488_LOOKUP_INDEX, ...PS488_PRESERVED_UNIQUE_INDEXES].map((n) => [n, `def of ${n}`]),
);
const goodCatalog = () => ({
  fk: { ...GOOD_FK },
  checkDefinition: REF_CHECK,
  checkValidated: true,
  referenceCheckDefinition: REF_CHECK,
  uniqueIndex: {
    name: PS488_UNIQUE_INDEX, definition: REF_UNIQUE,
    unique: true, valid: true, ready: true,
    keyColumns: ['return_id', 'line_type'],
  },
  referenceUniqueDefinition: REF_UNIQUE,
  survivors: { ...GOOD_SURVIVORS },
});

check('mutation matrix: the known-good catalog passes', () => {
  verifyCatalog(goodCatalog() as never, { ...GOOD_SURVIVORS });
});

const MUTATIONS: Array<[string, (c: ReturnType<typeof goodCatalog>) => void]> = [
  ['FK reverted to SET NULL', (c) => { c.fk!.deleteAction = 'n'; }],
  ['FK weakened to CASCADE', (c) => { c.fk!.deleteAction = 'c'; }],
  ['FK update action changed', (c) => { c.fk!.updateAction = 'c'; }],
  ['FK made deferrable', (c) => { c.fk!.deferrable = true; }],
  ['FK left unvalidated', (c) => { c.fk!.validated = false; }],
  ['FK points at the wrong table', (c) => { c.fk!.targetTable = 'orders'; }],
  ['FK source column changed', (c) => { c.fk!.sourceColumns = ['order_id']; }],
  ['FK target column changed', (c) => { c.fk!.targetColumns = ['order_id']; }],
  ['FK moved to another schema', (c) => { c.fk!.targetSchema = 'other'; }],
  ['FK missing entirely', (c) => { c.fk = null; }],
  ['CHECK missing', (c) => { c.checkDefinition = null; }],
  ['CHECK not validated', (c) => { c.checkValidated = false; }],
  ['CHECK vocabulary widened', (c) => {
    c.checkDefinition = REF_CHECK.replace('return_processing_fee', 'return_processing');
  }],
  ['CHECK weakened to always-true', (c) => { c.checkDefinition = 'CHECK ((true))'; }],
  ['unique index missing', (c) => { c.uniqueIndex = null; }],
  ['unique index not unique', (c) => { c.uniqueIndex!.unique = false; }],
  ['unique index invalid', (c) => { c.uniqueIndex!.valid = false; }],
  ['unique index not ready', (c) => { c.uniqueIndex!.ready = false; }],
  ['unique index key order swapped', (c) => { c.uniqueIndex!.keyColumns = ['line_type', 'return_id']; }],
  ['unique index predicate dropped', (c) => {
    c.uniqueIndex!.definition = REF_UNIQUE.replace(' WHERE (return_id IS NOT NULL)', '');
  }],
  ['0089 lookup index lost', (c) => { c.survivors[PS488_LOOKUP_INDEX] = null; }],
  ['a description-based unique index lost', (c) => {
    c.survivors[PS488_PRESERVED_UNIQUE_INDEXES[0]] = null;
  }],
  ['a description-based unique index redefined', (c) => {
    c.survivors[PS488_PRESERVED_UNIQUE_INDEXES[1]] = 'something else';
  }],
];

for (const [name, mutate] of MUTATIONS) {
  check(`mutation matrix: rejected — ${name}`, () => {
    const catalog = goodCatalog();
    mutate(catalog);
    assert.throws(
      () => verifyCatalog(catalog as never, { ...GOOD_SURVIVORS }),
      /STOP:/,
      `verifyCatalog accepted a mutated catalog: ${name}`,
    );
  });
}

check('the PG17 harness refuses a non-disposable database host', () => {
  for (const unsafe of [
    'postgresql://u:p@db.abcdefg.supabase.co:5432/postgres',
    'postgres://u:p@dpg-something.render.com:5432/prod',
    'postgres://u:p@10.0.0.5:5432/prod',
    'postgres://postgres.ref:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
  ]) {
    assert.throws(() => assertDisposablePostgresUrl(unsafe), /STOP:/, `accepted unsafe host: ${unsafe}`);
  }
  // Loopback and the named CI service host are permitted.
  assertDisposablePostgresUrl('postgres://ps488:ps488@127.0.0.1:5432/postgres');
  assertDisposablePostgresUrl('postgres://ps488:ps488@localhost:5432/postgres');
  assertDisposablePostgresUrl('postgres://ps488:ps488@postgres:5432/postgres');
});

check('the runner takes the lock and the authoritative snapshot INSIDE the transaction', () => {
  const begin = runner.indexOf('sql.begin(');
  const lock = runner.indexOf('LOCK TABLE');
  const snap = runner.indexOf('const before = await snapshot(t)');
  const ddl = runner.indexOf('migrationSql.replace');
  assert.ok(begin > 0 && lock > begin, 'the lock must be taken inside the transaction');
  assert.ok(snap > lock, 'the authoritative snapshot must come after the lock');
  assert.ok(ddl > snap, 'the DDL must come after the before-snapshot');
  assert.match(runner, /Informational only — never the protected before-state/);
});

if (failures) {
  console.error(`\nFAIL ps-488 reconciliation contract (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS ps-488 reconciliation contract');
