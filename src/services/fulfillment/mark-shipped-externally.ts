// PS-136 (Per user override unlock shipped data on 2026-06-09): canonical owner for the manual
// "mark shipped externally" transition, extracted from the POST /orders/:id/shipped-external
// route handler so the business logic lives in a service (ARCHITECTURE.md: routes stay thin).
//
// LOCKDOWN SAFETY:
//   - The route MUST still call assertOrderEditable() BEFORE this service (it stays in the route
//     as the shipped/cancelled lockdown guard — never moved here).
//   - The flag=true status flip is FORWARD-ONLY: the UPDATE is gated with
//     `WHERE order_status = 'awaiting_shipment'`, so a shipped/cancelled order can NEVER be
//     re-flipped through this path. This is defense-in-depth (a STRENGTHENING) for any future
//     non-route caller; the route already guarantees awaiting via assertOrderEditable.
//   - deductInventoryForOrder is called UNCHANGED, so the INVENTORY_AUTO_DEDUCT kill switch still
//     governs deduction. Inventory-deduction + ShipStation-notify failures are logged, never
//     thrown (the local flip already happened; a retry would double-ack).
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { orders } from '../../db/schema/orders';
import { deductInventoryForOrder } from '../fulfillment-deductions';
import { ssMarkOrderShippedV1, asSSUpstreamOrderId } from '../../lib/shipstation/labels';
import { loadClientCredentials } from '../../lib/shipstation/credentials';
import { confirmShipmentDirectNow, resolveShipmentConfirmationProvider } from './outbox';

export type MarkShippedExternallyInput = {
  /** The already-fetched order row (the route SELECTs it after assertOrderEditable). */
  order: typeof orders.$inferSelect;
  /** true = mark shipped externally (forward-only awaiting->shipped); false = unmark the flag only. */
  flag: boolean;
  source?: string | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  notifyCustomer?: boolean;
  notifyMarketplace?: boolean;
};

export type MarkShippedExternallyResult = {
  /** true when the forward-only awaiting->shipped flip actually applied (false = order was not awaiting). */
  statusFlipped: boolean;
  notify: { ok: boolean; reason?: string };
};

export async function markOrderShippedExternally(
  input: MarkShippedExternallyInput,
): Promise<MarkShippedExternallyResult> {
  const { order, flag } = input;
  const id = order.id;

  let statusFlipped = false;
  if (flag) {
    // Forward-only: only an AWAITING order may transition to shipped + externally_shipped=true.
    // The WHERE guard makes this safe even if a future caller forgets assertOrderEditable.
    const updated = await db
      .update(orders)
      .set({ externallyShipped: true, orderStatus: 'shipped' as const, updatedAt: new Date() })
      .where(and(eq(orders.id, id), eq(orders.orderStatus, 'awaiting_shipment')))
      .returning({ id: orders.id });
    statusFlipped = updated.length > 0;
  } else {
    // Unmark: flip the flag only; never change status (we don't know the prior state).
    await db
      .update(orders)
      .set({ externallyShipped: false, updatedAt: new Date() })
      .where(eq(orders.id, id));
  }

  if (flag) {
    try {
      await deductInventoryForOrder(order, {
        source: input.source ? `external:${input.source}` : 'external',
      });
    } catch (err) {
      console.warn('[mark-shipped-externally] inventory deduction failed:', err);
    }
  }

  // Optional marketplace notify — only when the operator opted into a notify channel.
  // Failure is logged, never thrown (the local flip already happened; a retry would double-ack).
  //
  // Per user override unlock shipped data on 2026-06-13 (PS-192): the marketplace
  // identity now comes from the CANONICAL outbox resolver
  // (resolveShipmentConfirmationProvider — sourceProvider, falling back to the
  // externalOrderId prefix; the same single owner every label confirmation uses)
  // instead of hardcoding ShipStation for every order:
  //   - ShipStation-sourced orders keep the EXACT v1 markasshipped call below
  //     (ShipStation relays the confirmation to the marketplace, and the
  //     customer/sales-channel notify toggles only exist on that API).
  //   - Direct marketplace orders (walmart/ebay/…) dispatch through THEIR
  //     StoreConnector via confirmShipmentDirectNow — the same connector call
  //     the fulfillment-outbox worker makes. Previously these either failed
  //     with "no upstream ShipStation ID" or risked acking the wrong system.
  //   - Orders with no marketplace/source report an honest no-op.
  // The forward-only status flip, assertOrderEditable routing, and the
  // INVENTORY_AUTO_DEDUCT kill switch above are UNCHANGED — this override use
  // touches only the notify routing.
  const shouldNotify = flag && (input.notifyCustomer === true || input.notifyMarketplace === true);
  let notify: { ok: boolean; reason?: string } = { ok: false, reason: 'not requested' };
  if (shouldNotify) {
    const provider = resolveShipmentConfirmationProvider({
      sourceProvider: order.sourceProvider ?? null,
      externalOrderId: order.externalOrderId,
    });
    if (!provider) {
      notify = { ok: false, reason: 'no marketplace/source connector for this order — nothing to notify' };
    } else if (provider === 'shipstation') {
      const ssUpstreamOrderId = asSSUpstreamOrderId(order.externalOrderId);
      if (!ssUpstreamOrderId) {
        notify = { ok: false, reason: 'order has no upstream ShipStation ID — sync may be incomplete' };
      } else {
        try {
          const creds = await loadClientCredentials(order.clientId);
          const shipDate = new Date().toISOString().slice(0, 10);
          await ssMarkOrderShippedV1(
            {
              orderId: ssUpstreamOrderId,
              carrierCode: input.carrierCode ?? null,
              trackingNumber: input.trackingNumber ?? '',
              shipDate,
              notifyCustomer: input.notifyCustomer === true,
              notifySalesChannel: input.notifyMarketplace === true,
            },
            { apiKey: creds.apiKey ?? undefined, apiSecret: creds.apiSecret ?? undefined },
          );
          notify = { ok: true };
          console.info(
            `[mark-shipped-externally] notify ok orderId=${id} provider=shipstation ssOrderId=${ssUpstreamOrderId} ` +
              `customer=${input.notifyCustomer === true} marketplace=${input.notifyMarketplace === true}`,
          );
        } catch (notifyErr) {
          const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          notify = { ok: false, reason: msg };
          console.warn(`[mark-shipped-externally] notify FAILED orderId=${id} provider=shipstation reason=${msg}`);
        }
      }
    } else {
      const trackingNumber = String(input.trackingNumber ?? '').trim();
      if (!trackingNumber) {
        notify = {
          ok: false,
          reason: `${provider} requires a tracking number to confirm shipment — enter the external tracking number and retry`,
        };
      } else {
        try {
          notify = await confirmShipmentDirectNow({
            provider,
            order: {
              id: order.id,
              externalOrderId: order.externalOrderId,
              sourceProvider: order.sourceProvider ?? null,
              clientId: order.clientId,
              orderNumber: order.orderNumber,
            },
            trackingNumber,
            carrierCode: input.carrierCode ?? null,
            shipDate: new Date().toISOString().slice(0, 10),
            notifyCustomer: input.notifyCustomer === true,
            notifyMarketplace: input.notifyMarketplace === true,
          });
          if (notify.ok) {
            console.info(
              `[mark-shipped-externally] notify ok orderId=${id} provider=${provider} ` +
                `customer=${input.notifyCustomer === true} marketplace=${input.notifyMarketplace === true}`,
            );
          } else {
            console.warn(`[mark-shipped-externally] notify FAILED orderId=${id} provider=${provider} reason=${notify.reason}`);
          }
        } catch (notifyErr) {
          const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          notify = { ok: false, reason: msg };
          console.warn(`[mark-shipped-externally] notify FAILED orderId=${id} provider=${provider} reason=${msg}`);
        }
      }
    }
  }

  return { statusFlipped, notify };
}
