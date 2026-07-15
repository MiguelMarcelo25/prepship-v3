/**
 * PS-425 canonical ShipmentAggregate policy.
 *
 * Billing cardinality is per active outbound shipment. Returns and voided
 * labels are never active outbound evidence, while distinct replacement
 * shipments remain independently billable. The same active-set definition
 * controls whether voiding a label may reopen its order.
 */
import { and, eq, ne, type SQL } from 'drizzle-orm';
import { shipments } from '../db/schema/shipments';

export const SHIPMENT_BILLING_CARDINALITY = 'per_shipment' as const;

export type ActiveOutboundShipmentPredicateInput = {
  orderId?: number | null;
  excludeShipmentId?: number | null;
};

export function activeOutboundShipmentPredicate(
  input: ActiveOutboundShipmentPredicateInput = {},
): SQL {
  return and(
    eq(shipments.voided, false),
    eq(shipments.isReturn, false),
    input.orderId != null ? eq(shipments.orderId, input.orderId) : undefined,
    input.excludeShipmentId != null
      ? ne(shipments.id, input.excludeShipmentId)
      : undefined,
  )!;
}

export function withShipmentBillingLineage(
  description: string,
  shipmentId: number | null,
): string {
  const lineage = shipmentId == null
    ? 'external fulfillment'
    : `shipment #${shipmentId}`;
  return `${description} · ${lineage}`;
}

export type ShipmentVoidLifecycleDecision =
  | {
      kind: 'keep_shipped';
      nextOrderStatus: null;
      reason: 'active_outbound_shipment_remains';
    }
  | {
      kind: 'preserve_terminal';
      nextOrderStatus: null;
      reason: 'local_terminal' | 'upstream_terminal' | 'external_fulfillment';
    }
  | {
      kind: 'reopen';
      nextOrderStatus: 'awaiting_shipment';
      reason: 'final_active_outbound_shipment_voided';
    };

export type ShipmentVoidLifecycleInput = {
  remainingActiveOutboundShipmentCount: number;
  orderStatus?: string | null;
  canonicalStatus?: string | null;
  externallyShipped?: boolean | null;
};

function status(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export function decideShipmentVoidLifecycle(
  input: ShipmentVoidLifecycleInput,
): ShipmentVoidLifecycleDecision {
  if (input.remainingActiveOutboundShipmentCount > 0) {
    return {
      kind: 'keep_shipped',
      nextOrderStatus: null,
      reason: 'active_outbound_shipment_remains',
    };
  }

  const local = status(input.orderStatus);
  if (local === 'cancelled') {
    return {
      kind: 'preserve_terminal',
      nextOrderStatus: null,
      reason: 'local_terminal',
    };
  }

  const upstream = status(input.canonicalStatus);
  if (upstream === 'shipped' || upstream === 'cancelled') {
    return {
      kind: 'preserve_terminal',
      nextOrderStatus: null,
      reason: 'upstream_terminal',
    };
  }

  if (input.externallyShipped === true) {
    return {
      kind: 'preserve_terminal',
      nextOrderStatus: null,
      reason: 'external_fulfillment',
    };
  }

  return {
    kind: 'reopen',
    nextOrderStatus: 'awaiting_shipment',
    reason: 'final_active_outbound_shipment_voided',
  };
}
