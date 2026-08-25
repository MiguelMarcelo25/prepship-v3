// Per user override unlock shipped data on 2026-07-14: durable inventory-deduction lane.
// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE. The
// legacy minters + recovery re-minter + processor are retired (no-op / fail-closed); the event constant +
// predicate are retained ONLY for parking + the discrepancy report. The db-client, outbox schema, and
// fulfillment-deductions imports are no longer needed here (the occurrence lane owns write + execute).
import { db } from '../../db/client.js';

export const INVENTORY_DEDUCTION_OUTBOX_EVENT = 'inventory_deduction_requested';

export function isInventoryDeductionOutboxEvent(eventType: string): boolean {
  return eventType === INVENTORY_DEDUCTION_OUTBOX_EVENT;
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
  _input: {
    lifecycleEventId: number;
    orderId: number;
    shipmentId?: number | null;
    source: string;
  },
  _executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  // Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE.
  // The legacy inventory_deduction_requested lane is retired — the generic worker no longer claims it and its
  // processor fails closed. Minting new legacy events would only grow an unclaimed backlog, so this is a
  // no-op. Forward deduction intent is now minted occurrence-scoped by the owner under
  // FULFILLMENT_OCCURRENCE_PROJECTION (occurrence-deduction-outbox.ts::enqueueOccurrenceDeduction).
  return;
}

export async function enqueueInventoryDeduction(
  _order: InventoryDeductionOrderRef,
  _input: InventoryDeductionOutboxInput,
  _executor: InventoryDeductionOutboxExecutor = db,
): Promise<void> {
  // Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) QUARANTINE.
  // The pure-legacy order-keyed minter (bundle deduct-once fan-out) is retired — bundle/package deduction is
  // intentionally NOT migrated in Release B, and the narrow occurrence-execution gate must never unlock it.
  // A no-op documented park, not a silent regression.
  return;
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
