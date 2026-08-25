// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) — the dedicated
// occurrence-deduction lane. This is a SEPARATE event type + queue from the quarantined legacy
// inventory_deduction_requested lane; the generic outbox worker is de-scoped to never claim it, and ONLY the
// dedicated occurrence worker drains it. This file is shipped-data LOCKED (it owns an inventory queue that
// authorizes movement). It records occurrence-scoped intent only; the executor owns all stock math + the
// narrow FULFILLMENT_OCCURRENCE_EXECUTION + INVENTORY_AUTO_DEDUCT gates.
import { db } from '../../db/client.js';
import { fulfillmentOutbox } from '../../db/schema/fulfillment-outbox.js';
import {
  occurrenceInExecutionScope,
  type OccurrenceExecutionScope,
} from './occurrence-execution-scope.js';

/** The distinct event type the dedicated occurrence worker owns EXCLUSIVELY (never the generic worker). */
export const FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT = 'fulfillment_occurrence_deduction_requested';
const OCCURRENCE_DEDUCTION_PROVIDER = 'inventory_occurrence';

export function isFulfillmentOccurrenceDeductionOutboxEvent(eventType: string): boolean {
  return eventType === FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT;
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type OccurrenceOutboxExecutor = typeof db | DbTransaction;

export interface EnqueueOccurrenceDeductionInput {
  occurrenceId: number;
  orderId: number;
  shipmentId: number | null;
  clientId: number | null;
  storeId: number | null;
  source: string;
}

/**
 * Mint ONE occurrence-deduction intent per occurrence, ONLY when the occurrence passes the execution scope
 * fence (approved allowlist + canary floor + occurrence present). The caller (the owner) proves the per-line
 * structural half first: it calls this only when at least one just-inserted claim has
 * supply='prepship' + status='pending' + a canonical line identity (disposition.enqueue). Dedup by
 * occurrence id, so retries and the two converging writers collapse to a single event. Returns whether an
 * intent was minted (nothing is minted for out-of-scope / below-floor occurrences).
 */
export async function enqueueOccurrenceDeduction(
  input: EnqueueOccurrenceDeductionInput,
  scope: OccurrenceExecutionScope,
  executor: OccurrenceOutboxExecutor = db,
): Promise<{ enqueued: boolean; reason: string }> {
  const gate = occurrenceInExecutionScope(
    { occurrenceId: input.occurrenceId, clientId: input.clientId, storeId: input.storeId, orderId: input.orderId },
    scope,
  );
  if (!gate.eligible) return { enqueued: false, reason: gate.reason };

  const dedupeKey = `${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}:occ:${input.occurrenceId}`;
  await executor
    .insert(fulfillmentOutbox)
    .values({
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      eventType: FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT,
      provider: OCCURRENCE_DEDUCTION_PROVIDER,
      dedupeKey,
      payload: {
        occurrenceId: input.occurrenceId,
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
  return { enqueued: true, reason: 'ok' };
}
