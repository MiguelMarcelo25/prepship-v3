// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) — the DEDICATED,
// ISOLATED occurrence-deduction worker process. Shipped-data LOCKED (it authorizes inventory movement).
//
// Isolation contract (Hermes correction #1): this entrypoint runs the master switch ON in its OWN process,
// which is why it must NEVER import or start the generic fulfillment scheduler, the pg-boss job registrations
// (sync-job-queue), the generic outbox worker, or the replacement/package/bundle/legacy-inventory/marketplace
// consumers. It imports ONLY the occurrence scope owner, the occurrence outbox drain, env, and the schema
// readiness gate. A static guard (scripts/ps-497-occurrence-worker-isolation-guard.ts) enforces this import
// graph so the isolation is a build invariant, not a convention.
//
// Deployment: a separate Render worker service, `npm run start:occurrence-worker`, with
// INVENTORY_AUTO_DEDUCT=true + FULFILLMENT_OCCURRENCE_EXECUTION=true + a valid FULFILLMENT_OCCURRENCE_SCOPE_*.
// The API + generic scheduler services keep INVENTORY_AUTO_DEDUCT=false (unset resolves to ON, so it must be
// set false explicitly there).
import { env } from '../lib/env';
import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';
import {
  readOccurrenceExecutionScope,
  assertExecutionScopeReady,
} from '../services/fulfillment/occurrence-execution-scope.js';
import { processFulfillmentOccurrenceOutboxOnce } from '../services/fulfillment/occurrence-deduction-outbox.js';

const POLL_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 100;

let running = true;
let lastHeartbeat = { at: 0, claimed: 0, applied: 0, parked: 0, lockedDown: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Startup refusal: an off flag or an invalid scope must not silently run.
  if (!env.FULFILLMENT_OCCURRENCE_EXECUTION) {
    console.log('[occurrence-worker] FULFILLMENT_OCCURRENCE_EXECUTION is OFF — the occurrence lane is parked; exiting.');
    return;
  }
  if (!env.INVENTORY_AUTO_DEDUCT) {
    console.log('[occurrence-worker] INVENTORY_AUTO_DEDUCT is OFF (master kill) — no movement possible; exiting.');
    return;
  }
  const scope = readOccurrenceExecutionScope();
  assertExecutionScopeReady(scope); // throws on empty/malformed scope or a missing canary floor
  await assertRuntimeSchemaReady(); // the executor needs the occurrence schema present; fail boot closed
  console.log(`[occurrence-worker] started: mode=${scope.mode} floor=${scope.preProjectionMaxId ?? 'n/a'} clients=${scope.clientIds.length} stores=${scope.storeIds.length} orders=${scope.orderIds.length}`);

  const onSignal = (signal: NodeJS.Signals) => { console.log(`[occurrence-worker] ${signal} received — draining current batch then stopping.`); running = false; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  while (running) {
    try {
      const result = await processFulfillmentOccurrenceOutboxOnce({ limit: BATCH_LIMIT });
      lastHeartbeat = { at: Date.now(), ...result };
      if (result.claimed > 0) {
        console.log(`[occurrence-worker] processed claimed=${result.claimed} applied=${result.applied} parked=${result.parked} lockedDown=${result.lockedDown}`);
      }
    } catch (error) {
      console.error('[occurrence-worker] drain error:', error instanceof Error ? error.message : error);
    }
    if (running) await sleep(POLL_INTERVAL_MS);
  }
  console.log('[occurrence-worker] stopped. last heartbeat:', JSON.stringify(lastHeartbeat));
}

main().catch((error) => {
  console.error('[occurrence-worker] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
