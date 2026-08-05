import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { returnActivityEvents, returns } from '../db/schema/returns';
import {
  RETURN_BILLING_DATE_CORRECTED_EVENT,
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

export async function applyReturnBillingDateCorrection(input: {
  returnId: number;
  newBillingDay: string;
  /** The decision outcome, recorded as the event status. */
  outcome: 'move' | 'adjustment_required';
  audit: ReturnDateCorrectionAudit;
  actorId: string;
  actorEmail?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  // One transaction: a correction applied without its audit row would defeat AC-7.
  await db.transaction(async (tx) => {
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
      detail: JSON.stringify(input.audit),
      actorType: 'admin',
      actorEmail: input.actorEmail ?? null,
      eventAt: now,
      createdAt: now,
    });
  });
}
