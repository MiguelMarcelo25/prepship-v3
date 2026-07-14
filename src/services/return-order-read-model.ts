import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export type ReturnOrderSummary = {
  returnId: number;
  returnReference: string | null;
  status: string;
  returnCustomerShippingRate: number | null;
};

type ReturnOrderSummaryRow = {
  orderId: number;
  returnId: number;
  returnReference: string | null;
  status: string;
  returnCustomerShippingRate: string | number | null;
};

/**
 * Page-bounded, read-only projection of the canonical return workflow. Rate
 * ranking and customer pricing stay in the return-label backend; this reader
 * only exposes the frozen snapshot shared with Client Portal and billing.
 */
export async function loadReturnOrderSummaries(
  orderIds: readonly number[],
): Promise<Map<number, ReturnOrderSummary>> {
  const uniqueOrderIds = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, ReturnOrderSummary>();
  if (uniqueOrderIds.length === 0) return out;

  const rows = await db.execute<ReturnOrderSummaryRow>(sql`
    select distinct on (r.order_id)
      r.order_id as "orderId",
      r.id as "returnId",
      r.return_reference as "returnReference",
      r.status,
      r.return_customer_shipping_rate as "returnCustomerShippingRate"
    from returns r
    where r.order_id in (${sql.join(uniqueOrderIds.map((id) => sql`${id}`), sql`, `)})
    order by r.order_id, r.created_at desc, r.id desc
  `);

  for (const row of rows) {
    const rate = row.returnCustomerShippingRate == null
      ? null
      : Number(row.returnCustomerShippingRate);
    out.set(row.orderId, {
      returnId: row.returnId,
      returnReference: row.returnReference,
      status: row.status,
      returnCustomerShippingRate: rate != null && Number.isFinite(rate) ? rate : null,
    });
  }
  return out;
}
