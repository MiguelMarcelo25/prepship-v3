/** PS-414 migration readiness. No historical rows are rewritten. */
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export function ensureInventoryLedgerSchema(): Promise<void> {
  return assertRuntimeSchemaReady();
}
