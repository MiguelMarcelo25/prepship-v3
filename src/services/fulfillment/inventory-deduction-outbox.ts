// Per user override unlock shipped data on 2026-07-14: durable inventory-deduction lane.
// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE +
// (S2.8 correction, Hermes flags-off finding). The legacy EXECUTION is retired — the generic worker no longer
// claims this event and the processor fails closed. BUT the per-claim MINT is preserved as a durable, INERT
// record: while FULFILLMENT_OCCURRENCE_PROJECTION is off (the flags-off hardening window), a shipment still
// records a durable inventory_deduction_requested intent exactly as Release A does — so a claim created during
// the quarantine window is NOT lost, is distinguishable from the historical occurrence_id-NULL backlog (which
// has no fresh pending intent), and stays available for back-projection when projection is enabled. The only
// difference from Release A is that NOTHING executes it (quarantine) — which is the intended movement-off
// state (execution is dead in production since 2026-07-16 regardless). The bundle minter and the backlog
// recovery re-minter stay retired (they would grow the historical backlog).
import { db, sql as pg } from '../../db/client.js';
import { fulfillmentOutbox } from '../../db/schema/fulfillment-outbox.js';

export const INVENTORY_DEDUCTION_OUTBOX_EVENT = 'inventory_deduction_requested';
const INVENTORY_DEDUCTION_PROVIDER = 'inventory';

export function isInventoryDeductionOutboxEvent(eventType: string): boolean {
  return eventType === INVENTORY_DEDUCTION_OUTBOX_EVENT;
}

/**
 * Count durable legacy intents that are preserved-but-inert (the flags-off quarantine window). These are the
 * claims minted while occurrence projection is off: recoverable, and distinct from the historical
 * occurrence_id-NULL backlog. The discrepancy report uses this to label them `parked_legacy`, never `pending`.
 */
export async function countParkedLegacyDeductionIntents(): Promise<number> {
  const rows = (await pg`
    SELECT COUNT(*)::int AS n
    FROM fulfillment_outbox
    WHERE event_type = ${INVENTORY_DEDUCTION_OUTBOX_EVENT}
      AND status IN ('pending', 'failed')
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

type InventoryDeductionOrderRef = {
  id: number;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InventoryDeductionOutboxExecutor = typeof db | DbTransaction;

export type InventoryDeductionOutboxInput = {
  shipmentId?: number | null;
  source: string;
};

export async function enqueueInventoryClaimDeduction(
  input: {
    lifecycleEventId: number;
    orderId: number;
    shipmentId?: number | null;
    source: string;
  },
  executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  // Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.8, Hermes flags-off
  // finding). DURABLE + INERT. Records the same intent Release A records so a claim created during the
  // flags-off (projection-off) window is preserved (not lost) and back-projectable — but nothing executes it:
  // the generic worker is de-scoped from this event (outbox.ts) and processInventoryDeductionOutboxEvent
  // fails closed. When FULFILLMENT_OCCURRENCE_PROJECTION is on, the owner mints occurrence-scoped intent
  // instead (occurrence-deduction-outbox.ts::enqueueOccurrenceDeduction) and this legacy path is not taken.
  const dedupeKey = `${INVENTORY_DEDUCTION_OUTBOX_EVENT}:lifecycle:${input.lifecycleEventId}`;
  await executor
    .insert(fulfillmentOutbox)
    .values({
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      eventType: INVENTORY_DEDUCTION_OUTBOX_EVENT,
      provider: INVENTORY_DEDUCTION_PROVIDER,
      dedupeKey,
      payload: {
        lifecycleEventId: input.lifecycleEventId,
        orderId: input.orderId,
        shipmentId: input.shipmentId ?? null,
        source: input.source,
      },
      status: 'pending',
      attempts: 0,
      nextRunAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: fulfillmentOutbox.dedupeKey });
}

export async function enqueueInventoryDeduction(
  order: InventoryDeductionOrderRef,
  input: InventoryDeductionOutboxInput,
  executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  // Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.8, Hermes flags-off
  // finding). DURABLE + INERT, atomic with the caller's transaction (the durable intent and the status change
  // commit or roll back together). The order-keyed bundle deduct-once fan-out (labels.ts, default-OFF
  // BUNDLE_DEDUCT_ONCE) records intent here; nothing EXECUTES it (the generic worker is de-scoped and the
  // processor fails closed) because bundle/package deduction is intentionally NOT migrated in Release B. This
  // preserves the durable record exactly as Release A does rather than silently dropping it.
  const dedupeKey = `${INVENTORY_DEDUCTION_OUTBOX_EVENT}:${order.id}`;
  await executor
    .insert(fulfillmentOutbox)
    .values({
      orderId: order.id,
      shipmentId: input.shipmentId ?? null,
      eventType: INVENTORY_DEDUCTION_OUTBOX_EVENT,
      provider: INVENTORY_DEDUCTION_PROVIDER,
      dedupeKey,
      payload: {
        orderId: order.id,
        shipmentId: input.shipmentId ?? null,
        source: input.source,
      },
      status: 'pending',
      attempts: 0,
      nextRunAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: fulfillmentOutbox.dedupeKey });
}

/**
 * Repair the only gap an outbox insert cannot close by itself: a process dying
 * after the shipped transition commits but before the event insert commits.
 * The scan is bounded to recent shipped rows and only creates missing intent;
 * the canonical deduction owner remains idempotent at the ledger boundary.
 */
export async function enqueueMissingInventoryDeductions(
  _limit = 100,
): Promise<number> {
  // Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE.
  // This legacy recovery re-minter (incl. the legacyRows block that re-created intent for shipped orders with
  // no lifecycle event — the ~4,057-row backlog re-minter) is retired: it can only re-create quarantined
  // legacy events. The dedicated occurrence lane mints its own intent at write time under PROJECTION; the
  // historical occurrence_id-NULL backlog stays structurally fenced and is handed to PS-506/PS-462. No-op.
  return 0;
}

/**
 * Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE.
 * FAIL CLOSED. The legacy inventory_deduction_requested lane is retired: the generic worker no longer claims
 * these events (outbox.ts claimDueOutboxRows de-scoped to shipment_confirmation_requested only), so this
 * processor is unreachable in the normal flow. If a parked/stray legacy row somehow reaches a dispatcher, it
 * must NOT execute — projection is not authorization to execute old mutable-order work. It throws
 * non-retryably rather than loading orders.items and calling the locked deductInventoryForOrder. Existing
 * pending legacy rows are simply never claimed (parked); forward deduction runs through the dedicated
 * occurrence lane (occurrence-deduction-outbox.ts -> applyOccurrenceClaims).
 */
export async function processInventoryDeductionOutboxEvent(_row: {
  orderId: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  throw new Error(
    'PS-497 Release B: the legacy inventory_deduction_requested lane is quarantined (fail-closed). ' +
      'Occurrence deduction runs through the dedicated occurrence worker; this event must not execute.',
  );
}
