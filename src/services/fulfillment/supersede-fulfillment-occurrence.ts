// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.5) — forward supersession
// of one physical occurrence by another, in ONE transaction. Shipped-data LOCKED (it mutates shipped
// claim/occurrence state). Supersession lives ONLY on fulfillment_occurrences + its projected claims — NEVER
// on the append-only order_lifecycle_events. Once superseded, the occurrence executor (applyOccurrenceClaims)
// re-verifies not-superseded under its own FOR UPDATE lock and moves no stock, so any already-queued
// occurrence intent for the superseded occurrence fails the fence.
import { and, eq, inArray } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { fulfillmentOccurrences } from '../../db/schema/fulfillment-occurrences.js';
import { fulfillmentLineClaims } from '../../db/schema/order-lifecycle.js';

export type SupersedeExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SupersedeOccurrenceInput {
  orderId: number;
  fromOccurrenceId: number;
  toOccurrenceId: number;
}

/**
 * Supersede `fromOccurrenceId` by `toOccurrenceId`. Both must belong to `orderId`. Rejects self-supersession,
 * cycles, and superseding an occurrence any of whose projected claims are already `applied` (that would strand
 * an executed movement). Sets superseded_by_occurrence_id and transitions ONLY the unapplied projected claims
 * (pending/review) to `superseded`, preserving their nullable quantities (0105). Returns the count transitioned.
 */
export async function supersedeFulfillmentOccurrence(
  tx: SupersedeExecutor,
  input: SupersedeOccurrenceInput,
): Promise<{ supersededClaims: number }> {
  const { orderId, fromOccurrenceId, toOccurrenceId } = input;
  if (fromOccurrenceId === toOccurrenceId) {
    throw new Error(`cannot supersede occurrence ${fromOccurrenceId} with itself`);
  }

  // Lock BOTH occurrence rows in deterministic id order (deadlock-safe).
  const locked = await tx
    .select({ id: fulfillmentOccurrences.id, orderId: fulfillmentOccurrences.orderId, supersededBy: fulfillmentOccurrences.supersededByOccurrenceId })
    .from(fulfillmentOccurrences)
    .where(inArray(fulfillmentOccurrences.id, [fromOccurrenceId, toOccurrenceId]))
    .orderBy(fulfillmentOccurrences.id)
    .for('update');
  const from = locked.find((r) => r.id === fromOccurrenceId);
  const to = locked.find((r) => r.id === toOccurrenceId);
  if (!from) throw new Error(`superseded occurrence ${fromOccurrenceId} does not exist`);
  if (!to) throw new Error(`superseding occurrence ${toOccurrenceId} does not exist`);
  if (Number(from.orderId) !== orderId || Number(to.orderId) !== orderId) {
    throw new Error(`supersession spans orders: occurrences must both belong to order ${orderId}`);
  }

  // Cycle guard: walk the `to` supersession chain; refuse if it reaches `from`.
  let cursor: number | null = to.supersededBy;
  const seen = new Set<number>([to.id]);
  while (cursor != null) {
    if (cursor === fromOccurrenceId) throw new Error('supersession would create a cycle');
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const [next] = await tx
      .select({ supersededBy: fulfillmentOccurrences.supersededByOccurrenceId })
      .from(fulfillmentOccurrences)
      .where(eq(fulfillmentOccurrences.id, cursor))
      .limit(1);
    cursor = next?.supersededBy ?? null;
  }

  // Unapplied-only: refuse if any projected claim on `from` is already applied (an executed movement).
  const appliedClaims = await tx
    .select({ id: fulfillmentLineClaims.id })
    .from(fulfillmentLineClaims)
    .where(and(eq(fulfillmentLineClaims.occurrenceId, fromOccurrenceId), eq(fulfillmentLineClaims.status, 'applied')))
    .limit(1);
  if (appliedClaims.length > 0) {
    throw new Error(`cannot supersede occurrence ${fromOccurrenceId}: it has an applied (executed) claim`);
  }

  await tx
    .update(fulfillmentOccurrences)
    .set({ supersededByOccurrenceId: toOccurrenceId, updatedAt: new Date() })
    .where(eq(fulfillmentOccurrences.id, fromOccurrenceId));

  // Transition ONLY the unapplied projected claims (pending/review) to superseded; preserve quantities.
  const superseded = await tx
    .update(fulfillmentLineClaims)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(
      eq(fulfillmentLineClaims.occurrenceId, fromOccurrenceId),
      inArray(fulfillmentLineClaims.status, ['pending', 'review']),
    ))
    .returning({ id: fulfillmentLineClaims.id });

  return { supersededClaims: superseded.length };
}
