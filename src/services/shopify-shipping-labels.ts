export const SHOPIFY_SHIPPING_PROVIDER = 'shopify_shipping' as const;

const SHOPIFY_SHIPPING_LABELS_FLAG = 'SHOPIFY_SHIPPING_LABELS_ENABLED';
const GRAMS_PER_OUNCE = 28.349523125;

export const SHOPIFY_SHIPPING_REQUIRED_SCOPES = [
  'read_orders',
  'read_draft_orders',
  'write_orders',
  'read_merchant_managed_fulfillment_orders',
] as const;

export type ShopifyShippingEnv = Record<string, string | undefined>;

export type ShopifyShippingEligibilityInput = {
  sourceProvider?: unknown;
  rawOrderPayload?: unknown;
  grantedScopes?: unknown;
  env?: ShopifyShippingEnv;
};

export type ShopifyShippingEligibilityResult = {
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  eligible: boolean;
  canPurchase: boolean;
  purchaseEnabled: boolean;
  fulfillmentOrderId: string | null;
  fulfillmentOrderBlocker?: string | null;
  missing: string[];
  blockers: string[];
};

export type ShopifyFulfillmentOrderForPurchase = {
  id: string;
  status: string | null;
  requestStatus: string | null;
  assignedLocation: unknown | null;
  remainingLineItems: unknown[];
  raw: UnknownRecord;
};

export type ShopifyMailingAddressInput = {
  address1?: string;
  address2?: string;
  city?: string;
  company?: string;
  countryCode?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  provinceCode?: string;
  zip?: string;
};

export type ShopifyWeightInput = {
  unit: 'GRAMS' | 'KILOGRAMS' | 'OUNCES' | 'POUNDS';
  value: number;
};

export type ShopifyObjectDimensionsInput = {
  length: number;
  width: number;
  height: number;
  unit: 'INCHES' | 'CENTIMETERS' | 'MILLIMETERS' | 'METERS' | 'FEET' | 'YARDS';
};

export type ShopifyShippingLabelPurchaseCustomPackageInput = {
  dimensions: ShopifyObjectDimensionsInput;
  type?: string;
  weight: ShopifyWeightInput;
};

export type ShopifyPackageInfoInput = {
  carrierPackage?: Record<string, unknown>;
  customPackage?: ShopifyShippingLabelPurchaseCustomPackageInput;
};

export type ShopifyPreferredRateSelectionInput = {
  carrierCode: string;
  serviceCode: string;
};

export type ShopifyShippingLabelPurchaseInput = {
  fulfillmentOrderId: string;
  notifyCustomer?: boolean;
  originAddress?: ShopifyMailingAddressInput;
  packageInfo: ShopifyPackageInfoInput;
  preferredRateSelection?: ShopifyPreferredRateSelectionInput;
  shippingDatetime: string;
  totalWeight?: ShopifyWeightInput;
};

export type BuildShopifyShippingLabelPurchaseInput = {
  fulfillmentOrderId: unknown;
  notifyCustomer?: boolean;
  originAddress?: ShopifyMailingAddressInput;
  packageInfo: ShopifyPackageInfoInput;
  preferredRateSelection?: ShopifyPreferredRateSelectionInput;
  shippingDatetime: string | Date;
  totalWeight?: ShopifyWeightInput;
  totalWeightOz?: number | null;
};

export type ShopifyShippingMockLabelInput = {
  fulfillmentOrderId: unknown;
  orderId?: unknown;
  orderName?: unknown;
  shopDomain?: unknown;
  serviceCode?: unknown;
  carrierCode?: unknown;
  createdAt?: string | Date;
};

export type ShopifyShippingMockLabelResult = {
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  mock: true;
  fulfillmentOrderId: string;
  orderId?: string;
  orderName?: string;
  shopDomain?: string;
  carrierCode: string;
  serviceCode: string;
  trackingNumber: string;
  labelUrl: string;
  shipmentId: string;
  currency: 'USD';
  cost: 0;
  postagePurchased: false;
  printable: false;
  createdAt: string;
  message: string;
};

type UnknownRecord = Record<string, unknown>;

export function isShopifyShippingPurchaseEnabled(env: ShopifyShippingEnv = process.env): boolean {
  return String(env[SHOPIFY_SHIPPING_LABELS_FLAG] ?? '').trim().toLowerCase() === 'true';
}

export function evaluateShopifyShippingEligibility(input: ShopifyShippingEligibilityInput): ShopifyShippingEligibilityResult {
  const raw = asRecord(input.rawOrderPayload);
  const source = firstLowerString(input.sourceProvider, raw?.sourceProvider, raw?.source, raw?.provider, raw?.marketplace);
  const fulfillmentOrder = raw ? extractShopifyFulfillmentOrderForPurchase(raw) : null;
  const fulfillmentOrderId = fulfillmentOrder?.id ?? null;
  const fulfillmentOrderBlocker = raw && !fulfillmentOrder ? firstFulfillmentOrderBlocker(raw) : null;
  const scopes = normalizeScopeSet(input.grantedScopes);
  const missing: string[] = [];

  if (source !== 'shopify') missing.push('source:shopify');
  for (const scope of SHOPIFY_SHIPPING_REQUIRED_SCOPES) {
    if (!scopes.has(scope)) missing.push(`scope:${scope}`);
  }
  if (!fulfillmentOrderId) missing.push('fulfillmentOrderId');

  const eligible = missing.length === 0;
  const purchaseEnabled = isShopifyShippingPurchaseEnabled(input.env);
  const blockers = eligible && !purchaseEnabled ? [`${SHOPIFY_SHIPPING_LABELS_FLAG} disabled`] : [];

  return {
    provider: SHOPIFY_SHIPPING_PROVIDER,
    eligible,
    canPurchase: eligible && purchaseEnabled,
    purchaseEnabled,
    fulfillmentOrderId,
    fulfillmentOrderBlocker,
    missing,
    blockers: fulfillmentOrderBlocker ? [...blockers, fulfillmentOrderBlocker] : blockers,
  };
}

export function normalizeShopifyFulfillmentOrderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return `gid://shopify/FulfillmentOrder/${value}`;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/FulfillmentOrder/${trimmed}`;
  if (/^gid:\/\/shopify\/FulfillmentOrder\/\d+$/i.test(trimmed)) return trimmed;
  return null;
}

export function buildShopifyShippingLabelPurchaseInput(
  input: BuildShopifyShippingLabelPurchaseInput,
): ShopifyShippingLabelPurchaseInput {
  const fulfillmentOrderId = normalizeShopifyFulfillmentOrderId(input.fulfillmentOrderId);
  if (!fulfillmentOrderId) throw new Error('Shopify Shipping label purchase requires a fulfillment order id');

  const totalWeight = input.totalWeight ?? weightFromOunces(input.totalWeightOz);
  const shippingDatetime = input.shippingDatetime instanceof Date ? input.shippingDatetime.toISOString() : input.shippingDatetime;

  const purchaseInput: ShopifyShippingLabelPurchaseInput = {
    fulfillmentOrderId,
    packageInfo: input.packageInfo,
    shippingDatetime,
  };
  if (input.notifyCustomer != null) purchaseInput.notifyCustomer = input.notifyCustomer;
  if (input.originAddress) purchaseInput.originAddress = input.originAddress;
  if (input.preferredRateSelection) purchaseInput.preferredRateSelection = input.preferredRateSelection;
  if (totalWeight) purchaseInput.totalWeight = totalWeight;
  return purchaseInput;
}

export function createShopifyShippingMockLabel(
  input: ShopifyShippingMockLabelInput,
): ShopifyShippingMockLabelResult {
  const fulfillmentOrderId = normalizeShopifyFulfillmentOrderId(input.fulfillmentOrderId);
  if (!fulfillmentOrderId) throw new Error('Shopify Shipping mock label requires a fulfillment order id');

  const fulfillmentSegment = fulfillmentOrderId.match(/\/(\d+)$/)?.[1] ?? trackingSafeSegment(fulfillmentOrderId);
  const orderName = optionalString(input.orderName);
  const orderId = optionalString(input.orderId);
  const shopDomain = optionalString(input.shopDomain);
  const orderSegment = trackingSafeSegment(orderName || orderId || fulfillmentSegment);
  const carrierCode = optionalString(input.carrierCode) || SHOPIFY_SHIPPING_PROVIDER;
  const serviceCode = optionalString(input.serviceCode) || 'shopify_mock_ground';
  const createdAt = input.createdAt instanceof Date
    ? input.createdAt.toISOString()
    : optionalString(input.createdAt) || new Date().toISOString();

  return {
    provider: SHOPIFY_SHIPPING_PROVIDER,
    mock: true,
    fulfillmentOrderId,
    orderId,
    orderName,
    shopDomain,
    carrierCode,
    serviceCode,
    trackingNumber: `SHOPIFY-MOCK-${orderSegment}-${fulfillmentSegment}`,
    labelUrl: `mock://shopify-shipping/${encodeURIComponent(fulfillmentSegment)}`,
    shipmentId: `mock-shopify-shipping-${fulfillmentSegment}`,
    currency: 'USD',
    cost: 0,
    postagePurchased: false,
    printable: false,
    createdAt,
    message: 'Shopify Shipping mock label path ready; no postage was purchased and no printable label was created.',
  };
}

export function extractShopifyFulfillmentOrderId(rawPayload: unknown): string | null {
  return extractShopifyFulfillmentOrderForPurchase(rawPayload)?.id ?? null;
}

export function extractShopifyFulfillmentOrderForPurchase(rawPayload: unknown): ShopifyFulfillmentOrderForPurchase | null {
  const raw = asRecord(rawPayload);
  if (!raw) return null;
  const direct = firstNormalizedFulfillmentOrderId(
    raw.fulfillmentOrderId,
    raw.fulfillment_order_id,
    raw.fulfillmentOrderGid,
    raw.fulfillment_order_gid,
    nestedId(raw.fulfillmentOrder),
    nestedId(raw.fulfillment_order),
  );
  if (direct) {
    return {
      id: direct,
      status: null,
      requestStatus: null,
      assignedLocation: null,
      remainingLineItems: [],
      raw,
    };
  }

  for (const order of fulfillmentOrderCandidates(raw)) {
    const blocker = fulfillmentOrderPurchaseBlocker(order);
    if (blocker) continue;
    const id = firstNormalizedFulfillmentOrderId(order.admin_graphql_api_id, order.adminGraphqlApiId, order.id, order.legacyResourceId);
    if (!id) continue;
    return {
      id,
      status: firstLowerString(order.status),
      requestStatus: firstLowerString(order.request_status, order.requestStatus),
      assignedLocation: order.assigned_location ?? order.assignedLocation ?? null,
      remainingLineItems: remainingLineItemsFrom(order),
      raw: order,
    };
  }

  return null;
}

export function fulfillmentOrderPurchaseBlocker(orderPayload: unknown): string | null {
  const order = asRecord(orderPayload);
  if (!order) return 'Shopify fulfillment order is missing.';
  const status = firstLowerString(order.status);
  const requestStatus = firstLowerString(order.request_status, order.requestStatus);
  if (status && ['closed', 'cancelled', 'canceled', 'incomplete'].includes(status)) {
    return `Shopify fulfillment order is ${status}.`;
  }
  if (requestStatus && ['cancellation_requested', 'cancellation_accepted', 'rejected', 'cancellation_rejected'].includes(requestStatus)) {
    return `Shopify fulfillment order request status is ${requestStatus}.`;
  }
  const supportedActions = asArray(order.supported_actions ?? order.supportedActions)
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter(Boolean);
  if (supportedActions.length && !supportedActions.some((action) => action.includes('CREATE_SHIPPING_LABEL') || action.includes('PURCHASE_LABEL'))) {
    return 'Shopify fulfillment order does not support shipping-label purchase.';
  }
  const remainingLineItems = remainingLineItemsFrom(order);
  if (hasKnownRemainingLineItems(order) && !remainingLineItems.some(hasRemainingQuantity)) {
    return 'Shopify fulfillment order has no remaining shippable line items.';
  }
  return null;
}

function firstFulfillmentOrderBlocker(raw: UnknownRecord): string | null {
  for (const order of fulfillmentOrderCandidates(raw)) {
    const blocker = fulfillmentOrderPurchaseBlocker(order);
    if (blocker) return blocker;
  }
  return null;
}

function fulfillmentOrderCandidates(raw: UnknownRecord): UnknownRecord[] {
  const candidates: UnknownRecord[] = [];
  for (const key of ['fulfillment_orders', 'fulfillmentOrders']) {
    for (const item of connectionNodes(raw[key])) {
      const row = asRecord(item);
      if (row) candidates.push(row);
    }
  }
  for (const key of ['fulfillmentOrder', 'fulfillment_order']) {
    const row = asRecord(raw[key]);
    if (row) candidates.push(row);
  }
  return candidates;
}

function connectionNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  if (Array.isArray(record.nodes)) return record.nodes;
  if (Array.isArray(record.edges)) {
    return record.edges.map((edge) => asRecord(edge)?.node ?? edge);
  }
  return [];
}

function remainingLineItemsFrom(order: UnknownRecord): unknown[] {
  const direct = asArray(order.remaining_line_items ?? order.remainingLineItems);
  if (direct.length && !asRecord(order.remainingLineItems)?.edges) return direct;
  const connection = connectionNodes(order.remainingLineItems);
  return connection.length ? connection : direct;
}

function hasKnownRemainingLineItems(order: UnknownRecord): boolean {
  if (Array.isArray(order.remaining_line_items)) return true;
  const remaining = asRecord(order.remainingLineItems);
  return Array.isArray(order.remainingLineItems) || Array.isArray(remaining?.edges) || Array.isArray(remaining?.nodes);
}

function hasRemainingQuantity(value: unknown): boolean {
  const row = asRecord(value);
  const quantity = Number(row?.remaining_quantity ?? row?.remainingQuantity ?? row?.quantity ?? 0);
  return Number.isFinite(quantity) && quantity > 0;
}

function firstNormalizedFulfillmentOrderId(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeShopifyFulfillmentOrderId(value);
    if (normalized) return normalized;
  }
  return null;
}

function nestedId(value: unknown): unknown {
  return asRecord(value)?.id;
}

function normalizeScopeSet(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.flatMap((item) => scopeTokens(item)));
  }
  return new Set(scopeTokens(value));
}

function scopeTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function weightFromOunces(value: number | null | undefined): ShopifyWeightInput | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return { unit: 'GRAMS', value: roundMoney(value * GRAMS_PER_OUNCE) };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function trackingSafeSegment(value: unknown): string {
  const raw = optionalString(value) ?? 'UNKNOWN';
  const normalized = raw.replace(/^#/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'UNKNOWN';
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstLowerString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed.toLowerCase();
  }
  return null;
}
