import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

// PS-370 Phase 1 — migration readiness for persisted selected/label cost.
// Migration 0054 owns the additive nullable column. No UPDATE/DELETE against
// locked shipment rows and no drop/type change occurs here.
export async function ensureShipmentsSelectedRateCostColumn(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0054 owns
  // this additive column; label/billing paths now only verify boot readiness.
  await assertRuntimeSchemaReady();
}
