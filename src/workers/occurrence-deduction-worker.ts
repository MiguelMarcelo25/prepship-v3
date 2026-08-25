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
// Durable operational health (Hermes #6b): the same worker-status-events convention the other workers use. It
// is import-safe here — it pulls only the db client + env + the readiness gate, never the generic
// scheduler/job-queue (the isolation guard confirms this). NO-OP until WORKER_STATUS_EVENTS_DURABLE is on.
import { recordWorkerStatusEvent } from '../services/worker-status-events.js';

const WORKER_SERVICE = 'occurrence-deduction-worker';
const POLL_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 100;
// Emit a durable heartbeat at most this often (independent of activity) so "was the worker stuck 14:32-15:17"
// is answerable during an incident review, matching the worker-status retention rationale.
const HEARTBEAT_INTERVAL_MS = 30_000;

let running = true;
// Cumulative operational counters (processed/applied/parked/fenced/locked-down/eligible) since boot.
const totals = { ticks: 0, claimed: 0, applied: 0, parked: 0, lockedDown: 0, fenced: 0 };
let lastActivityAt = 0;
let lastHeartbeatAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pid = process.pid;
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
  await recordWorkerStatusEvent({
    service: WORKER_SERVICE, pid, eventType: 'job_start',
    details: { mode: scope.mode, floor: scope.preProjectionMaxId, clients: scope.clientIds.length, stores: scope.storeIds.length, orders: scope.orderIds.length },
  });

  const onSignal = (signal: NodeJS.Signals) => { console.log(`[occurrence-worker] ${signal} received — draining current batch then stopping.`); running = false; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  while (running) {
    try {
      const result = await processFulfillmentOccurrenceOutboxOnce({ limit: BATCH_LIMIT });
      totals.ticks += 1;
      totals.claimed += result.claimed;
      totals.applied += result.applied;
      totals.parked += result.parked;
      totals.lockedDown += result.lockedDown;
      totals.fenced += result.fenced;
      const now = Date.now();
      if (result.claimed > 0) {
        lastActivityAt = now;
        console.log(`[occurrence-worker] processed claimed=${result.claimed} applied=${result.applied} parked=${result.parked} fenced=${result.fenced} lockedDown=${result.lockedDown}`);
        // eligible = rows the worker acted on this tick (claimed - lockedDown - fenced settle terminally or move).
        await recordWorkerStatusEvent({
          service: WORKER_SERVICE, pid, eventType: 'job_complete',
          details: { claimed: result.claimed, applied: result.applied, parked: result.parked, fenced: result.fenced, lockedDown: result.lockedDown, totals },
        });
      }
      // Durable heartbeat on a fixed cadence regardless of activity, so a stuck/idle worker is still observable.
      if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatAt = now;
        await recordWorkerStatusEvent({
          service: WORKER_SERVICE, pid, eventType: 'heartbeat',
          details: { totals, lastActivityAt, mode: scope.mode },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[occurrence-worker] drain error:', message);
      await recordWorkerStatusEvent({ service: WORKER_SERVICE, pid, eventType: 'job_failed', details: { message, totals } });
    }
    if (running) await sleep(POLL_INTERVAL_MS);
  }
  await recordWorkerStatusEvent({ service: WORKER_SERVICE, pid, eventType: 'heartbeat', details: { stopped: true, totals, lastActivityAt } });
  console.log('[occurrence-worker] stopped. totals:', JSON.stringify(totals));
}

main().catch((error) => {
  console.error('[occurrence-worker] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
