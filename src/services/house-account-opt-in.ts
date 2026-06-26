import { sql as pg } from '../db/client.js';

// PS-220 — per-client opt-in for the SHIPP house-account margin model. The flag lives on the
// existing billing_config table (house_account_enabled) but is read via RAW SQL and is
// INTENTIONALLY NOT declared on the drizzle billing_config schema: declaring a new column there
// would make every db.select().from(billingConfig) emit it and 500 prod before the migration runs
// (the known drizzle runtime-DDL gotcha). Migration: drizzle/0050_billing_config_house_account.sql.

let columnEnsured: Promise<void> | null = null;

export type ShippingMarginPolicyMode = 'pass_through' | 'next_best_customer_rate';

export type ShippingMarginPolicy = {
  mode: ShippingMarginPolicyMode;
  legacyHouseAccountEnabled: boolean;
};

export function shippingMarginPolicyModeFromEnabled(enabled: boolean): ShippingMarginPolicyMode {
  return enabled ? 'next_best_customer_rate' : 'pass_through';
}

export function shippingMarginPolicyFromRow(
  row: { house_account_enabled?: boolean | null } | null | undefined,
): ShippingMarginPolicy {
  const enabled = row?.house_account_enabled === true;
  return {
    mode: shippingMarginPolicyModeFromEnabled(enabled),
    legacyHouseAccountEnabled: enabled,
  };
}

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
export async function shippingMarginPolicyForClient(
  clientId: number | null | undefined,
): Promise<ShippingMarginPolicy> {
  if (clientId == null) return shippingMarginPolicyFromRow(null);
  try {
    await ensureHouseAccountColumn();
    const rows = (await pg`
      SELECT house_account_enabled FROM billing_config WHERE client_id = ${clientId} LIMIT 1
    `) as Array<{ house_account_enabled?: boolean | null }>;
    return shippingMarginPolicyFromRow(rows[0]);
  } catch {
    return shippingMarginPolicyFromRow(null);
  }
}

export async function clientHouseAccountEnabled(clientId: number | null | undefined): Promise<boolean> {
  return (await shippingMarginPolicyForClient(clientId)).mode === 'next_best_customer_rate';
}

/**
 * Opt a client IN/OUT of the house-account model (P4). Raw-SQL UPSERT keyed on the
 * billing_config PK (client_id); a client with no billing_config row yet gets one with column
 * defaults. Unlike the read this is NOT swallowed — the admin endpoint surfaces any failure so a
 * silent no-op can't masquerade as a successful opt-in. Returns the value written.
 */
export async function setClientHouseAccountEnabled(clientId: number, enabled: boolean): Promise<boolean> {
  await ensureHouseAccountColumn();
  await pg`
    INSERT INTO billing_config (client_id, house_account_enabled)
    VALUES (${clientId}, ${enabled})
    ON CONFLICT (client_id) DO UPDATE SET house_account_enabled = ${enabled}, updated_at = now()
  `;
  return enabled;
}

/**
 * The set of client_ids opted into the house-account model — for the Billing Config grid toggle
 * state. Reads ONLY the opted-in rows (no array binding — sidesteps the IN/ANY param gotcha; the
 * opted-in set is tiny). Best-effort: an empty set just shows every toggle OFF (the safe default).
 */
export async function houseAccountEnabledClientIds(): Promise<Set<number>> {
  const out = new Set<number>();
  try {
    await ensureHouseAccountColumn();
    const rows = (await pg`
      SELECT client_id FROM billing_config WHERE house_account_enabled = true
    `) as Array<{ client_id: number }>;
    for (const row of rows) out.add(Number(row.client_id));
  } catch {
    /* best-effort */
  }
  return out;
}
