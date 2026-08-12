/**
 * PS-488 recovery — the frozen contract for migration 0092.
 *
 * One module owns: which SQL file is authorised, what its digest is, the exact
 * catalog shape the migration must produce, and the confirmation token the runner
 * demands. The runner, the fast contract proof and the PostgreSQL 17 suite all read
 * from here, so none of them can drift from the reviewed SQL.
 *
 * WHY 0092 EXISTS
 *
 * 0089 shipped `billing_line_items.return_id` to production with an incomplete
 * contract: the FK is ON DELETE SET NULL, and the governed raw partial unique index
 * and semantic CHECK are absent. 0089 is immutable history — it is not edited,
 * replayed, reverted, and `return_id` is not dropped. 0092 repairs forward.
 *
 * DIGEST NORMALISATION
 *
 * The digest is taken over LF-normalised bytes, never the raw file. This repo runs
 * with core.autocrlf=true, so a Windows working tree holds CRLF while the repository
 * and Linux CI hold LF. Hashing raw bytes would make the digest environment
 * dependent: the runner would refuse on one machine and accept on another for
 * byte-identical content. Verified against 0089, whose raw Windows hash is
 * 3a8fcb80… while its normalised hash is 2a8b35b8… — the value Hermes independently
 * computed from the git blob.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The one migration this recovery slice is authorised to apply. */
export const PS488_MIGRATION_FILE = 'drizzle/0092_ps488_return_identity_reconciliation.sql';

/**
 * Exact confirmation the operator must type. Deliberately NOT the 0089 token, and
 * deliberately not reusable: a stale muscle-memory paste of the 0089 confirmation
 * must be a no-op against this runner.
 */
export const PS488_RECOVERY_CONFIRMATION = 'APPLY-PS-488-0092-RETURN-IDENTITY-RECONCILIATION';

/** Immutable predecessor. Its digest is asserted, never recomputed into a variable. */
export const PS488_0089_FILE = 'drizzle/0089_billing_line_items_return_id.sql';
export const PS488_0089_EXPECTED_DIGEST =
  '2a8b35b8f03ebee77a7787537ba086329d10d7a27bfb6e4b74da3549782ba1dc';

/** Frozen by Hermes. Bounded so a lock fight fails fast instead of stalling billing. */
export const PS488_LOCK_TIMEOUT = '5s';
/** Frozen by Hermes. A validated CHECK over ~80k rows needs a full scan under lock. */
export const PS488_STATEMENT_TIMEOUT = '120s';

export const PS488_TABLE = 'billing_line_items';
export const PS488_FK_NAME = 'billing_line_items_return_id_returns_id_fk';
export const PS488_LOOKUP_INDEX = 'billing_li_return_id_idx';
export const PS488_UNIQUE_INDEX = 'billing_li_return_identity_unq';
export const PS488_CHECK_NAME = 'billing_li_return_id_canonical_type_check';

/** The only line types a non-null return_id may carry. */
export const PS488_CANONICAL_RETURN_TYPES = ['return_postage', 'return_processing_fee'] as const;

/**
 * Description-based unique indexes that predate this work and protect a DIFFERENT
 * row set. They must survive 0092 untouched; the runner asserts their presence
 * before and after.
 */
export const PS488_PRESERVED_UNIQUE_INDEXES = [
  'billing_li_order_unique_idx',
  'billing_li_shipment_unique_idx',
  'billing_li_storage_unique_idx',
] as const;

/**
 * LF-normalised SHA-256. See DIGEST NORMALISATION above — this is the only hashing
 * entry point any PS-488 tool may use.
 */
export function normalisedDigest(contents: string): string {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function digestOfFile(path: string): string {
  return normalisedDigest(readFileSync(path, 'utf8'));
}

/** Reads the authorised migration and returns its text plus digest. */
export function loadAuthorisedMigration(): { sql: string; digest: string } {
  const sql = readFileSync(PS488_MIGRATION_FILE, 'utf8');
  return { sql, digest: normalisedDigest(sql) };
}

/**
 * 0089 must be byte-identical to what was reviewed. A changed predecessor means the
 * production shape this migration reconciles FROM is no longer the documented one,
 * which is a STOP condition rather than something to reconcile around.
 */
export function assert0089Untouched(): void {
  const actual = digestOfFile(PS488_0089_FILE);
  if (actual !== PS488_0089_EXPECTED_DIGEST) {
    throw new Error(
      `STOP: ${PS488_0089_FILE} digest is ${actual}, expected ${PS488_0089_EXPECTED_DIGEST}. ` +
        '0089 is immutable history and must not be edited.',
    );
  }
}
