import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

// PS-373 (slice 2) — migration readiness for the frozen storage-proof sidecar.
// Migration 0055 owns this additive sidecar — never an
// ALTER/DROP/UPDATE of any order/shipment/billing table.
export async function ensureBillingStorageProofSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}
