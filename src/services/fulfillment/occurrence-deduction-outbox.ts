// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.4x) — the dedicated
// occurrence-deduction lane. This is a SEPARATE event type + queue from the quarantined legacy
// inventory_deduction_requested lane; the generic outbox worker is de-scoped to never claim it, and ONLY the
// dedicated occurrence worker drains it. This file is shipped-data LOCKED (it owns an inventory queue that
// authorizes movement). It records occurrence-scoped intent only; the executor owns all stock math + the
// narrow FULFILLMENT_OCCURRENCE_EXECUTION + INVENTORY_AUTO_DEDUCT gates.
import { db, sql as pg } from '../../db/client.js';
import { fulfillmentOutbox } from '../../db/schema/fulfillment-outbox.js';
import { applyOccurrenceClaims } from '../fulfillment-deductions.js';
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
  /** Distinguishes a reverse/void trigger from the forward deduct so it is not deduped away by a prior
   *  forward event on the same occurrence (e.g. 'reverse:{lifecycleEventId}'). Default: forward-only. */
  dedupeDiscriminator?: string;
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

  const dedupeKey = input.dedupeDiscriminator
    ? `${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}:occ:${input.occurrenceId}:${input.dedupeDiscriminator}`
    : `${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}:occ:${input.occurrenceId}`;
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

const OCCURRENCE_OUTBOX_LEASE_MINUTES = 10;
const OCCURRENCE_OUTBOX_RETRY_MINUTES = 5;

type OccurrenceOutboxRow = { id: number; payload: Record<string, unknown>; attempts: number };

/**
 * Claim due occurrence-deduction rows EXCLUSIVELY by the dedicated event type. Mirrors the generic worker's
 * lease pattern (reclaim stranded 'processing' rows past the lease) but never overlaps its selection — the
 * two workers partition the fulfillment_outbox table cleanly by event_type.
 */
async function claimDueOccurrenceOutboxRows(limit: number): Promise<OccurrenceOutboxRow[]> {
  return pg`
    UPDATE fulfillment_outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM fulfillment_outbox
      WHERE event_type = ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}
        AND (
          (status IN ('pending', 'failed') AND next_run_at <= NOW())
          OR (status = 'processing' AND updated_at < NOW() - (${OCCURRENCE_OUTBOX_LEASE_MINUTES} || ' minutes')::interval)
        )
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload, attempts
  ` as Promise<OccurrenceOutboxRow[]>;
}

/**
 * Drain occurrence-deduction intents. The SOLE dispatch target is the occurrence executor
 * (applyOccurrenceClaims) — never the legacy processInventoryDeductionOutboxEvent / writer-side resolution.
 * lockedDown (a flag off) keeps the row retryable so no work is lost when the canary is later enabled.
 */
export async function processFulfillmentOccurrenceOutboxOnce(
  options: { limit?: number } = {},
): Promise<{ claimed: number; applied: number; parked: number; lockedDown: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = await claimDueOccurrenceOutboxRows(limit);
  let applied = 0;
  let parked = 0;
  let lockedDown = 0;
  for (const row of rows) {
    const occurrenceId = Number(row.payload.occurrenceId ?? 0);
    if (!Number.isInteger(occurrenceId) || occurrenceId <= 0) {
      await pg`UPDATE fulfillment_outbox SET status = 'failed', last_error = 'missing occurrenceId in payload', updated_at = NOW() WHERE id = ${row.id}`;
      parked += 1;
      continue;
    }
    try {
      const result = await applyOccurrenceClaims(occurrenceId);
      if (result.lockedDown) {
        // Master or the narrow execution flag is off — keep the intent retryable, do not settle.
        await pg`UPDATE fulfillment_outbox SET status = 'pending', next_run_at = NOW() + (${OCCURRENCE_OUTBOX_RETRY_MINUTES} || ' minutes')::interval, updated_at = NOW() WHERE id = ${row.id}`;
        lockedDown += 1;
      } else {
        await pg`UPDATE fulfillment_outbox SET status = 'succeeded', last_error = NULL, updated_at = NOW() WHERE id = ${row.id}`;
        applied += result.applied;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pg`UPDATE fulfillment_outbox SET status = 'failed', attempts = attempts + 1, last_error = ${message}, next_run_at = NOW() + (${OCCURRENCE_OUTBOX_RETRY_MINUTES} || ' minutes')::interval, updated_at = NOW() WHERE id = ${row.id}`;
      parked += 1;
    }
  }
  return { claimed: rows.length, applied, parked, lockedDown };
}
