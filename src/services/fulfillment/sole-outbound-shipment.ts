import { and, eq, ne, or, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shipments } from '../../db/schema/shipments.js';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * PS-505: is this shipment the order's ONLY live outbound shipment?
 *
 * `loadWholeOrderShipmentLines` deliberately does not check this. It answers "what are the
 * order's lines", and reading the order's lines is only a correct answer for the SHIPMENT
 * when the shipment's scope equals the order's scope. `labels.ts` earns that by calling the
 * lifecycle command with `requireAwaitingOrderStatus` + `requireNoActiveOutboundShipment`,
 * so the label being bought is provably the sole outbound shipment.
 *
 * The ShipStation sync path has no such precondition available — it is ingesting a shipment
 * that already happened — so it must establish the same fact directly. That is what this
 * does, and it is the entire reason the sync fallback is safe.
 *
 * Returns false the moment the answer is not certain. A second outbound shipment means the
 * order was split, and the order's full line list would over-deduct: every line would be
 * claimed by every shipment.
 *
 * Voided shipments and returns are excluded — neither consumes outbound stock — but the
 * shipment being asked about must itself be live, or the question is meaningless.
 */
export async function isSoleOutboundShipment(
  tx: DbTransaction,
  orderId: number,
  shipmentId: number,
): Promise<boolean> {
  const liveOutbound = and(
    eq(shipments.orderId, orderId),
    or(eq(shipments.voided, false), isNull(shipments.voided)),
    or(eq(shipments.isReturn, false), isNull(shipments.isReturn)),
  );

  const [self] = await tx
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(liveOutbound, eq(shipments.id, shipmentId)))
    .limit(1);
  // The caller's own shipment is voided, a return, or not on this order.
  if (!self) return false;

  const [others] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(shipments)
    .where(and(liveOutbound, ne(shipments.id, shipmentId)));

  return Number(others?.n ?? 0) === 0;
}
