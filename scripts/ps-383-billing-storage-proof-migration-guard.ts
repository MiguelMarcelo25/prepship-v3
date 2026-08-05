/**
 * PS-383 - billing_storage_proof migration parity and charge gate.
 *
 * Offline/static guard. It proves storage billing cannot create a charge unless
 * the proof schema is present and the proof row is durably written in the same
 * transaction as the storage line.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const schema = read('src/db/schema/billing.ts');
const migration = read('drizzle/0055_billing_storage_proof.sql');
const ensure = read('src/db/ensure-billing-storage-proof.ts');
const billing = read('src/services/billing.ts');
const runtimeDdlGuard = read('scripts/runtime-ddl-guard.mjs');
const runtimeDdlAudit = read('RUNTIME_DDL_MIGRATION_AUDIT.md');
const packageJson = read('package.json');

const storageBlock = billing.slice(
  billing.indexOf('Storage fees (PS-373'),
  billing.indexOf('let billingSummaryMetricsRows'),
);

check('schema declares the billing_storage_proof sidecar',
  /export const billingStorageProof = pgTable\(\s*\n?\s*'billing_storage_proof'/.test(schema) &&
    /proof:\s*jsonb\(\)\.notNull\(\)/.test(schema) &&
    /unique\('billing_storage_proof_client_period_unq'\)\.on\(t\.clientId, t\.periodStart, t\.periodEnd\)/.test(schema));

check('migration 0055 creates the exact storage proof table additively',
  /CREATE TABLE IF NOT EXISTS "billing_storage_proof"/.test(migration) &&
    /"proof" jsonb NOT NULL/.test(migration) &&
    /CONSTRAINT "billing_storage_proof_client_period_unq" UNIQUE \("client_id", "period_start", "period_end"\)/.test(migration));

check('runtime helper delegates to memoized migration readiness',
  /assertRuntimeSchemaReady/.test(ensure) &&
    !/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(ensure) &&
    /let readiness: Promise<void> \| null = null/.test(read('src/services/runtime-schema-readiness.ts')));

check('runtime readiness audit knows the storage proof helper/migration pair',
  runtimeDdlGuard.includes("'src/db/ensure-billing-storage-proof.ts'") &&
    runtimeDdlAudit.includes('`src/db/ensure-billing-storage-proof.ts`') &&
    runtimeDdlAudit.includes('0055_billing_storage_proof.sql'));

check('billing ensures storage proof schema before any storage line insert',
  /await ensureBillingStorageProofSchema\(\)[\s\S]*await db\.transaction\(async \(tx\) =>/.test(storageBlock) &&
    storageBlock.indexOf('await ensureBillingStorageProofSchema()') < storageBlock.indexOf('.insert(billingLineItems)'));

check('billing writes proof before storage line in one transaction',
  /await db\.transaction\(async \(tx\) => \{[\s\S]*tx\s*\n\s*\.insert\(billingStorageProof\)[\s\S]*tx\s*\n\s*\.insert\(billingLineItems\)[\s\S]*\}\);/.test(storageBlock));

// Repointed 2026-08-04. Both of these failed, and both properties still hold --
// the implementations under them improved and the assertions pinned the old
// spelling.
//
// The prose log "storage line skipped because proof freeze failed" became a
// structured reportError('billing.storage_line.freeze_failed', ...), matching the
// convention used everywhere else in this file. The skip semantics are unchanged
// and the branch additionally tracks finalized-lock skips now. Pin the error
// CODE, which is the queryable thing, rather than a sentence.
check('storage charge is skipped when proof durability fails',
  /catch \(storageErr\)[\s\S]*skipped \+= 1/.test(storageBlock) &&
    /billing\.storage_line\.freeze_failed/.test(storageBlock) &&
    !/generated but proof freeze failed/.test(storageBlock));

// `generated += 1;` became `generated += insertedStorageLines.length;` -- the
// insert carries onConflictDoNothing and now .returning()s the rows Postgres
// ACTUALLY persisted, so a blind +1 over-counted on conflict. That is a
// correctness fix, and the ordering this check exists to protect is untouched:
// the increment still sits after the transaction closes and before the catch.
// Match the increment, not the literal it adds.
// Anchored on the STORAGE transaction specifically. The original assertion used
// indexOf('await db.transaction(async (tx) =>'), which matches an EARLIER
// transaction in this same block (offset ~2176 of ~12600), not the storage one at
// ~8600. So the ordering was being checked against the wrong transaction, and a
// mutation moving the storage increment before the storage transaction still
// passed. That flaw predates this repoint -- I reproduced it faithfully before a
// mutation check caught it.
const txIdx = storageBlock.indexOf('insertedStorageLines = await db.transaction');
const generatedIdx = storageBlock.search(/generated \+= insertedStorageLines/);
const catchIdx = storageBlock.indexOf('catch (storageErr)');
check('generated totals move only after proof+line transaction commits',
  txIdx >= 0 && generatedIdx > txIdx && catchIdx > generatedIdx);

check('package.json wires the PS-383 storage proof migration guard',
  /"test:ps-383-billing-storage-proof-migration":\s*"tsx scripts\/ps-383-billing-storage-proof-migration-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL PS-383 billing storage proof migration guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-383 billing storage proof migration guard');
