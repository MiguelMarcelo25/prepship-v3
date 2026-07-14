// Per user override unlock shipped data on 2026-07-14: canonical order reads moved here
// unchanged so the locked route remains transport/auth only; this service performs no writes.
import { orderOverrides } from '../db/schema/orders';
import {
  describeShippingService,
  evaluateShippingServiceEligibility,
  type ShippingServiceEligibilityContext,
} from '../lib/shipping-service-eligibility';
import {
  type CanonicalFieldSource,
  recordOrNull,
  stringOrNull,
  booleanOrNull,
  finiteNumberOrNull,
  sourceOf,
} from './orders-dto-primitives';
import {
  classifyShippingAddress,
  residentialForShipping,
} from './shipping-workflow/address-classification';
import {
  buildResidentialEvidenceFromOrder,
  type ResidentialAddressValidation,
  type ResidentialProviderMarker,
} from './shipping-workflow/residential-evidence';
import {
  recipientOverrideFromRecord,
  resolveRecipientForShipping,
} from './order-recipient-override';
import { resolveOrderLifecycleStatus } from './order-lifecycle-status';
import { resolveShippedLabelDisplayState } from './shipping-workflow/shipped-label-display-state';

const LEGACY_CLIENT_ID_BY_STORE_ID = new Map<number, number>([
  [367706, 7],
  [363392, 8],
  [376661, 9],
  [277422, 10],
  [376827, 10],
]);

const LEGACY_CLIENT_ID_BY_CURRENT_ID = new Map<number, number>([
  [8, 7],
  [9, 8],
  [10, 9],
  [11, 10],
  [12, 11],
]);

export function resolveLegacyClientId(
  clientId: number | null | undefined,
  storeId: number | null | undefined,
) {
  if (typeof storeId === 'number') {
    const byStore = LEGACY_CLIENT_ID_BY_STORE_ID.get(storeId);
    if (byStore != null) return byStore;
  }
  if (typeof clientId === 'number') {
    const byCurrentId = LEGACY_CLIENT_ID_BY_CURRENT_ID.get(clientId);
    if (byCurrentId != null) return byCurrentId;
  }
  return clientId ?? null;
}

export function orderShippingEligibilityContext(row: {
  clientId?: number | string | null;
  storeId?: number | string | null;
  clientName?: string | null;
}): ShippingServiceEligibilityContext {
  return {
    clientId: row.clientId ?? null,
    storeId: row.storeId ?? null,
    clientName: row.clientName ?? null,
  };
}

export function shippingRateEligibilityReason(
  context: ShippingServiceEligibilityContext,
  rate: unknown,
): string | null {
  const eligibility = evaluateShippingServiceEligibility(context, describeShippingService(rate));
  return eligibility.allowed ? null : eligibility.reason ?? 'Shipping service is not eligible for this order';
}

export function sanitizeAwaitingOverridesForShippingEligibility(
  order: { clientId?: number | string | null; storeId?: number | string | null; orderStatus?: string | null },
  overrides: typeof orderOverrides.$inferSelect | null,
): typeof orderOverrides.$inferSelect | null {
  if (!overrides?.bestRateJson || order.orderStatus === 'shipped' || order.orderStatus === 'cancelled') {
    return overrides;
  }
  const reason = shippingRateEligibilityReason(
    orderShippingEligibilityContext(order),
    overrides.bestRateJson,
  );
  if (!reason) return overrides;
  return {
    ...overrides,
    bestRateJson: null,
    bestRateAt: null,
    bestRateDims: null,
  };
}

function dateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

export function buildCanonicalOrderModel(
  order: Record<string, unknown>,
  overrides: Record<string, unknown> | null,
  legacyClientId: number | null,
  shipping: Record<string, unknown>,
  // PS-276 (slice 2b): optional resolver evidence (USPS/UPS/FedEx). Supplied by the list endpoint's
  // batch cache read when ADDRESS_RESOLVER=on (slice 2b-2); undefined today -> verdict unchanged.
  resolvedResidential?: { addressValidation?: ResidentialAddressValidation | null; providerMarker?: ResidentialProviderMarker | null } | null,
) {
  const raw = recordOrNull(order.raw) ?? {};
  const rawShipTo = recordOrNull(raw.shipTo) ?? {};
  const recipientOverride = recipientOverrideFromRecord(overrides?.recipientOverride);
  const resolvedRecipient = resolveRecipientForShipping({
    override: recipientOverride,
    rawShipTo,
    fallback: {
      name: stringOrNull(order.shipToName),
      city: stringOrNull(order.shipToCity),
      state: stringOrNull(order.shipToState),
      postalCode: stringOrNull(order.shipToPostalCode),
    },
  });
  const recipientAddress = resolvedRecipient.address;
  const recipientOverrideSource = sourceOf('local', 'order_overrides.recipient_override', 'PrepShip recipient override');
  const rawDimensions = recordOrNull(raw.dimensions) ?? {};
  const overrideDimensionLength = finiteNumberOrNull(overrides?.rateDimsL);
  const overrideDimensionWidth = finiteNumberOrNull(overrides?.rateDimsW);
  const overrideDimensionHeight = finiteNumberOrNull(overrides?.rateDimsH);
  const rawDimensionLength = finiteNumberOrNull(rawDimensions.length);
  const rawDimensionWidth = finiteNumberOrNull(rawDimensions.width);
  const rawDimensionHeight = finiteNumberOrNull(rawDimensions.height);
  const hasOverrideDimensions =
    overrideDimensionLength != null ||
    overrideDimensionWidth != null ||
    overrideDimensionHeight != null;

  const dimensionLength = overrideDimensionLength ?? rawDimensionLength;
  const dimensionWidth = overrideDimensionWidth ?? rawDimensionWidth;
  const dimensionHeight = overrideDimensionHeight ?? rawDimensionHeight;
  const dimensionSource =
    hasOverrideDimensions
      ? sourceOf('local', 'order_overrides.rateDims*', 'PrepShip dimension override')
      : dimensionLength != null && dimensionWidth != null && dimensionHeight != null && rawDimensions.length != null
      ? sourceOf('v1', 'orders.raw.dimensions', 'ShipStation v1 /orders.dimensions')
      : sourceOf('local', 'order_overrides.rateDims*', 'PrepShip dimension override fallback');
  const dimensionUnitsSource = stringOrNull(rawDimensions.units)
    ? sourceOf('v1', 'orders.raw.dimensions.units', 'ShipStation v1 /orders.dimensions.units')
    : sourceOf('derived', 'default dimensions.units', 'Defaulted to inches when ShipStation did not send units');
  const dimensions =
    dimensionLength != null && dimensionWidth != null && dimensionHeight != null
      ? {
          length: dimensionLength,
          width: dimensionWidth,
          height: dimensionHeight,
          units: stringOrNull(rawDimensions.units) ?? 'inches',
        }
      : null;
  const overrideWeightOz = finiteNumberOrNull(overrides?.rateWeightOz);
  const weightOz = overrideWeightOz ?? finiteNumberOrNull(order.weightOz);
  const orderId = finiteNumberOrNull(order.id);
  const clientId = finiteNumberOrNull(order.clientId);
  const storeId = finiteNumberOrNull(order.storeId);
  const sourceMap: Record<string, CanonicalFieldSource> = {
    id: sourceOf('local', 'orders.id', 'Postgres canonical order id'),
    orderId: sourceOf('local', 'orders.id', 'Postgres canonical order id'),
    externalOrderId: sourceOf('v1', 'orders.external_order_id', 'ShipStation v1 /orders.orderId'),
    orderNumber: sourceOf('v1', 'orders.order_number', 'ShipStation v1 /orders.orderNumber'),
    orderStatus: sourceOf('v1', 'orders.order_status', 'ShipStation v1 /orders.orderStatus'),
    orderDate: sourceOf('v1', 'orders.order_date', 'ShipStation v1 /orders.orderDate'),
    createdAt: sourceOf('local', 'orders.created_at', 'PrepShip order row create timestamp'),
    updatedAt: sourceOf('local', 'orders.updated_at', 'PrepShip order row update timestamp'),
    clientId: sourceOf('local', 'orders.client_id', 'PrepShip client/store mapping'),
    legacyClientId: sourceOf('derived', 'LEGACY_CLIENT_ID_BY_*', 'Derived from store/client id parity map'),
    storeId: sourceOf('v1', 'orders.store_id', 'ShipStation v1 /orders.advancedOptions.storeId'),
    'client.id': sourceOf('local', 'orders.client_id', 'PrepShip client/store mapping'),
    'client.legacyId': sourceOf('derived', 'LEGACY_CLIENT_ID_BY_*', 'Derived from store/client id parity map'),
    'client.storeId': sourceOf('v1', 'orders.store_id', 'ShipStation v1 /orders.advancedOptions.storeId'),
    'customer.email': sourceOf('v1', 'orders.customer_email', 'ShipStation v1 /orders.customerEmail'),
    'customer.username': sourceOf('v1', 'orders.raw.customerUsername', 'ShipStation v1 /orders.customerUsername'),
    'recipient.name': recipientOverride
      ? recipientOverrideSource
      : stringOrNull(rawShipTo.name)
      ? sourceOf('v1', 'orders.raw.shipTo.name', 'ShipStation v1 /orders.shipTo.name')
      : sourceOf('local', 'orders.ship_to_name', 'Synced fallback column from ShipStation v1 shipTo.name'),
    'recipient.company': recipientOverride ? recipientOverrideSource : sourceOf('v1', 'orders.raw.shipTo.company', 'ShipStation v1 /orders.shipTo.company'),
    'recipient.street1': recipientOverride ? recipientOverrideSource : sourceOf('v1', 'orders.raw.shipTo.street1', 'ShipStation v1 /orders.shipTo.street1'),
    'recipient.street2': recipientOverride ? recipientOverrideSource : sourceOf('v1', 'orders.raw.shipTo.street2', 'ShipStation v1 /orders.shipTo.street2'),
    'recipient.city': recipientOverride
      ? recipientOverrideSource
      : stringOrNull(rawShipTo.city)
      ? sourceOf('v1', 'orders.raw.shipTo.city', 'ShipStation v1 /orders.shipTo.city')
      : sourceOf('local', 'orders.ship_to_city', 'Synced fallback column from ShipStation v1 shipTo.city'),
    'recipient.state': recipientOverride
      ? recipientOverrideSource
      : stringOrNull(rawShipTo.state)
      ? sourceOf('v1', 'orders.raw.shipTo.state', 'ShipStation v1 /orders.shipTo.state')
      : sourceOf('local', 'orders.ship_to_state', 'Synced fallback column from ShipStation v1 shipTo.state'),
    'recipient.postalCode': recipientOverride
      ? recipientOverrideSource
      : stringOrNull(rawShipTo.postalCode)
      ? sourceOf('v1', 'orders.raw.shipTo.postalCode', 'ShipStation v1 /orders.shipTo.postalCode')
      : sourceOf('local', 'orders.ship_to_postal_code', 'Synced fallback column from ShipStation v1 shipTo.postalCode'),
    'recipient.country': recipientOverride
      ? recipientOverrideSource
      : stringOrNull(rawShipTo.country)
      ? sourceOf('v1', 'orders.raw.shipTo.country', 'ShipStation v1 /orders.shipTo.country')
      : sourceOf('derived', 'default recipient.country', 'Defaulted to US when ShipStation did not send a country'),
    'recipient.phone': recipientOverride ? recipientOverrideSource : sourceOf('v1', 'orders.raw.shipTo.phone', 'ShipStation v1 /orders.shipTo.phone'),
    'recipient.residential': overrides?.residential != null
      ? sourceOf('local', 'order_overrides.residential', 'PrepShip user override')
      : sourceOf('v1', 'orders.raw.shipTo.residential', 'ShipStation v1 /orders.shipTo.residential'),
    // PS-276 (slice 4): the resolved verdict is the canonical classifier output (money-safe).
    'recipient.residentialClassification': sourceOf('derived', 'classifyShippingAddress', 'PS-276 backend residential classifier (residentialForShipping money-safe policy)'),
    'recipient.residentialSource': sourceOf('derived', 'classifyShippingAddress', 'PS-276 classification provenance tier'),
    'recipient.residentialConfidence': sourceOf('derived', 'classifyShippingAddress', 'PS-276 classification confidence tier'),
    'recipient.addressVerified': recipientOverride ? recipientOverrideSource : sourceOf('v1', 'orders.raw.shipTo.addressVerified', 'ShipStation v1 /orders.shipTo.addressVerified'),
    weight: overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    weightOz: overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    'weight.value': overrideWeightOz != null
      ? sourceOf('local', 'order_overrides.rateWeightOz', 'PrepShip weight override')
      : sourceOf('v1', 'orders.weight_oz', 'ShipStation v1 /orders.weight.value normalized to ounces'),
    'weight.units': sourceOf('derived', 'canonical weight.units', 'Normalized to ounces for canonical rows'),
    dimensions: dimensionSource,
    'dimensions.length': dimensionSource,
    'dimensions.width': dimensionSource,
    'dimensions.height': dimensionSource,
    'dimensions.units': dimensionUnitsSource,
    packageCode: sourceOf('v1', 'orders.raw.packageCode', 'ShipStation v1 /orders.packageCode'),
    requestedShippingService: sourceOf('v1', 'orders.raw.requestedShippingService', 'ShipStation v1 /orders.requestedShippingService'),
    requestedServiceCode: stringOrNull(raw.serviceCode)
      ? sourceOf('v1', 'orders.raw.serviceCode', 'ShipStation v1 /orders.serviceCode')
      : sourceOf('local', 'orders.service_code', 'Synced fallback service column'),
    'totals.orderTotal': sourceOf('v1', 'orders.order_total', 'ShipStation v1 /orders.orderTotal'),
    'totals.shippingAmount': sourceOf('v1', 'orders.shipping_amount', 'ShipStation v1 /orders.shippingAmount'),
    items: sourceOf('v1', 'orders.items', 'ShipStation v1 /orders.items[]'),
    'flags.externallyShipped': sourceOf('local', 'orders.externally_shipped', 'PrepShip external-shipped override'),
    'flags.externallyFulfilled': sourceOf('v1', 'orders.raw.externallyFulfilled', 'ShipStation v1 /orders.externallyFulfilled'),
    'flags.externallyFulfilledVerified': sourceOf('local', 'orders.externally_fulfilled_verified', 'PrepShip verification flag'),
  };

  // PS-276 (slice 4): the resolved residential VERDICT (what the rate uses), via the SAME
  // evidence owner + classifier + money-safe policy as /rates/browse + rates-backfill — so
  // recipient.residentialClassification equals the rate fingerprint r= bit by construction.
  // (addressValidation/providerMarker resolver tiers arrive in slice 2b; until then this is
  // override+source, exactly what the rate path computes today.)
  const residentialEvidence = buildResidentialEvidenceFromOrder({
    rawShipTo: {
      ...rawShipTo,
      name: recipientAddress.name,
      company: recipientAddress.company,
    },
    manualOverrideResidential: overrides?.residential,
    shipToName: recipientAddress.name,
    resolved: resolvedResidential ?? null,
  });
  const residentialResult = classifyShippingAddress({
    orderId,
    clientId,
    storeId,
    shipTo: {
      name: residentialEvidence.toName,
      company: residentialEvidence.toCompany,
      city: recipientAddress.city,
      state: recipientAddress.state,
      postalCode: recipientAddress.postalCode,
      country: recipientAddress.country,
    },
    manualOverrideResidential: residentialEvidence.manualOverrideResidential,
    sourceResidential: residentialEvidence.sourceResidential,
    // PS-276 (slice 2b): resolver tiers 4/2 — undefined today (no caller supplies resolved evidence).
    addressValidation: residentialEvidence.addressValidation ?? undefined,
    providerMarker: residentialEvidence.providerMarker ?? undefined,
  });
  const residentialResolved = residentialForShipping(residentialResult);

  return {
    id: orderId,
    orderId,
    externalOrderId: stringOrNull(order.externalOrderId),
    orderNumber: stringOrNull(order.orderNumber),
    orderStatus: stringOrNull(order.orderStatus),
    // PS-128/PS-129: upstream cancellation hold signal for the UI (backend still hard-blocks).
    canonicalStatus: stringOrNull(order.canonicalStatus),
    orderDate: dateToIso(order.orderDate),
    createdAt: dateToIso(order.createdAt),
    updatedAt: dateToIso(order.updatedAt),
    clientId,
    legacyClientId,
    storeId,
    client: {
      id: clientId,
      legacyId: legacyClientId,
      storeId,
    },
    customer: {
      email: stringOrNull(order.customerEmail),
      username: stringOrNull(raw.customerUsername),
    },
    recipient: {
      name: recipientAddress.name,
      company: recipientAddress.company,
      street1: recipientAddress.street1,
      street2: recipientAddress.street2,
      city: recipientAddress.city,
      state: recipientAddress.state,
      postalCode: recipientAddress.postalCode,
      country: recipientAddress.country,
      phone: recipientAddress.phone,
      residential: booleanOrNull(overrides?.residential) ?? booleanOrNull(rawShipTo.residential),
      // PS-276 (slice 4): the resolved verdict (what the rate uses) + provenance for the resi/comm tag.
      residentialClassification: (residentialResolved ? 'residential' : 'commercial') as 'residential' | 'commercial',
      residentialSource: residentialResult.source,
      residentialConfidence: residentialResult.confidence,
      addressVerified: recipientAddress.addressVerified,
    },
    weight: weightOz != null ? { value: weightOz, units: 'ounces' } : null,
    weightOz,
    dimensions,
    packageCode: stringOrNull(raw.packageCode),
    requestedShippingService: stringOrNull(raw.requestedShippingService),
    requestedServiceCode: stringOrNull(raw.serviceCode) ?? stringOrNull(order.serviceCode),
    totals: {
      orderTotal: finiteNumberOrNull(order.orderTotal) ?? 0,
      shippingAmount: finiteNumberOrNull(order.shippingAmount) ?? 0,
    },
    items: Array.isArray(order.items) ? order.items : [],
    flags: {
      externallyShipped: Boolean(order.externallyShipped),
      externallyFulfilled: booleanOrNull(raw.externallyFulfilled),
      externallyFulfilledVerified: Boolean(order.externallyFulfilledVerified),
    },
    shipping,
    sourceMap: {
      ...sourceMap,
      ...recordOrNull(shipping.sourceMap),
    },
  };
}

export function buildOrderDetailPayload(
  order: Record<string, unknown>,
  overrides: Record<string, unknown> | null,
  shipmentRows: unknown[],
) {
  const safeOverrides = sanitizeAwaitingOverridesForShippingEligibility(
    {
      clientId: finiteNumberOrNull(order.clientId),
      storeId: finiteNumberOrNull(order.storeId),
      orderStatus: stringOrNull(order.orderStatus),
    },
    overrides as typeof orderOverrides.$inferSelect | null,
  ) as Record<string, unknown> | null;
  const legacyClientId = resolveLegacyClientId(
    finiteNumberOrNull(order.clientId),
    finiteNumberOrNull(order.storeId),
  );
  const detailBaseLifecycle = resolveOrderLifecycleStatus({
    orderStatus: stringOrNull(order.orderStatus),
    canonicalStatus: stringOrNull(order.canonicalStatus),
    externallyShipped: order.externallyShipped === true,
  });
  const detailOrderForCanonical = {
    ...order,
    orderStatus: detailBaseLifecycle.effectiveOrderStatus,
    effectiveOrderStatus: detailBaseLifecycle.effectiveOrderStatus,
    orderLifecycleStatus: detailBaseLifecycle.orderLifecycleStatus,
    orderLifecycleLabel: detailBaseLifecycle.orderLifecycleLabel,
    orderLifecycleReason: detailBaseLifecycle.orderLifecycleReason,
    isTerminalOrderLifecycle: detailBaseLifecycle.isTerminal,
    isShippingBlockedByLifecycle: detailBaseLifecycle.isShippingBlocked,
  };
  const canonicalOrder = buildCanonicalOrderModel(
    detailOrderForCanonical,
    safeOverrides,
    legacyClientId,
    {},
  );

  // PS-309 (Per user override unlock shipped data on 2026-06-23): stamp the SAME canonical
  // shipped-label display state onto the detail payload so the drawer reads the backend
  // verdict instead of guessing from shipments[0]. Only for shipped orders; read-only.
  const detailShipments = shipmentRows as Array<Record<string, unknown> | null>;
  const shippedLabelDisplayState =
    detailBaseLifecycle.effectiveOrderStatus === 'shipped'
      ? resolveShippedLabelDisplayState({
          externallyShipped: order.externallyShipped === true,
          externallyFulfilled: booleanOrNull(recordOrNull(order.raw)?.externallyFulfilled),
          hasActiveShipment: detailShipments.some((s) => s != null && s.voided !== true),
          hasVoidedShipment: detailShipments.some((s) => s != null && s.voided === true),
        })
      : null;
  // Per user override unlock shipped data on 2026-07-06: PS-387 detail payload
  // reads the same lifecycle SOT as the Orders list. Source orders/shipments are
  // not changed here.
  const detailLifecycle = resolveOrderLifecycleStatus({
    orderStatus: stringOrNull(order.orderStatus),
    canonicalStatus: stringOrNull(order.canonicalStatus),
    externallyShipped: order.externallyShipped === true,
    shippedLabelDisplayState,
  });

  return {
    ...order,
    orderStatus: detailLifecycle.effectiveOrderStatus,
    effectiveOrderStatus: detailLifecycle.effectiveOrderStatus,
    orderLifecycleStatus: detailLifecycle.orderLifecycleStatus,
    orderLifecycleLabel: detailLifecycle.orderLifecycleLabel,
    orderLifecycleReason: detailLifecycle.orderLifecycleReason,
    isTerminalOrderLifecycle: detailLifecycle.isTerminal,
    isShippingBlockedByLifecycle: detailLifecycle.isShippingBlocked,
    billingStatus: detailLifecycle.billingStatus,
    legacyClientId,
    client: canonicalOrder.client,
    canonicalOrder,
    overrides: safeOverrides,
    shippedLabelDisplayState,
    shipments: shipmentRows,
  };
}
