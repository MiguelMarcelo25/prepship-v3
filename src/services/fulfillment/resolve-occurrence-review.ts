// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.6) — the operator
// review-resolver. Shipped-data LOCKED (it mutates shipped claim state). An operator moves a status='review'
// occurrence claim to 'pending' (re-deriving disposition from canonical data + passing the structural + scope
// fences, then minting a deduped occurrence intent in the SAME transaction) or to 'not_applicable' (won't
// deduct). It NEVER moves stock synchronously — execution still requires the dedicated worker + all three
// flags. It refuses to promote external, unknown, superseded, historical (occurrence_id IS NULL), or malformed
// claims. The thin route delegates here; it never owns the disposition rule.
import { and, eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { fulfillmentLineClaims, orderLifecycleEvents } from '../../db/schema/order-lifecycle.js';
import { fulfillmentOccurrences } from '../../db/schema/fulfillment-occurrences.js';
import { orders } from '../../db/schema/orders.js';
import { shipments } from '../../db/schema/shipments.js';
import { activeOutboundShipmentPredicate } from '../shipment-aggregate.js';
import { decideClaimDisposition, type LineEvidence } from './line-supply-policy.js';
import {
  readOccurrenceExecutionScope,
  claimEligibleForExecution,
} from './occurrence-execution-scope.js';
import { enqueueOccurrenceDeduction } from './occurrence-deduction-outbox.js';

export type ReviewResolverExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ResolveOccurrenceReviewInput {
  claimId: number;
  decision: 'pending' | 'not_applicable';
  operator: { email: string | null };
}

export interface ResolveOccurrenceReviewResult {
  claimId: number;
  status: 'pending' | 'not_applicable';
  enqueued: boolean;
}

export async function resolveOccurrenceReviewClaim(
  tx: ReviewResolverExecutor,
  input: ResolveOccurrenceReviewInput,
): Promise<ResolveOccurrenceReviewResult> {
  const operatorLabel = input.operator.email ?? 'operator';

  const [claim] = await tx
    .select()
    .from(fulfillmentLineClaims)
    .where(eq(fulfillmentLineClaims.id, input.claimId))
    .for('update')
    .limit(1);
  if (!claim) throw new Error(`claim ${input.claimId} does not exist`);
  if (claim.status !== 'review') throw new Error(`claim ${input.claimId} is ${claim.status}, not review`);
  if (claim.occurrenceId == null || claim.canonicalLineIdentity == null) {
    throw new Error(`claim ${input.claimId} has no occurrence identity (historical backlog is fenced)`);
  }

  // Lock the ORDER row FOR UPDATE first (the aggregate root). Every shipment-lifecycle writer that could add
  // or void an outbound shipment goes through the lifecycle owner, which also locks the order FOR UPDATE — so
  // taking this lock serializes the sole-outbound recheck below against a concurrent second-shipment creation
  // or void (Hermes #3: lock/recheck the relevant shipment state so a race cannot promote an over-deduction).
  const [order] = await tx
    .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
    .from(orders)
    .where(eq(orders.id, claim.orderId))
    .for('update')
    .limit(1);
  if (!order) throw new Error(`order ${claim.orderId} no longer exists`);

  // Lock the occurrence + verify not superseded.
  const [occ] = await tx
    .select({
      id: fulfillmentOccurrences.id,
      orderId: fulfillmentOccurrences.orderId,
      shipmentId: fulfillmentOccurrences.shipmentId,
      supersededBy: fulfillmentOccurrences.supersededByOccurrenceId,
    })
    .from(fulfillmentOccurrences)
    .where(eq(fulfillmentOccurrences.id, claim.occurrenceId))
    .for('update')
    .limit(1);
  if (!occ) throw new Error(`occurrence ${claim.occurrenceId} does not exist`);
  if (occ.supersededBy != null) throw new Error(`occurrence ${claim.occurrenceId} is superseded`);
  // Identity agreement: a claim whose occurrence points at a different order is malformed and must refuse
  // BEFORE we load that claim's order and evaluate scope (Hermes #3 — cross-order combination).
  if (occ.orderId !== claim.orderId) {
    throw new Error(`claim ${input.claimId} order ${claim.orderId} disagrees with occurrence ${occ.id} order ${occ.orderId}`);
  }
  // A shipment-backed occurrence whose soft shipment reference disagrees with the claim's shipment is
  // likewise malformed (both present + different local shipment ids).
  if (occ.shipmentId != null && claim.shipmentId != null && occ.shipmentId !== claim.shipmentId) {
    throw new Error(`claim ${input.claimId} shipment ${claim.shipmentId} disagrees with occurrence shipment ${occ.shipmentId}`);
  }

  const now = new Date();

  if (input.decision === 'not_applicable') {
    await tx
      .update(fulfillmentLineClaims)
      .set({ status: 'not_applicable', lastError: `operator_not_applicable:${operatorLabel}`, updatedAt: now })
      .where(eq(fulfillmentLineClaims.id, input.claimId));
    return { claimId: input.claimId, status: 'not_applicable', enqueued: false };
  }

  // decision === 'pending': re-derive disposition from canonical data. Only a prepship, deductible line can be
  // promoted — external/unknown supply and a non-deductible disposition are refused.
  if (claim.supply !== 'prepship') {
    throw new Error(`claim ${input.claimId} supply=${claim.supply}: only a prepship claim can be promoted to pending`);
  }
  // Read the AUTHORITATIVE line-evidence fact the owner persisted on the immutable lifecycle event (Hermes #3).
  // The occurrence DISCRIMINATOR identifies the physical occurrence; it does NOT prove the supplied quantities
  // were exact shipment-scoped lines. A provider/local shipment occurrence can still carry whole-order-fallback
  // lines, so inferring evidence from the discriminator could promote a fallback claim as exact (ignoring the
  // sole-outbound restriction) and over-deduct. If the evidence was not recorded, fail closed.
  const [lifecycleEvent] = await tx
    .select({ provenance: orderLifecycleEvents.provenance })
    .from(orderLifecycleEvents)
    .where(eq(orderLifecycleEvents.id, claim.lifecycleEventId))
    .limit(1);
  const recorded = (lifecycleEvent?.provenance as { ps497LineEvidence?: unknown } | null)?.ps497LineEvidence;
  if (recorded !== 'exact_shipment' && recorded !== 'whole_order_fallback' && recorded !== 'unavailable') {
    throw new Error(`claim ${input.claimId} has no recorded line evidence — cannot prove exact vs whole-order fallback; refusing promotion`);
  }
  const evidence: LineEvidence = recorded;
  if (evidence === 'unavailable') {
    throw new Error(`claim ${input.claimId} carries unavailable line evidence (no canonical line to deduct)`);
  }

  // For a whole-order FALLBACK, deduction is safe ONLY when this is the order's sole active outbound shipment
  // (else the order's full line list over-deducts, once per shipment). Recompute that over the CANONICAL active
  // outbound SHIPMENTS set using the SAME predicate the owner uses — NOT an occurrence count. A second live
  // shipment that has not yet produced an occurrence row must still make this not-sole. Read under the order
  // lock taken above. exact_shipment evidence deducts even for a split, so it does not consult sole-outbound.
  let soleOutbound = false;
  if (evidence === 'whole_order_fallback') {
    if (claim.shipmentId == null) {
      throw new Error(`claim ${input.claimId} whole-order fallback has no shipment reference to prove sole-outbound; refusing`);
    }
    const active = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(activeOutboundShipmentPredicate({ orderId: claim.orderId }))
      .limit(2);
    soleOutbound = active.length === 1 && Number(active[0]?.id) === claim.shipmentId;
  }
  const disposition = decideClaimDisposition({
    supply: 'prepship',
    evidence,
    hasCanonicalSku: !!claim.sku,
    quantity: claim.quantity,
    soleOutbound,
  });
  if (disposition.status !== 'pending') {
    throw new Error(
      `claim ${input.claimId} does not satisfy the deductible predicate (evidence=${evidence}, soleOutbound=${soleOutbound}, sku=${claim.sku ?? 'null'}, qty=${claim.quantity ?? 'null'})`,
    );
  }

  const scope = readOccurrenceExecutionScope();
  const gate = claimEligibleForExecution({
    occurrenceId: claim.occurrenceId,
    canonicalLineIdentity: claim.canonicalLineIdentity,
    supply: 'prepship',
    status: 'pending',
    superseded: false,
    clientId: order.clientId,
    storeId: order.storeId,
    orderId: order.id,
  }, scope);
  if (!gate.eligible) throw new Error(`claim ${input.claimId} is out of execution scope: ${gate.reason}`);

  await tx
    .update(fulfillmentLineClaims)
    .set({ status: 'pending', lastError: `operator_resolved_by:${operatorLabel}`, updatedAt: now })
    .where(and(eq(fulfillmentLineClaims.id, input.claimId), eq(fulfillmentLineClaims.status, 'review')));

  // Durability: mint a deduped occurrence intent in the SAME transaction (Hermes #7/#9). This does NOT move
  // stock — the dedicated worker + all three flags do. Operator identity rides the intent source.
  const { enqueued } = await enqueueOccurrenceDeduction({
    occurrenceId: claim.occurrenceId,
    orderId: order.id,
    shipmentId: claim.shipmentId ?? null,
    clientId: order.clientId,
    storeId: order.storeId,
    source: `review_resolve:${operatorLabel}`,
    dedupeDiscriminator: `review:${input.claimId}`,
  }, scope, tx);

  return { claimId: input.claimId, status: 'pending', enqueued };
}
