import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems } from '../db/schema/billing';
import { returnActivityEvents, returns } from '../db/schema/returns';
import { BILLING_RETURN_LINE_TYPES } from './billing-return-line-types';
import {
  RETURN_BILLING_DATE_CORRECTED_EVENT,
  type PersistedReturnDateCorrectionAudit,
  type ReturnDateCorrectionAudit,
} from './billing-return-date-correction';

// PS-487 AC-4/AC-7 — PERSIST an already-decided return billing-date correction.
//
// Split from the route because routes stay thin (validate -> call service -> return
// DTO); PS-464's architecture ratchet enforces that, and it caught this write living
// inline in src/routes/billing.ts.
//
// Split from billing-return-date-correction.ts because that module is PURE — it decides
// and is testable with no database. This one only writes what that one decided; it
// re-derives nothing and takes no view on whether the correction was allowed.

// PS-521: the return spellings come from the one owner. This used to assemble its own list —
// the two canonical constants plus three legacy strings typed by hand — which was a third copy
// of the vocabulary and would have missed any spelling added to the owner alone.

export async function applyReturnBillingDateCorrection(input: {
  returnId: number;
  newBillingDay: string;
  /** The decision outcome, recorded as the event status. */
  outcome: 'move' | 'adjustment_required';
  audit: ReturnDateCorrectionAudit;
  actorId: string;
  actorEmail?: string | null;
  now?: Date;
}): Promise<PersistedReturnDateCorrectionAudit> {
  const now = input.now ?? new Date();
  // One transaction: a correction applied without its audit row would defeat AC-7, and
  // affected-row evidence gathered outside it could describe a different set of rows
  // than the one the correction actually moved.
  return db.transaction(async (tx) => {
    // AC-7 affected rows. Relational, via PS-488 M2's return_id — not by parsing the
    // event key out of `description`, and not by matching order_id + line_type, which
    // mis-attributes as soon as an order has a second return.
    const affected = await tx
      .select({ id: billingLineItems.id })
      .from(billingLineItems)
      .where(eq(billingLineItems.returnId, input.returnId));

    // How much of this return's billing history predates M2 and therefore cannot be
    // attributed. Scoped to this return's own order so the count means something; still
    // only a count, never an attribution.
    const [ret] = await tx
      .select({ orderId: returns.orderId })
      .from(returns)
      .where(eq(returns.id, input.returnId))
      .limit(1);
    let unattributedLegacyReturnLines = 0;
    if (ret?.orderId != null) {
      const [gap] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(billingLineItems)
        .where(
          and(
            eq(billingLineItems.orderId, ret.orderId),
            isNull(billingLineItems.returnId),
            inArray(billingLineItems.lineType, [...BILLING_RETURN_LINE_TYPES]),
          ),
        );
      unattributedLegacyReturnLines = Number(gap?.n ?? 0);
    }

    const persisted: PersistedReturnDateCorrectionAudit = {
      ...input.audit,
      affectedBillingLineItemIds: affected.map((row) => row.id),
      unattributedLegacyReturnLines,
    };

    await tx
      .update(returns)
      .set({
        billingDateOverride: new Date(`${input.newBillingDay}T00:00:00.000Z`),
        billingDateOverrideBy: input.actorId,
        billingDateOverrideReason: input.audit.reason,
      })
      .where(eq(returns.id, input.returnId));
    // Append-only. The original returns.created_at is never touched — AC-7 needs it as
    // evidence of when the return actually entered the system.
    await tx.insert(returnActivityEvents).values({
      returnId: input.returnId,
      eventType: RETURN_BILLING_DATE_CORRECTED_EVENT,
      status: input.outcome,
      detail: JSON.stringify(persisted),
      actorType: 'admin',
      actorEmail: input.actorEmail ?? null,
      eventAt: now,
      createdAt: now,
    });

    return persisted;
  });
}
