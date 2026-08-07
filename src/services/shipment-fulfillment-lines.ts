import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orderItems } from '../db/schema/order-items.js';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Canonical owner: what lines did a PrepShip-originated label actually ship?
 *
 * PS-497. Automatic inventory deduction stopped on 2026-07-16 and did not run for 22 days:
 * 1,193 orders shipped, zero `inventory_ledger` rows of type 'ship', and 2,651 claims
 * piled into `fulfillment_line_claims` with `status='review'` that nothing consumes.
 *
 * The cause was a gap in the PS-424 contract, not a mistake in it. PS-424 (commit
 * 0c8246f7) correctly stopped callers turning mutable order data into shipment truth, and
 * requires every shipped caller to supply either `kind: 'exact'` lines or a review-only
 * `kind: 'unavailable'` receipt. Provider-sourced callers can satisfy that —
 * `shipment-sync.ts` passes the provider's own `shipmentItems`, and the Shopify label path
 * passes the fulfillment order's remaining quantities. The ShipStation/direct label path
 * had NO line source in scope, so it hardcoded `unavailable`, and because
 * `normalizeFulfillmentFacts` stamps `reviewReason: 'fulfillment_lines_unavailable'` on
 * that receipt, the deduction enqueue condition in `applyOrderLifecycleCommandInTransaction`
 * (`fulfilledLines.some((line) => line.sku && !line.reviewReason)`) could never be true.
 * 100% of label purchases routed to review.
 *
 * ── Why reading the order's lines is sound HERE and only here ──────────────
 * This is not a re-introduction of "order.items is shipment truth". The label purchase
 * calls the lifecycle command with BOTH `requireAwaitingOrderStatus: true` AND
 * `requireNoActiveOutboundShipment: true` (labels.ts), so at the moment of the write the
 * order is awaiting shipment and has no other active outbound shipment. The label being
 * bought is therefore the order's SOLE outbound shipment, and the shipment's scope is
 * exactly the order's scope. Those two preconditions are what make the order's lines a
 * correct answer, and they are enforced in the same transaction that performs the write.
 *
 * Anything less certain still returns null, and the caller keeps emitting the
 * `unavailable` receipt. This narrows the gap; it does not weaken the contract.
 */

/** The line shape `normalizeFulfilledLines` consumes. Keys are read defensively there. */
export type ShipmentFulfillmentLine = {
  /**
   * PS-469: keyed on `lineIndex`, NOT the `order_items.id` serial. Sync DELETES and
   * re-inserts order_items on every pass, so the serial changes while the line does not.
   * Keying a durable claim on the serial would break idempotency the moment a sync ran
   * between two attempts at the same purchase.
   */
  lineKey: string;
  sku: string | null;
  name: string | null;
  quantity: number;
};

/**
 * The order's shippable lines, for the whole-order single-shipment case.
 *
 * Returns null when the answer is not certain, which the caller must treat as
 * `kind: 'unavailable'` exactly as before:
 *   - no line rows at all (nothing to deduct, and a synthetic 1-unit review receipt is a
 *     more honest record than an empty exact list);
 *   - any line with a non-positive or non-integer quantity, because a partially
 *     trustworthy list is not shipment truth. `normalizeFulfilledLines` would accept such
 *     a row with `reviewReason: 'invalid_quantity'`, which silently re-creates the very
 *     no-deduction state this fixes for the whole order.
 *
 * NOTE `quantity` is `numeric(12,3)`, which Drizzle returns as a STRING. It is filtered and
 * validated in TS rather than in SQL so a fractional or unparseable value is caught by the
 * same rule that rejects it, instead of being silently excluded by a `> 0` predicate.
 */
export async function loadWholeOrderShipmentLines(
  orderId: number,
  tx: DbTransaction,
): Promise<ShipmentFulfillmentLine[] | null> {
  const rows = await tx
    .select({
      lineIndex: orderItems.lineIndex,
      sku: orderItems.sku,
      name: orderItems.name,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.lineIndex);

  if (rows.length === 0) return null;

  const lines: ShipmentFulfillmentLine[] = [];
  for (const row of rows) {
    const quantity = Number(row.quantity);
    // A line we cannot state exactly makes the WHOLE list inexact. Fall back wholesale
    // rather than deducting some lines and quietly reviewing others — a partial deduction
    // is harder to reconcile than none, because nothing records what was skipped.
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) return null;
    lines.push({
      lineKey: String(row.lineIndex),
      sku: row.sku ?? null,
      name: row.name ?? null,
      quantity,
    });
  }
  return lines;
}
