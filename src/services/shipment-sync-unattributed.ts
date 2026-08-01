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

/**
 * PS-467 historical audit. Why is an EXISTING orphan unattributed?
 *
 * Deliberately separate from classifyUnattributedShipment above, which runs at ingest
 * and can only see the row in front of it. This one is allowed cross-row evidence --
 * chiefly whether some LINKED shipment already carries the same tracking number, which
 * is the difference between "we lost this shipment" and "we ingested it twice".
 *
 * That distinction decided the disposition of the 4,004 historical orphans. 796 of them
 * have a linked sibling with identical tracking, created seconds to minutes earlier by
 * label purchase; the orphan is shipment sync re-ingesting the same physical label and
 * failing to match it. Measured 2026-08-01: 779 of the 796 share the sibling's ship_date
 * and 565 differ only in carrier_code (`stamps_com` vs `usps` naming one USPS label).
 *
 * Those are NOT recoverable links. The order already has its shipment; writing the
 * sibling's order_id onto the orphan would give 790 orders a second row for one physical
 * label, and for the 6 whose sibling is voided it would attach a row that falsely appears
 * live. The reason is the deliverable here, not a repair.
 *
 * Nothing is persisted. The relationship is derivable from the rows themselves, so
 * storing it would add a column to a locked table, a 790-row write to shipped data, and
 * a value that goes stale the moment a sibling is voided or re-linked.
 */
export type UnattributedShipmentAuditReason =
  /** A LINKED shipment already carries this tracking number -- the same label, twice. */
  | 'duplicate_of_shipment'
  /** No order number at all, and no sibling to explain it. */
  | 'blank_order_number'
  /** Belongs to a store excluded from order sync, so its order was never ingested (PS-468). */
  | 'excluded_store'
  /** An order number that matched nothing, with no sibling evidence. */
  | 'unmatched_order_number';

export type UnattributedShipmentAuditInput = {
  orderNumber: string | null;
  /** The linked shipment sharing this tracking number, when one exists. */
  duplicateOfShipmentId: number | null;
};

/**
 * Order matters. Sibling evidence outranks anything the order number suggests: a
 * duplicate of an excluded-store label is still a duplicate, and calling it
 * `excluded_store` would hide that the order already has the shipment.
 */
export function classifyUnattributedShipmentAudit(
  input: UnattributedShipmentAuditInput,
): UnattributedShipmentAuditReason {
  if (input.duplicateOfShipmentId !== null) return 'duplicate_of_shipment';
  const orderNumber = (input.orderNumber ?? '').trim();
  if (orderNumber === '') return 'blank_order_number';
  // PS-468: these SEAuto- numbers belong to stores excluded from order sync in April
  // 2026, so no PrepShip order for them can ever exist. Not a matching failure.
  if (orderNumber.startsWith('SEAuto-')) return 'excluded_store';
  return 'unmatched_order_number';
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
