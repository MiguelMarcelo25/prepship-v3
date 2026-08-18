/**
 * PS-502 — persist a replacement's planned billing lines.
 *
 * REQUIRES `unlock shipped data`. Runs INSIDE the atomic shipped command's transaction, so a
 * billing failure rolls back the stock movement that would otherwise have gone unbilled.
 *
 * INSERT WITH RETURNING, AND COUNT THE RETURNED ROWS
 *
 * `onConflictDoNothing` is deliberately absent. On a money path a conflict is not a
 * no-op — it means a line already exists that this plan did not know about, and swallowing it
 * reports success while the invoice carries something else. The partial unique index from
 * 0097 turns that into a loud failure, and the failure is correct.
 *
 * The persisted count comes from the RETURNED rows rather than from the plan's length: those
 * are the same number only when the insert actually did what was asked, and the whole point
 * of counting is to notice when it did not.
 */
import { eq } from 'drizzle-orm';
import { billingLineItems } from '../db/schema/billing';
import { replacements } from '../db/schema/replacements';
import {
  assertReplacementLineInvariants,
  planReplacementBillingLines,
  ReplacementBillingPlanError,
  type PlannedReplacementLine,
  type ReplacementBillingFacts,
} from './replacement-billing-planner';

export type WriteReplacementBillingResult = {
  linesWritten: number;
  lineTypes: string[];
};

/**
 * Plan and persist, inside a caller-supplied transaction.
 *
 * Takes the transaction rather than a connection: this must commit with the inventory
 * movement and the state transition, not beside them.
 */
export async function writeReplacementBillingInTransaction(
  tx: any,
  facts: ReplacementBillingFacts,
): Promise<WriteReplacementBillingResult> {
  const planned = planReplacementBillingLines(facts);
  if (planned.length === 0) return { linesWritten: 0, lineTypes: [] };

  // Re-read the replacement inside the transaction and check every line against it. The
  // planner was handed facts; this proves the facts still describe the row being billed.
  const [replacement] = await tx.select().from(replacements)
    .where(eq(replacements.id, facts.replacementId)).limit(1);
  if (!replacement) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_IDENTITY_INVALID',
      `replacement ${facts.replacementId} disappeared while its billing was being written`,
    );
  }
  for (const line of planned) {
    assertReplacementLineInvariants(line, {
      id: replacement.id,
      orderId: replacement.orderId,
      replacementShipmentId: replacement.replacementShipmentId,
    });
  }

  const inserted = await tx.insert(billingLineItems).values(
    planned.map((line: PlannedReplacementLine) => ({
      clientId: line.clientId,
      orderId: line.orderId,
      orderNumber: line.orderNumber,
      shipmentId: line.shipmentId,
      replacementId: line.replacementId,
      lineType: line.lineType,
      description: line.description,
      qty: line.qty,
      unitCost: line.unitCost,
      totalCost: line.totalCost,
      shipDate: line.shipDate,
      billingEffectiveDate: line.billingEffectiveDate,
      billingPolicyVersion: line.billingPolicyVersion,
    })),
  ).returning({ id: billingLineItems.id, lineType: billingLineItems.lineType });

  // Counted from what came back. A shorter result than the plan means the database wrote less
  // than was asked for, and continuing would report a complete charge that is not there.
  if (inserted.length !== planned.length) {
    throw new ReplacementBillingPlanError(
      'REPLACEMENT_BILLING_IDENTITY_INVALID',
      `planned ${planned.length} replacement billing lines but persisted ${inserted.length}`,
      { replacementId: facts.replacementId },
    );
  }

  return {
    linesWritten: inserted.length,
    lineTypes: (inserted as Array<{ lineType: string }>).map((row) => row.lineType),
  };
}
