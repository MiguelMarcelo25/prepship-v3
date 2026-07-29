import { logStructured } from '../lib/structured-log';

/**
 * PS-467: a shipment that cannot be attributed to an order must say so.
 *
 * shipment-sync resolves an order by source identity, then by ShipStation's
 * orderId -> orders.external_order_id. When both miss, the insert path writes
 * `order_id: null` and persists the row anyway -- no error, no reason, no
 * counter. The row then joins to nothing, so every order-scoped read misses it:
 * order detail, Print Queue, billing joins, shipped history, and compliance
 * queries.
 *
 * That silence is the real defect. 4,004 of 28,310 shipments (14.1%) carry a
 * NULL order_id, accumulated since 2024-02, and it was found only by accident
 * in 2026-07 while tracing a dangerous-goods label that had become invisible.
 * The UPDATE path already learned this lesson -- it carries a "never null a
 * link" guard -- but INSERT never got the equivalent rule.
 *
 * This module does not decide whether to persist the row. Dropping shipments
 * would lose provider truth we may need later. It makes the condition LOUD and
 * countable so the next cause surfaces in days rather than in years.
 */

export type UnattributedShipmentReason =
  /** The provider sent no order number at all -- a standalone/manual label. */
  | 'blank_order_number'
  /** An order number was present but no PrepShip order matched it. */
  | 'order_not_found';

export type UnattributedShipmentSample = {
  shipmentId: number;
  orderNumber: string | null;
  reason: UnattributedShipmentReason;
};

export function classifyUnattributedShipment(input: {
  orderNumber?: string | null;
}): UnattributedShipmentReason {
  const orderNumber = (input.orderNumber ?? '').trim();
  return orderNumber === '' ? 'blank_order_number' : 'order_not_found';
}

/** How many examples to name per batch. Enough to act on, not enough to flood. */
const SAMPLE_LIMIT = 5;

/**
 * Emit one summary line per sync batch rather than one per row -- a busy Monday
 * batch can carry 130 of these, and per-row logging would bury the signal it is
 * meant to raise.
 */
export function reportUnattributedShipments(
  samples: readonly UnattributedShipmentSample[],
  context: { account: string },
): void {
  if (samples.length === 0) return;

  const byReason = new Map<UnattributedShipmentReason, number>();
  for (const sample of samples) {
    byReason.set(sample.reason, (byReason.get(sample.reason) ?? 0) + 1);
  }

  logStructured('warn', 'shipment_sync.unattributed_insert', {
    account: context.account,
    count: samples.length,
    blankOrderNumber: byReason.get('blank_order_number') ?? 0,
    orderNotFound: byReason.get('order_not_found') ?? 0,
    sampleShipmentIds: samples.slice(0, SAMPLE_LIMIT).map((s) => s.shipmentId).join(','),
    sampleOrderNumbers: samples
      .slice(0, SAMPLE_LIMIT)
      .map((s) => s.orderNumber ?? '(blank)')
      .join(','),
  });
}
