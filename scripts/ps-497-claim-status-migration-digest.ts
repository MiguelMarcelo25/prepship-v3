import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PS-497 Slice 2 — binds the 0105 operator runner and its test to the EXACT reviewed migration bytes,
// mirroring the 0104 digest helper.

export const MIGRATION_RELPATH = 'drizzle/0105_ps497_claim_not_applicable_status.sql';
export const EXPECTED_MIGRATION_SHA256 =
  '62a5b82de9985bc7c396a6b75f516fcd3ac671d507973a0f18088b8ceafddc6d';

export function normalizeMigration(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
export function computeDigest(text: string): string {
  return createHash('sha256').update(normalizeMigration(text), 'utf8').digest('hex');
}
export function resolveMigrationPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', MIGRATION_RELPATH);
}
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

/** Split into ordered statements (each run standalone so an ADD CONSTRAINT's AccessExclusive releases before VALIDATE). */
export function migrationStatements(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((stmt) => stmt.length > 0);
}
