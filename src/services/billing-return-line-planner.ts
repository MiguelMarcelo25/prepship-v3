// PS-487 slice 2 — plan the billing lines a set of returns should produce.
//
// Pure: takes returns + client config, returns line candidates. Writes nothing, reads
// no database. The generator inserts what this plans, so every rule about WHICH lines
// exist and WHAT they cost is testable offline.
//
// Idempotency is enforced by the database, not by this planner. billing_line_items
// carries a unique index on (order_id, line_type, description) where shipment_id is
// null, so embedding the canonical event key in the description makes a duplicate a
// loud constraint failure rather than a silent second charge — the same choice PS-425
// made for shipment lines via withShipmentBillingLineage.

import {
  RETURN_PROCESSING_LINE_TYPE,
  RETURN_SHIPPING_LINE_TYPE,
  isReturnProcessingFeeEligible,
  resolveReturnBillingEventDate,
  resolveReturnCustomerShippingAmount,
  returnBillingEventKey,
  type ReturnBillingEventKind,
} from './billing-return-event-contract';

export type ReturnBillingSourceRow = {
  id: number;
  orderId: number;
  orderNumber?: string | null;
  clientId: number | null;
  createdAt: unknown;
  /** Admin-corrected billing day (AC-4), when one has been set. */
  billingDateOverride?: unknown;
  returnCustomerShippingRate?: unknown;
  returnReference?: string | null;
};

export type ReturnBillingLinePlan = {
  clientId: number;
  orderId: number;
  orderNumber: string | null;
  /**
   * PS-488 M2 — relational return identity, written to billing_line_items.return_id.
   *
   * Required, not optional: a return line that cannot say which return it belongs to is
   * exactly the gap AC-7 could not close. The alternatives were parsing the event key
   * out of `description`, or matching order_id + line_type — the latter mis-attributes
   * the first time an order has a second return.
   */
  returnId: number;
  lineType: ReturnBillingEventKind;
  description: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  /** Actual activity day. */
  shipDate: string;
  /** Invoice bucket — the canonical return event date (AC-3). */
  billingEffectiveDate: string;
  /** Carried for reporting/debug; the DB key is the description. */
  eventKey: string;
};

export type ReturnBillingSkip = {
  returnId: number;
  reason:
    | 'before_cutover'
    | 'not_eligible'
    | 'no_client'
    | 'no_customer_shipping_rate'
    /**
     * Billable in policy terms, but every line came to nothing: no processing fee
     * configured AND no customer shipping captured. Recorded rather than dropped —
     * see the note on planReturnBillingLines about invisible returns.
     */
    | 'no_billable_amount';
};

/**
 * The description doubles as the durable idempotency key, because the unique index
 * includes it. Human-readable first so an invoice stays legible, key appended.
 */
export function returnLineDescription(input: {
  kind: ReturnBillingEventKind;
  returnId: number;
  returnReference?: string | null;
}): string {
  const label =
    input.kind === RETURN_PROCESSING_LINE_TYPE ? 'Return processing' : 'Return shipping';
  const ref = typeof input.returnReference === 'string' && input.returnReference.trim()
    ? ` · ${input.returnReference.trim()}`
    : '';
  return `${label}${ref} · ${returnBillingEventKey({ returnId: input.returnId, kind: input.kind })}`;
}

/**
 * Plan every return billing line for the supplied returns.
 *
 * A return produces at most two lines:
 *   return_processing — as soon as the return exists, with no shipment/label needed;
 *   return_label      — only when a customer return-shipping rate is configured.
 *
 * A $0.00 processing fee produces NO processing line (DJ, 2026-08-05). Every client's
 * return_processing_fee is 0.00 and the chosen policy is shipping-only, so emitting the
 * line would put a $0.00 row on every invoice that says nothing.
 *
 * This reverses the original rationale here, which argued a $0 row means "we looked and
 * it is free" the way PS-377 does for cancelled orders. The counter-argument holds for
 * cancelled orders because $0 IS the finding; here $0 only means "no fee is configured",
 * which is true of every client and so tells the reader nothing.
 *
 * The cost of collapsing them is that a return with no fee AND no captured shipping
 * produces nothing at all and would vanish from the invoice. That case is therefore
 * recorded as a 'no_billable_amount' skip rather than dropped silently — the return
 * stays visible to reporting even when it is worth nothing.
 */
export function planReturnBillingLines(input: {
  returns: ReturnBillingSourceRow[];
  /** billing_config.return_processing_fee for the client. */
  returnProcessingFeeByClientId: Map<number, number>;
  /** Test-only cutover override; production uses the constant. */
  cutoverDay?: string;
}): { lines: ReturnBillingLinePlan[]; skipped: ReturnBillingSkip[] } {
  const lines: ReturnBillingLinePlan[] = [];
  const skipped: ReturnBillingSkip[] = [];

  for (const row of input.returns) {
    if (row.clientId == null) {
      skipped.push({ returnId: row.id, reason: 'no_client' });
      continue;
    }
    const eligible = isReturnProcessingFeeEligible({
      returnId: row.id,
      clientId: row.clientId,
      createdAt: row.createdAt,
      cutoverDay: input.cutoverDay,
    });
    if (!eligible) {
      // Distinguish the policy skip from a data skip so reporting can tell them apart.
      const day = resolveReturnBillingEventDate({ createdAt: row.createdAt });
      skipped.push({
        returnId: row.id,
        reason: day ? 'before_cutover' : 'not_eligible',
      });
      continue;
    }

    const activityDay = resolveReturnBillingEventDate({ createdAt: row.createdAt })!;
    const effectiveDay = resolveReturnBillingEventDate({
      createdAt: row.createdAt,
      correctedDate: row.billingDateOverride,
    })!;
    const orderNumber = row.orderNumber ?? null;

    const fee = input.returnProcessingFeeByClientId.get(row.clientId) ?? 0;
    if (fee > 0) lines.push({
      clientId: row.clientId,
      orderId: row.orderId,
      orderNumber,
      returnId: row.id,
      lineType: RETURN_PROCESSING_LINE_TYPE,
      description: returnLineDescription({
        kind: RETURN_PROCESSING_LINE_TYPE,
        returnId: row.id,
        returnReference: row.returnReference,
      }),
      qty: '1',
      unitCost: fee.toFixed(2),
      totalCost: fee.toFixed(2),
      shipDate: activityDay,
      billingEffectiveDate: effectiveDay,
      eventKey: returnBillingEventKey({ returnId: row.id, kind: RETURN_PROCESSING_LINE_TYPE }),
    });

    const shipping = resolveReturnCustomerShippingAmount({
      returnCustomerShippingRate: row.returnCustomerShippingRate,
    });
    if (shipping == null) {
      // With a fee configured the return is still on the invoice, so the skip explains
      // one missing line. With no fee it produced NOTHING, which is the case that would
      // make a real return invisible — name it differently so reporting can find it.
      skipped.push({
        returnId: row.id,
        reason: fee > 0 ? 'no_customer_shipping_rate' : 'no_billable_amount',
      });
      continue;
    }
    lines.push({
      clientId: row.clientId,
      orderId: row.orderId,
      orderNumber,
      returnId: row.id,
      lineType: RETURN_SHIPPING_LINE_TYPE,
      description: returnLineDescription({
        kind: RETURN_SHIPPING_LINE_TYPE,
        returnId: row.id,
        returnReference: row.returnReference,
      }),
      qty: '1',
      unitCost: shipping.toFixed(2),
      totalCost: shipping.toFixed(2),
      shipDate: activityDay,
      billingEffectiveDate: effectiveDay,
      eventKey: returnBillingEventKey({ returnId: row.id, kind: RETURN_SHIPPING_LINE_TYPE }),
    });
  }

  return { lines, skipped };
}
