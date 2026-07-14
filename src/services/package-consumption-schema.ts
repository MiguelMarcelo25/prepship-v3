/**
 * Per user override unlock shipped data on 2026-07-11: runtime-safe PS-413
 * additive schema readiness. No shipment/order mutation.
 */
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export function ensurePackageConsumptionSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0060 owns
  // package-consumption schema; provider paths only verify readiness.
  return assertRuntimeSchemaReady();
}
