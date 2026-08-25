// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.6) — the operator
// review-resolver. Shipped-data LOCKED (it mutates shipped claim state). An operator moves a status='review'
// occurrence claim to 'pending' (re-deriving disposition from canonical data + passing the structural + scope
// fences, then minting a deduped occurrence intent in the SAME transaction) or to 'not_applicable' (won't
// deduct). It NEVER moves stock synchronously — execution still requires the dedicated worker + all three
// flags. It refuses to promote external, unknown, superseded, historical (occurrence_id IS NULL), or malformed
// claims. The thin route delegates here; it never owns the disposition rule.
import { and, eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { fulfillmentLineClaims } from '../../db/schema/order-lifecycle.js';
import { fulfillmentOccurrences } from '../../db/schema/fulfillment-occurrences.js';
import { orders } from '../../db/schema/orders.js';
import { decideClaimDisposition } from './line-supply-policy.js';
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

  // Lock the occurrence + verify not superseded.
  const [occ] = await tx
    .select({ id: fulfillmentOccurrences.id, orderId: fulfillmentOccurrences.orderId, supersededBy: fulfillmentOccurrences.supersededByOccurrenceId })
    .from(fulfillmentOccurrences)
    .where(eq(fulfillmentOccurrences.id, claim.occurrenceId))
    .for('update')
    .limit(1);
  if (!occ) throw new Error(`occurrence ${claim.occurrenceId} does not exist`);
  if (occ.supersededBy != null) throw new Error(`occurrence ${claim.occurrenceId} is superseded`);

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
  const disposition = decideClaimDisposition({
    supply: 'prepship',
    evidence: 'exact_shipment',
    hasCanonicalSku: !!claim.sku,
    quantity: claim.quantity,
    soleOutbound: true,
  });
  if (disposition.status !== 'pending') {
    throw new Error(`claim ${input.claimId} does not satisfy the deductible predicate (canonical sku + positive quantity)`);
  }

  const [order] = await tx
    .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
    .from(orders)
    .where(eq(orders.id, claim.orderId))
    .limit(1);
  if (!order) throw new Error(`order ${claim.orderId} no longer exists`);

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
