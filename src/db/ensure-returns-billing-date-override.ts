import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

// PS-487 AC-4 — migration readiness for the admin-corrected return billing date.
// Migration 0088 owns the three additive nullable columns
// (billing_date_override, _by, _reason). Nothing here runs DDL: the billing paths only
// verify boot readiness, so a deploy that lands the Drizzle mapping before the migration
// fails closed instead of 500ing every select on `returns`.
export async function ensureReturnsBillingDateOverrideColumns(): Promise<void> {
  await assertRuntimeSchemaReady();
}
