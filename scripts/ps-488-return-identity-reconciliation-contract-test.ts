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
import { readFileSync } from 'node:fs';
import {
  PS488_0089_EXPECTED_DIGEST,
  PS488_0089_FILE,
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

if (failures) {
  console.error(`\nFAIL ps-488 reconciliation contract (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS ps-488 reconciliation contract');
