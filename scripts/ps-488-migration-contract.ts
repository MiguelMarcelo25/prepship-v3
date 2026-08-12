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
 * The canonical LF-normalised digest of the REVIEWED 0092 SQL.
 *
 * Pinning this is what binds execution to reviewed content. Computing the digest
 * from whatever is on disk only ever proves the file matches itself: edit the
 * migration, run without --digest, and the altered SQL would be accepted. The runner
 * asserts this constant before inspection and before apply, so a modified migration
 * is refused whether or not the operator supplies a digest.
 */
export const PS488_0092_EXPECTED_DIGEST =
  'a08ed909b92cf3a5af2201d8fdeea49a9920785f2f82110b0203586e2dcf55b0';

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

/**
 * Reads the authorised migration and REFUSES unless it is content-identical to the
 * reviewed SQL under canonical LF normalisation. Every consumer goes through here,
 * so no path can execute unreviewed migration text.
 */
export function loadAuthorisedMigration(): { sql: string; digest: string } {
  const sql = readFileSync(PS488_MIGRATION_FILE, 'utf8');
  const digest = normalisedDigest(sql);
  if (digest !== PS488_0092_EXPECTED_DIGEST) {
    throw new Error(
      `STOP: ${PS488_MIGRATION_FILE} digest is ${digest}, expected ${PS488_0092_EXPECTED_DIGEST}. ` +
        'The migration on disk is not the reviewed SQL.',
    );
  }
  return { sql, digest };
}

/**
 * Fail-closed database-host gate for the PostgreSQL 17 proof.
 *
 * The suite creates and drops databases and terminates sessions. Requiring only that
 * an admin URL EXISTS is not a safety property — someone running the package command
 * directly could point it at a real database. Loopback is permitted, plus one
 * explicitly named CI service host that must also carry a test-only marker. Anything
 * else is refused before a connection is opened.
 */
export function assertDisposablePostgresUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('STOP: PS488_PG17_ADMIN_URL is not a valid URL');
  }

  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  // The GitHub Actions service container is reachable under this alias.
  const ciService = host === 'postgres' && /ps488/i.test(url.username + url.password + url.pathname);

  if (!loopback && !ciService) {
    throw new Error(
      `STOP: refusing to run against host "${host}". This suite creates and drops ` +
        'databases and terminates sessions. Only loopback, or the named CI service ' +
        'host carrying a ps488 marker, is permitted.',
    );
  }

  // Belt and braces: never a managed provider, even if one somehow resolved to a
  // permitted hostname.
  for (const banned of ['supabase', 'render.com', 'rds.amazonaws', 'neon.tech', 'azure', 'pooler']) {
    if (rawUrl.toLowerCase().includes(banned)) {
      throw new Error(`STOP: PS488_PG17_ADMIN_URL mentions "${banned}"; this must be an ephemeral database.`);
    }
  }
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
