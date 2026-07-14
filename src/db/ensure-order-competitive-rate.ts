import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

// PS-220 — migration readiness for the house-margin sidecar. Migration 0049 owns
// the table; capture sites verify the boot gate before their first insert.
export async function ensureOrderCompetitiveRateSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}
