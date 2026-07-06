import { and, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { replaceOrderItemsForOrders } from './order-items';
import { materializePackageFactsForImportedOrderIds } from './combo-package-defaults';
import type { NormalizedOrderSource } from './normalized-order-persistence';
import {
  legacyExternalOrderIdForSource,
  buildOrderSourceIdentity,
  legacyOrderSourceCompatibilityPredicate,
  orderSourceIdentityKey,
} from './order-source-identity';

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
  const identity = buildOrderSourceIdentity(order.source);
  if (!identity) {
    throw new Error('Cannot derive compatibility externalOrderId without a complete source identity');
  }
  return legacyExternalOrderIdForSource(identity);
}

export function dedupeNormalizedStoreOrdersForImport(
  ordersIn: NormalizedStoreOrder[],
): NormalizedStoreOrder[] {
  const passthrough: NormalizedStoreOrder[] = [];
  const bySourceIdentity = new Map<string, NormalizedStoreOrder>();

  for (const order of ordersIn) {
    const identity = buildOrderSourceIdentity(order.source);
    if (!identity) {
      passthrough.push(order);
      continue;
    }

    bySourceIdentity.set(orderSourceIdentityKey(identity), order);
  }

  return [...passthrough, ...bySourceIdentity.values()];
}

async function claimLegacyOrderSourceIdentities(rows: Array<typeof orders.$inferInsert>): Promise<void> {
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = buildOrderSourceIdentity(row);
    if (!identity || !row.externalOrderId) continue;
    const key = `${orderSourceIdentityKey(identity)}:${row.externalOrderId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const legacyPredicate = legacyOrderSourceCompatibilityPredicate([row.externalOrderId], {
      includeUnqualifiedShipStation: identity.sourceProvider === 'shipstation',
    });
    if (!legacyPredicate) continue;

    // Per user override unlock shipped data on 2026-07-06: PS-388 may claim
    // an exact legacy external_order_id row into the composite source identity
    // before the authoritative upsert. This only fills identity/provenance
    // fields and lets the existing terminal-status preservation below keep
    // shipped/cancelled protections intact.
    await db
      .update(orders)
      .set({
        sourceProvider: identity.sourceProvider,
        sourceAccountId: identity.sourceAccountId,
        sourceOrderId: identity.sourceOrderId,
        sourceOrderNumber: row.sourceOrderNumber ?? null,
        rawSourcePayload: row.rawSourcePayload ?? null,
      })
      .where(
        and(
          legacyPredicate,
          sql`not exists (
            select 1
            from orders source_conflict
            where source_conflict.source_provider = ${identity.sourceProvider}
              and source_conflict.source_account_id = ${identity.sourceAccountId}
              and source_conflict.source_order_id = ${identity.sourceOrderId}
              and source_conflict.id <> ${orders.id}
          )`,
        ),
      );
  }
}

export async function upsertNormalizedStoreOrders(
  ordersIn: NormalizedStoreOrder[],
): Promise<number> {
  if (!ordersIn.length) return 0;

  // Per user override unlock shipped data on 2026-07-06: source imports can
  // include the same provider order twice in one page; de-dupe before the
  // authoritative bulk upsert so one repeated source identity cannot reject the
  // whole batch. The terminal-status preservation below remains unchanged.
  const importOrders = dedupeNormalizedStoreOrdersForImport(ordersIn);

  type Row = typeof orders.$inferInsert;
  const rows: Row[] = importOrders.map((order) => ({
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

  await claimLegacyOrderSourceIdentities(rows);

  const persistedRows = await db
    .insert(orders)
    .values(rows)
    .onConflictDoUpdate({
      target: [orders.sourceProvider, orders.sourceAccountId, orders.sourceOrderId],
      targetWhere: sql`${orders.sourceProvider} is not null and ${orders.sourceAccountId} is not null and ${orders.sourceOrderId} is not null`,
      set: {
        externalOrderId: sql`excluded.external_order_id`,
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
        // Per user override unlock shipped data on 2026-07-06: PS-388 changes
        // the import identity key only. Existing terminal local rows stay
        // terminal; imports cannot rewrite shipped/cancelled state.
        orderStatus: sql`case
          when ${orders.orderStatus} in ('shipped', 'cancelled') then ${orders.orderStatus}
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
    })
    .returning({
      id: orders.id,
      items: orders.items,
      clientId: orders.clientId,
      storeId: orders.storeId,
      orderStatus: orders.orderStatus,
      orderDate: orders.orderDate,
    });

  await replaceOrderItemsForOrders(persistedRows);
  const persistedOrderIds = persistedRows.map((row) => row.id);

  // PS-205: imported package facts are FALLBACK ONLY. After every import batch
  // (this is the single persistence helper all order sources flow through),
  // saved client combo defaults are materialized onto mutable awaiting rows
  // that carry no operator/package-fact overrides — so a ShipStation re-import
  // of a stale 35 oz can never out-rank the operator's saved 31 oz / 12x10x3
  // combo default at any rating/label/list read site. Best-effort: a
  // materialization failure never fails the sync itself.
  try {
    await materializePackageFactsForImportedOrderIds(persistedOrderIds);
  } catch (err) {
    console.warn(
      '[store-order-import] package-facts materialization skipped:',
      err instanceof Error ? err.message : err,
    );
  }

  return rows.length;
}
