export const ORDER_RAW_PAYLOAD_POLICY_VERSION = 1;

const SHIPSTATION_RETAINED_KEYS = [
  // Operational address/package evidence not yet normalized into complete columns.
  'shipTo',
  'dimensions',
  'requestedShippingService',
  'serviceCode',
  'packageCode',
  'insuranceOptions',
  'internationalOptions',
  'confirmation',
  'customerUsername',
  'externallyFulfilled',

  // Historical/reconciliation evidence still read by backend workflows and repair tools.
  'orderId',
  'orderNumber',
  'orderStatus',
  'orderDate',
  'shipDate',
  'shippedAt',
  'fulfilledAt',
  'legacyOrderId',
  'customerOrderId',
  'purchaseOrderId',
  'storeId',

  // Provider/fixture provenance fallbacks used when normalized source columns are absent.
  'source',
  'sourceProvider',
  'source_provider',
  'provider',
  'marketplace',
  'platform',
  'accountId',
  'storeAccountId',
  'sourceAccountId',
  'marketplaceAccountId',
  'lineItems',
  'test',
  'testing',
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isShipStation(sourceProvider: unknown): boolean {
  return String(sourceProvider ?? '').trim().toLowerCase() === 'shipstation';
}

/**
 * Canonical persistence boundary for orders.raw.
 *
 * ShipStation is re-fetchable and its full response duplicates normalized order
 * columns, orders.items/order_items, and billing-address PII. Keep only the
 * bounded evidence that current backend workflows consume. Direct marketplace
 * payloads remain complete because their fulfillment/confirmation adapters need
 * provider-specific identity shapes that are not yet normalized.
 */
export function retainOrderRawForPersistence(input: {
  sourceProvider: unknown;
  raw: unknown;
}): Record<string, unknown> {
  // Per user override unlock shipped data on 2026-07-15: terminal orders may
  // retain this bounded evidence projection; status and shipment truth are not
  // inputs to, or outputs of, the payload-retention decision.
  const raw = record(input.raw);
  if (!isShipStation(input.sourceProvider)) return { ...raw };

  const retained: Record<string, unknown> = {
    rawPayloadPolicyVersion: ORDER_RAW_PAYLOAD_POLICY_VERSION,
  };
  for (const key of SHIPSTATION_RETAINED_KEYS) {
    if (raw[key] !== undefined) retained[key] = raw[key];
  }

  const advancedOptions = record(raw.advancedOptions);
  if (advancedOptions.storeId !== undefined && advancedOptions.storeId !== null) {
    retained.advancedOptions = { storeId: advancedOptions.storeId };
  }
  return retained;
}

/**
 * orders.raw is the one retained provider-payload copy. raw_source_payload used
 * to store the exact same JSONB value, doubling TOAST pressure without adding
 * provenance; source identity now lives in normalized source_* columns.
 */
export function retainOrderRawSourcePayloadForPersistence(
  _rawSourcePayload: unknown,
): null {
  return null;
}
