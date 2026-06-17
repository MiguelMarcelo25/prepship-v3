import { sql as pg } from '../db/client.js';

// PS-220 — per-client opt-in for the SHIPP house-account margin model. The flag lives on the
// existing billing_config table (house_account_enabled) but is read via RAW SQL and is
// INTENTIONALLY NOT declared on the drizzle billing_config schema: declaring a new column there
// would make every db.select().from(billingConfig) emit it and 500 prod before the migration runs
// (the known drizzle runtime-DDL gotcha). Migration: drizzle/0050_billing_config_house_account.sql.

let columnEnsured: Promise<void> | null = null;

/** Idempotent ADD COLUMN so the API/worker both work pre-migration (mirrors the migration). */
async function ensureHouseAccountColumn(): Promise<void> {
  columnEnsured ??= (async () => {
    await pg`ALTER TABLE billing_config ADD COLUMN IF NOT EXISTS house_account_enabled boolean NOT NULL DEFAULT false`;
  })().catch((err) => {
    columnEnsured = null;
    throw err;
  });
  return columnEnsured;
}

/**
 * True when the client is opted into the SHIPP house-account margin model. Best-effort: returns
 * false on any error or missing client, so a config glitch can never turn a normal order into a
 * house order (fail-safe — the order just bills as today).
 */
export async function clientHouseAccountEnabled(clientId: number | null | undefined): Promise<boolean> {
  if (clientId == null) return false;
  try {
    await ensureHouseAccountColumn();
    const rows = (await pg`
      SELECT house_account_enabled FROM billing_config WHERE client_id = ${clientId} LIMIT 1
    `) as Array<{ house_account_enabled?: boolean }>;
    return rows[0]?.house_account_enabled === true;
  } catch {
    return false;
  }
}
