import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PS-497 / PS-489 Slice 1 — the single source of truth that binds the operator runner and the
// apply-lane test to the EXACT reviewed migration bytes. Both import this; neither reads the SQL
// through an unpinned path.

export const MIGRATION_RELPATH = 'drizzle/0104_ps497_fulfillment_occurrences.sql';

// SHA-256 of the normalized (LF) migration bytes. Any SQL/comment/identifier/whitespace change to
// the migration changes this digest, so the runner refuses to apply anything but the reviewed file.
export const EXPECTED_MIGRATION_SHA256 =
  'bf8038d264d736785d7913b4443c2445ad93296f846d61f71ee106f1e85246d2';

/** Normalize line endings so a CRLF/LF checkout difference never changes the digest. */
export function normalizeMigration(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function computeDigest(text: string): string {
  return createHash('sha256').update(normalizeMigration(text), 'utf8').digest('hex');
}

/**
 * Resolve the migration relative to the repository root (this module lives in scripts/), NOT the
 * operator's arbitrary current working directory. So the runner cannot be pointed at a stale file
 * in some other checkout by running it from the wrong place.
 */
export function resolveMigrationPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', MIGRATION_RELPATH);
}

const NON_TX_SENTINEL = '-- >>> NON-TRANSACTIONAL <<<';

/**
 * Split the migration into its transactional block and the ordered non-transactional statements.
 * One shared implementation for the runner and the tests, anchored on the sentinel as its own line
 * so a mention of the marker text inside a comment cannot be mistaken for the real split point.
 */
export function splitMigration(sql: string): { transactional: string; concurrent: string[] } {
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

/** Read + verify the migration is byte-for-byte the reviewed one. Throws on any mismatch. */
export function readVerifiedMigration(): { path: string; text: string; digest: string } {
  const migrationPath = resolveMigrationPath();
  const text = readFileSync(migrationPath, 'utf8');
  const digest = computeDigest(text);
  if (digest !== EXPECTED_MIGRATION_SHA256) {
    throw new Error(
      `Migration digest mismatch: ${MIGRATION_RELPATH} does not match the reviewed bytes ` +
        `(expected ${EXPECTED_MIGRATION_SHA256}, got ${digest}). Refusing to run against unpinned SQL.`,
    );
  }
  return { path: migrationPath, text, digest };
}
