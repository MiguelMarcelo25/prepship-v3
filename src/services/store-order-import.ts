import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { replaceOrderItemsForExternalOrderIds } from './order-items';
import type { NormalizedOrderSource } from './normalized-order-persistence';

export type NormalizedStoreOrder = {
  source: NormalizedOrderSource;
  externalOrderId?: string | null;
  orderNumber: string;
  orderStatus: string;
  orderDate: Date | null;
  clientId: number | null;
  storeId: number | null;
  customerEmail?: string | null;
  shipToName?: string | null;
  shipToCity?: string | null;
  shipToState?: string | null;
  shipToPostalCode?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  weightOz?: number | null;
  orderTotal?: string;
  shippingAmount?: string;
  items?: unknown[];
  raw: Record<string, unknown>;
  externallyShipped?: boolean;
};

function compatibilityExternalOrderId(order: NormalizedStoreOrder): string {
  if (order.externalOrderId) return order.externalOrderId;
  return `${order.source.sourceProvider}-${order.source.sourceOrderId}`;
}

export async function upsertNormalizedStoreOrders(
  ordersIn: NormalizedStoreOrder[],
): Promise<number> {
  if (!ordersIn.length) return 0;

  type Row = typeof orders.$inferInsert;
  const rows: Row[] = ordersIn.map((order) => ({
    externalOrderId: compatibilityExternalOrderId(order),
    sourceProvider: order.source.sourceProvider,
    sourceAccountId: order.source.sourceAccountId,
    sourceOrderId: order.source.sourceOrderId,
    sourceOrderNumber: order.source.sourceOrderNumber,
    rawSourcePayload: order.source.rawSourcePayload,
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    orderDate: order.orderDate,
    clientId: order.clientId,
    storeId: order.storeId,
    customerEmail: order.customerEmail ?? null,
    shipToName: order.shipToName ?? null,
    shipToCity: order.shipToCity ?? null,
    shipToState: order.shipToState ?? null,
    shipToPostalCode: order.shipToPostalCode ?? null,
    carrierCode: order.carrierCode ?? null,
    serviceCode: order.serviceCode ?? null,
    weightOz: order.weightOz ?? null,
    orderTotal: order.orderTotal ?? '0',
    shippingAmount: order.shippingAmount ?? '0',
    items: order.items ?? [],
    raw: order.raw,
    externallyShipped: order.externallyShipped === true,
    updatedAt: new Date(),
  }));

  await db
    .insert(orders)
    .values(rows)
    .onConflictDoUpdate({
      target: orders.externalOrderId,
      set: {
        orderNumber: sql`excluded.order_number`,
        sourceProvider: sql`excluded.source_provider`,
        sourceAccountId: sql`excluded.source_account_id`,
        sourceOrderId: sql`excluded.source_order_id`,
        sourceOrderNumber: sql`excluded.source_order_number`,
        rawSourcePayload: sql`excluded.raw_source_payload`,
        // Per user override unlock shipped data on 2026-05-25: preserve
        // existing terminal local statuses while moving import persistence to
        // a store-connector-first helper. This keeps shipped/cancelled
        // protections intact and avoids reopening labels during provider lag.
        orderStatus: sql`case
          when ${orders.orderStatus} in ('shipped', 'cancelled')
            and excluded.order_status = 'awaiting_shipment'
            then ${orders.orderStatus}
          else excluded.order_status
        end`,
        orderDate: sql`excluded.order_date`,
        clientId: sql`excluded.client_id`,
        storeId: sql`excluded.store_id`,
        customerEmail: sql`excluded.customer_email`,
        shipToName: sql`excluded.ship_to_name`,
        shipToCity: sql`excluded.ship_to_city`,
        shipToState: sql`excluded.ship_to_state`,
        shipToPostalCode: sql`excluded.ship_to_postal_code`,
        carrierCode: sql`excluded.carrier_code`,
        serviceCode: sql`excluded.service_code`,
        weightOz: sql`excluded.weight_oz`,
        orderTotal: sql`excluded.order_total`,
        shippingAmount: sql`excluded.shipping_amount`,
        items: sql`excluded.items`,
        raw: sql`excluded.raw`,
        externallyShipped: sql`case when excluded.externally_shipped = true then true else orders.externally_shipped end`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  await replaceOrderItemsForExternalOrderIds(
    rows
      .map((row) => row.externalOrderId)
      .filter((id): id is string => Boolean(id)),
  );

  return rows.length;
}
