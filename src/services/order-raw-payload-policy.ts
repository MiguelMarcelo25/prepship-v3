/**
 * v2 (PS-491): retain the ShipStation fields that identify an order across a re-ingest
 * and distinguish a split/merge from a duplicate. See ORDER_IDENTITY_EVIDENCE_KEYS.
 */
export const ORDER_RAW_PAYLOAD_POLICY_VERSION = 2;

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

  // PS-491: ShipStation's own key for the order. `orderId` is NOT stable — ShipStation
  // reassigns it when an order is edited or re-created, which is exactly why order
  // de-duplication on (source_provider, source_account_id, source_order_id) fails and the
  // same order lands in `orders` twice. 367 of 369 duplicated order-number groups carry a
  // different source_order_id per copy, so the unique index can never fire.
  //
  // This field was being discarded, which is why the question "is orderKey stable across
  // the re-ingest?" could not be answered from stored data at all. Retaining it does not
  // change any behaviour; it starts the evidence that a corrected identity rule needs.
  'orderKey',

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

/**
 * PS-491: the `advancedOptions` members that say whether ShipStation split or merged this
 * order, and what it came from. `mergedOrSplit` is the flag, `parentId` names the order it
 * was derived from, and `mergedIds` lists what was combined. Together with `orderKey` they
 * are the evidence needed to tell a duplicate re-ingest from a legitimate split — the
 * distinction the invoice-side fix (billing-duplicate-order-policy.ts) currently has to
 * infer from whether two labels were bought.
 */
export const ORDER_IDENTITY_EVIDENCE_KEYS = ['mergedOrSplit', 'parentId', 'mergedIds'] as const;

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
  const retainedAdvanced: Record<string, unknown> = {};
  if (advancedOptions.storeId !== undefined && advancedOptions.storeId !== null) {
    retainedAdvanced.storeId = advancedOptions.storeId;
  }
  // PS-491: the split/merge discriminator. Two `orders` rows sharing an order number are
  // either one order ingested twice (a bug) or a genuine ShipStation split (two real
  // shipments, correctly billed twice). Nothing on the order row itself separates them —
  // 354 of 369 duplicate groups match on provider, account, store, order date AND ship-to
  // postal code. ShipStation knows the difference and says so in these three fields; the
  // policy was dropping all of them, leaving the distinction unanswerable downstream.
  //
  // Kept individually rather than by spreading advancedOptions, because that object also
  // carries unbounded operator text (customField1 is 4 KB in the guard fixture) and this
  // projection exists to stay small.
  for (const key of ORDER_IDENTITY_EVIDENCE_KEYS) {
    if (advancedOptions[key] !== undefined) retainedAdvanced[key] = advancedOptions[key];
  }
  if (Object.keys(retainedAdvanced).length > 0) retained.advancedOptions = retainedAdvanced;
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
