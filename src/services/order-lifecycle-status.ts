import { sql, type SQL } from 'drizzle-orm';
import { orders } from '../db/schema/orders';
import type { ShippedLabelDisplayState } from './shipping-workflow/shipped-label-display-state';

export type BillingLifecycleSourceStatus = 'shipped' | 'cancelled';

export type OrderLifecycleStatus =
  | 'awaiting'
  | 'shipped'
  | 'cancelled'
  | 'upstream_cancelled'
  | 'externally_shipped'
  | 'shipped_pending_confirmation'
  | 'confirmation_failed'
  | 'voided_label'
  | 'missing_shipment_sync'
  | 'on_hold'
  | 'awaiting_payment'
  | 'pending_fulfillment';

export type OrderLifecycleStatusInput = {
  orderStatus?: string | null;
  canonicalStatus?: string | null;
  externallyShipped?: boolean | null;
  shippedLabelDisplayState?: ShippedLabelDisplayState | null;
};

export type OrderLifecycleStatusResult = {
  effectiveOrderStatus: string;
  orderLifecycleStatus: OrderLifecycleStatus;
  orderLifecycleLabel: string;
  orderLifecycleReason: string;
  isTerminal: boolean;
  isShippingBlocked: boolean;
  billingStatus: BillingLifecycleSourceStatus | null;
};

function normalizeStatus(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function result(
  effectiveOrderStatus: string,
  orderLifecycleStatus: OrderLifecycleStatus,
  orderLifecycleLabel: string,
  orderLifecycleReason: string,
  isTerminal: boolean,
  isShippingBlocked: boolean,
  billingStatus: BillingLifecycleSourceStatus | null,
): OrderLifecycleStatusResult {
  return {
    effectiveOrderStatus,
    orderLifecycleStatus,
    orderLifecycleLabel,
    orderLifecycleReason,
    isTerminal,
    isShippingBlocked,
    billingStatus,
  };
}

export function resolveOrderLifecycleStatus(
  input: OrderLifecycleStatusInput,
): OrderLifecycleStatusResult {
  const orderStatus = normalizeStatus(input.orderStatus) || 'awaiting_shipment';
  const canonicalStatus = normalizeStatus(input.canonicalStatus);

  if (orderStatus === 'cancelled') {
    return result(
      'cancelled',
      'cancelled',
      'Cancelled',
      'order_status=cancelled',
      true,
      true,
      'cancelled',
    );
  }

  if (canonicalStatus === 'cancelled') {
    return result(
      'cancelled',
      'upstream_cancelled',
      'Cancelled upstream',
      `canonical_status=cancelled while local order_status is still ${orderStatus}`,
      true,
      true,
      'cancelled',
    );
  }

  if (orderStatus === 'shipped') {
    if (canonicalStatus === 'confirmation_failed') {
      return result(
        'shipped',
        'confirmation_failed',
        'Confirmation failed',
        'canonical_status=confirmation_failed',
        true,
        true,
        'shipped',
      );
    }

    if (canonicalStatus === 'shipped_pending_confirmation') {
      return result(
        'shipped',
        'shipped_pending_confirmation',
        'Shipped pending confirmation',
        'canonical_status=shipped_pending_confirmation',
        true,
        true,
        'shipped',
      );
    }

    if (input.shippedLabelDisplayState === 'voided_label') {
      return result(
        'shipped',
        'voided_label',
        'Voided label',
        'shipped label display state=voided_label',
        true,
        true,
        'shipped',
      );
    }

    if (input.shippedLabelDisplayState === 'missing_shipment_sync') {
      return result(
        'shipped',
        'missing_shipment_sync',
        'Missing shipment sync',
        'shipped label display state=missing_shipment_sync',
        true,
        true,
        'shipped',
      );
    }

    if (input.shippedLabelDisplayState === 'external_label' || input.externallyShipped === true) {
      return result(
        'shipped',
        'externally_shipped',
        'Externally shipped',
        input.shippedLabelDisplayState === 'external_label'
          ? 'shipped label display state=external_label'
          : 'externally_shipped=true',
        true,
        true,
        'shipped',
      );
    }

    return result(
      'shipped',
      'shipped',
      'Shipped',
      'order_status=shipped',
      true,
      true,
      'shipped',
    );
  }

  if (input.externallyShipped === true) {
    return result(
      'shipped',
      'externally_shipped',
      'Externally shipped',
      'externally_shipped=true',
      true,
      true,
      'shipped',
    );
  }

  if (orderStatus === 'on_hold') {
    return result('on_hold', 'on_hold', 'On hold', 'order_status=on_hold', false, true, null);
  }

  if (orderStatus === 'awaiting_payment') {
    return result(
      'awaiting_payment',
      'awaiting_payment',
      'Awaiting payment',
      'order_status=awaiting_payment',
      false,
      true,
      null,
    );
  }

  if (orderStatus === 'pending_fulfillment') {
    return result(
      'pending_fulfillment',
      'pending_fulfillment',
      'Pending fulfillment',
      'order_status=pending_fulfillment',
      false,
      true,
      null,
    );
  }

  return result(
    'awaiting_shipment',
    'awaiting',
    'Awaiting shipment',
    `order_status=${orderStatus}`,
    false,
    false,
    null,
  );
}

export function isBillingLifecycleSourceStatus(
  lifecycle: Pick<OrderLifecycleStatusResult, 'billingStatus'> | null | undefined,
): boolean {
  return lifecycle?.billingStatus === 'shipped' || lifecycle?.billingStatus === 'cancelled';
}

export function orderLifecycleEffectiveStatusSql(): SQL<string> {
  return sql<string>`case
    when lower(coalesce(${orders.orderStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${orders.canonicalStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${orders.orderStatus}, '')) = 'shipped' then 'shipped'
    when coalesce(${orders.externallyShipped}, false) = true then 'shipped'
    else coalesce(nullif(lower(${orders.orderStatus}), ''), 'awaiting_shipment')
  end`;
}

function aliasColumn(alias: string, columnName: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Unsafe SQL alias for order lifecycle status: ${alias}`);
  }
  return sql.raw(`${alias}.${columnName}`);
}

export function orderLifecycleEffectiveStatusAliasSql(alias: string): SQL<string> {
  const orderStatus = aliasColumn(alias, 'order_status');
  const canonicalStatus = aliasColumn(alias, 'canonical_status');
  const externallyShipped = aliasColumn(alias, 'externally_shipped');
  return sql<string>`case
    when lower(coalesce(${orderStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${canonicalStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${orderStatus}, '')) = 'shipped' then 'shipped'
    when coalesce(${externallyShipped}, false) = true then 'shipped'
    else coalesce(nullif(lower(${orderStatus}), ''), 'awaiting_shipment')
  end`;
}

export function orderLifecycleStatusSql(): SQL<string> {
  return sql<string>`case
    when lower(coalesce(${orders.orderStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${orders.canonicalStatus}, '')) = 'cancelled' then 'upstream_cancelled'
    when lower(coalesce(${orders.canonicalStatus}, '')) = 'confirmation_failed' then 'confirmation_failed'
    when lower(coalesce(${orders.canonicalStatus}, '')) = 'shipped_pending_confirmation' then 'shipped_pending_confirmation'
    when lower(coalesce(${orders.orderStatus}, '')) = 'shipped' then 'shipped'
    when coalesce(${orders.externallyShipped}, false) = true then 'externally_shipped'
    when lower(coalesce(${orders.orderStatus}, '')) = 'on_hold' then 'on_hold'
    when lower(coalesce(${orders.orderStatus}, '')) = 'awaiting_payment' then 'awaiting_payment'
    when lower(coalesce(${orders.orderStatus}, '')) = 'pending_fulfillment' then 'pending_fulfillment'
    else 'awaiting'
  end`;
}

export function orderLifecycleStatusAliasSql(alias: string): SQL<string> {
  const orderStatus = aliasColumn(alias, 'order_status');
  const canonicalStatus = aliasColumn(alias, 'canonical_status');
  const externallyShipped = aliasColumn(alias, 'externally_shipped');
  return sql<string>`case
    when lower(coalesce(${orderStatus}, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(${canonicalStatus}, '')) = 'cancelled' then 'upstream_cancelled'
    when lower(coalesce(${canonicalStatus}, '')) = 'confirmation_failed' then 'confirmation_failed'
    when lower(coalesce(${canonicalStatus}, '')) = 'shipped_pending_confirmation' then 'shipped_pending_confirmation'
    when lower(coalesce(${orderStatus}, '')) = 'shipped' then 'shipped'
    when coalesce(${externallyShipped}, false) = true then 'externally_shipped'
    when lower(coalesce(${orderStatus}, '')) = 'on_hold' then 'on_hold'
    when lower(coalesce(${orderStatus}, '')) = 'awaiting_payment' then 'awaiting_payment'
    when lower(coalesce(${orderStatus}, '')) = 'pending_fulfillment' then 'pending_fulfillment'
    else 'awaiting'
  end`;
}

export function orderLifecycleBillingSourcePredicate(): SQL {
  return sql`(
    lower(coalesce(${orders.orderStatus}, '')) in ('shipped', 'cancelled')
    or lower(coalesce(${orders.canonicalStatus}, '')) = 'cancelled'
    or coalesce(${orders.externallyShipped}, false) = true
  )`;
}

export function orderLifecycleBillingSourcePredicateAlias(alias: string): SQL {
  const orderStatus = aliasColumn(alias, 'order_status');
  const canonicalStatus = aliasColumn(alias, 'canonical_status');
  const externallyShipped = aliasColumn(alias, 'externally_shipped');
  return sql`(
    lower(coalesce(${orderStatus}, '')) in ('shipped', 'cancelled')
    or lower(coalesce(${canonicalStatus}, '')) = 'cancelled'
    or coalesce(${externallyShipped}, false) = true
  )`;
}
