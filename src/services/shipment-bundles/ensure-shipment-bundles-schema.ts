// PS-312 (S0) — migration readiness for combined-shipment-bundle sidecars.
import { assertRuntimeSchemaReady } from '../runtime-schema-readiness.js';

export async function ensureShipmentBundlesSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0052 owns
  // additive bundle sidecars; bundle workflows only verify readiness.
  await assertRuntimeSchemaReady();
}
