/** PS-414 additive deployment-lag readiness. No historical rows are rewritten. */
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

let readiness: Promise<void> | null = null;

export function ensureInventoryLedgerSchema(): Promise<void> {
  if (readiness) return readiness;
  readiness = (async () => {
    await db.execute(sql`ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS effective_at timestamptz`);
    await db.execute(sql`ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS idempotency_key text`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS inventory_ledger_effective_at_idx
      ON inventory_ledger (effective_at)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS inventory_ledger_idempotency_key_unq
      ON inventory_ledger (idempotency_key)`);
  })().catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}
