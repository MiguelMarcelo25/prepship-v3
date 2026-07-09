import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import {
  fetchShopifyDraftOrderAvailableDeliveryOptions,
  fetchShopifyOrderShippingContext,
  type ShopifyDraftOrderShippingRate,
} from '../connectors/store/shopify';
import {
  SHOPIFY_SHIPPING_PROVIDER,
  buildShopifyShippingLabelPurchaseInput,
  extractShopifyFulfillmentOrderId,
  normalizeShopifyFulfillmentOrderId,
  type ShopifyShippingLabelPurchaseInput,
} from './shopify-shipping-labels';
import { getAnalyticsCache, setAnalyticsCache } from './analytics-cache';
import { syntheticStoreIdForCredentialAccount } from './credential-accounts';

const SHOPIFY_RATE_QUOTE_TTL_SECONDS = 24 * 60 * 60;
const SHOPIFY_RATE_QUOTE_PREFIX = 'shopify_rate_quote';
const SHOPIFY_LABEL_PURCHASE_PENDING_TTL_SECONDS = 30 * 60;
const SHOPIFY_LABEL_PURCHASE_TERMINAL_TTL_SECONDS = 60;
const SHOPIFY_LABEL_PURCHASE_PENDING_PREFIX = 'shopify_label_purchase';
export const SHOPIFY_LABEL_RATES_UNAVAILABLE_MESSAGE =
  'Shopify does not expose carrier-priced Shopify Shipping label rates through the public Admin API before purchase. Use Shopify Admin to compare USPS/UPS/FedEx label prices, or use PrepShip carrier accounts for browsable carrier rates.';

type UnknownRecord = Record<string, unknown>;

type ShopifyStoreAccountForShipping = {
  id: number;
  label: string | null;
  credentials: Record<string, unknown>;
};

type ShopifyStoreAccountRow = {
  id?: unknown;
  provider?: unknown;
  label?: unknown;
  credentials?: unknown;
  active?: unknown;
  source?: unknown;
  clientId?: unknown;
  accountIdentifier?: unknown;
};

export type ShopifyCheckoutShippingLine = {
  title: string | null;
  amount: number | null;
  currency: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  raw: unknown;
};

export type ShopifyNormalizedRate = {
  id: string;
  selectedRateKey: string;
  handle: string | null;
  title: string;
  amount: number;
  currency: string;
  carrierCode: string;
  serviceCode: string;
  raw: unknown;
};

export type ShopifyRateQuoteSnapshot = {
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  orderId: number;
  fulfillmentOrderId: string;
  checkoutShipping: ShopifyCheckoutShippingLine[];
  checkoutDeliveryOptions: ShopifyNormalizedRate[];
  rates: ShopifyNormalizedRate[];
  labelRatesAvailable: boolean;
  labelRatesMessage: string | null;
  rateSource: 'shopify_label_rates' | 'checkout_delivery_options';
  fetchedAt: string;
};

export type ShopifyRatesForOrderResult = ShopifyRateQuoteSnapshot & {
  shopifyRateQuoteId: string;
};

export type ShopifyLabelPurchasePendingSnapshot = {
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  status: 'pending' | 'resolved' | 'failed';
  orderId: number;
  shopifyRateQuoteId?: string | null;
  selectedRateKey?: string | null;
  purchaseResultId: string;
  fulfillmentOrderId: string;
  selectedRate?: ShopifyNormalizedRate | null;
  weightOz: number;
  dims: {
    length: number;
    width: number;
    height: number;
  };
  packageName?: string | null;
  customPackageId?: number | null;
  providerAccountId: number;
  providerAccountNickname: string | null;
  createdAt: string;
  updatedAt: string;
  rawPurchaseResult?: unknown;
  message?: string | null;
};

export type ShopifyRatesForOrderInput = {
  orderId: number;
  weightOz?: number | null;
  dims?: {
    length?: number | null;
    width?: number | null;
    height?: number | null;
  } | null;
  packageName?: string | null;
  refresh?: boolean;
};

export type ShopifyPurchaseInputFromRate = {
  fulfillmentOrderId: string;
  rate?: ShopifyNormalizedRate;
  weightOz: number;
  dims: {
    length: number;
    width: number;
    height: number;
  };
  packageName?: string | null;
  shippingDatetime?: string | Date;
  notifyCustomer?: boolean;
};

export class ShopifyRatesError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(message: string, code = 'SHOPIFY_RATES_ERROR', status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ShopifyRatesError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function moneyNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[$,]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeProviderText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isShopifyShippingDisplayOnlyProvider(provider: unknown): boolean {
  return normalizeProviderText(provider) === 'shopify';
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function selectedRateKeyFor(rate: {
  handle?: unknown;
  carrierCode?: unknown;
  serviceCode?: unknown;
  amount?: unknown;
  currency?: unknown;
  title?: unknown;
}): string {
  const basis = [
    firstString(rate.handle),
    firstString(rate.carrierCode),
    firstString(rate.serviceCode),
    firstString(rate.title),
    String(Number(rate.amount ?? 0).toFixed(4)),
    firstString(rate.currency).toUpperCase(),
  ].join('|');
  return `shopify:${hashText(basis).slice(0, 24)}`;
}

export function normalizeShopifyDraftShippingRates(rawRates: unknown[]): ShopifyNormalizedRate[] {
  return asArray(rawRates)
    .map((raw): ShopifyNormalizedRate | null => {
      const rate = asRecord(raw);
      const price = asRecord(rate.price);
      const amount = moneyNumber(price.amount ?? rate.amount ?? rate.price);
      if (amount == null || amount <= 0) return null;
      const title = firstString(rate.title, rate.name, rate.serviceName, rate.code, rate.handle);
      const carrierCode = firstString(rate.source, rate.carrierCode, rate.carrier_code, SHOPIFY_SHIPPING_PROVIDER);
      const serviceCode = firstString(rate.code, rate.serviceCode, rate.service_code, rate.handle, title);
      if (!title || !carrierCode || !serviceCode) return null;
      const currency = firstString(price.currencyCode, price.currency, rate.currencyCode, rate.currency, 'USD').toUpperCase();
      const handle = firstString(rate.handle) || null;
      const selectedRateKey = selectedRateKeyFor({ handle, carrierCode, serviceCode, amount, currency, title });
      return {
        id: selectedRateKey,
        selectedRateKey,
        handle,
        title,
        amount,
        currency,
        carrierCode,
        serviceCode,
        raw,
      };
    })
    .filter((rate): rate is ShopifyNormalizedRate => Boolean(rate));
}

export function createShopifyRateQuoteSnapshot(input: {
  orderId: number;
  fulfillmentOrderId: string;
  rates: ShopifyNormalizedRate[];
  checkoutShipping: ShopifyCheckoutShippingLine[];
  checkoutDeliveryOptions?: ShopifyNormalizedRate[];
  labelRatesAvailable?: boolean;
  labelRatesMessage?: string | null;
  rateSource?: 'shopify_label_rates' | 'checkout_delivery_options';
  fetchedAt?: string;
}): ShopifyRateQuoteSnapshot {
  const rates = Array.isArray(input.rates) ? input.rates : [];
  const labelRatesAvailable = input.labelRatesAvailable ?? rates.length > 0;
  return {
    provider: SHOPIFY_SHIPPING_PROVIDER,
    orderId: input.orderId,
    fulfillmentOrderId: input.fulfillmentOrderId,
    checkoutShipping: Array.isArray(input.checkoutShipping) ? input.checkoutShipping : [],
    checkoutDeliveryOptions: Array.isArray(input.checkoutDeliveryOptions) ? input.checkoutDeliveryOptions : [],
    rates,
    labelRatesAvailable,
    labelRatesMessage: input.labelRatesMessage ?? (labelRatesAvailable ? null : SHOPIFY_LABEL_RATES_UNAVAILABLE_MESSAGE),
    rateSource: input.rateSource ?? (labelRatesAvailable ? 'shopify_label_rates' : 'checkout_delivery_options'),
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
}

function quoteIdFor(snapshot: ShopifyRateQuoteSnapshot): string {
  const basis = JSON.stringify({
    orderId: snapshot.orderId,
    fulfillmentOrderId: snapshot.fulfillmentOrderId,
    fetchedAt: snapshot.fetchedAt,
    rates: snapshot.rates.map((rate) => rate.selectedRateKey),
  });
  return `shq_${hashText(`shopify-rate:${basis}`).slice(0, 32)}`;
}

const quoteCacheKey = (shopifyRateQuoteId: string) => `${SHOPIFY_RATE_QUOTE_PREFIX}:${shopifyRateQuoteId}`;
const pendingSelectionCacheKey = (orderId: number, shopifyRateQuoteId: string, selectedRateKey: string) =>
  `${SHOPIFY_LABEL_PURCHASE_PENDING_PREFIX}:selection:${orderId}:${hashText(`${shopifyRateQuoteId}|${selectedRateKey}`).slice(0, 32)}`;
const pendingResultCacheKey = (purchaseResultId: string) =>
  `${SHOPIFY_LABEL_PURCHASE_PENDING_PREFIX}:result:${purchaseResultId}`;

export async function storeShopifyRateQuoteSnapshot(snapshot: ShopifyRateQuoteSnapshot): Promise<string> {
  const shopifyRateQuoteId = quoteIdFor(snapshot);
  await setAnalyticsCache(quoteCacheKey(shopifyRateQuoteId), snapshot, SHOPIFY_RATE_QUOTE_TTL_SECONDS);
  return shopifyRateQuoteId;
}

export async function loadShopifyRateQuoteSnapshot(
  shopifyRateQuoteId: string | null | undefined,
): Promise<ShopifyRateQuoteSnapshot | null> {
  const id = typeof shopifyRateQuoteId === 'string' ? shopifyRateQuoteId.trim() : '';
  if (!id) return null;
  return getAnalyticsCache<ShopifyRateQuoteSnapshot>(quoteCacheKey(id));
}

export async function storeShopifyLabelPurchasePendingSnapshot(
  snapshot: ShopifyLabelPurchasePendingSnapshot,
): Promise<void> {
  const ttl = snapshot.status === 'pending'
    ? SHOPIFY_LABEL_PURCHASE_PENDING_TTL_SECONDS
    : SHOPIFY_LABEL_PURCHASE_TERMINAL_TTL_SECONDS;
  const writes = [
    setAnalyticsCache(pendingResultCacheKey(snapshot.purchaseResultId), snapshot, ttl),
  ];
  if (snapshot.shopifyRateQuoteId && snapshot.selectedRateKey) {
    writes.push(setAnalyticsCache(
      pendingSelectionCacheKey(snapshot.orderId, snapshot.shopifyRateQuoteId, snapshot.selectedRateKey),
      snapshot,
      ttl,
    ));
  }
  await Promise.all(writes);
}

export async function loadShopifyLabelPurchasePendingBySelection(input: {
  orderId: number;
  shopifyRateQuoteId: string;
  selectedRateKey: string;
}): Promise<ShopifyLabelPurchasePendingSnapshot | null> {
  const snapshot = await getAnalyticsCache<ShopifyLabelPurchasePendingSnapshot>(
    pendingSelectionCacheKey(input.orderId, input.shopifyRateQuoteId, input.selectedRateKey),
  );
  return snapshot?.status === 'pending' ? snapshot : null;
}

export async function loadShopifyLabelPurchasePendingByResultId(
  purchaseResultId: string | null | undefined,
): Promise<ShopifyLabelPurchasePendingSnapshot | null> {
  const id = typeof purchaseResultId === 'string' ? purchaseResultId.trim() : '';
  if (!id) return null;
  const snapshot = await getAnalyticsCache<ShopifyLabelPurchasePendingSnapshot>(pendingResultCacheKey(id));
  return snapshot?.status === 'pending' ? snapshot : null;
}

export async function markShopifyLabelPurchaseTerminal(
  snapshot: ShopifyLabelPurchasePendingSnapshot,
  status: 'resolved' | 'failed',
  message?: string | null,
): Promise<void> {
  await storeShopifyLabelPurchasePendingSnapshot({
    ...snapshot,
    status,
    message: message ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export function assertShopifySelectedRate(
  snapshot: ShopifyRateQuoteSnapshot | null | undefined,
  selectedRateKey: string | null | undefined,
): ShopifyNormalizedRate {
  const key = typeof selectedRateKey === 'string' ? selectedRateKey.trim() : '';
  if (!key) throw new ShopifyRatesError('selectedRateKey is required for Shopify label purchase', 'SHOPIFY_SELECTED_RATE_REQUIRED', 400);
  const selected = snapshot?.rates?.find((rate) => rate.selectedRateKey === key) ?? null;
  if (!selected) {
    if (snapshot?.labelRatesAvailable === false) {
      throw new ShopifyRatesError(
        snapshot.labelRatesMessage ?? SHOPIFY_LABEL_RATES_UNAVAILABLE_MESSAGE,
        'SHOPIFY_LABEL_RATES_UNAVAILABLE',
        409,
      );
    }
    throw new ShopifyRatesError(
      'Selected Shopify rate is no longer available. Refresh Shopify Rates before buying the label.',
      'SHOPIFY_SELECTED_RATE_STALE',
      409,
    );
  }
  return selected;
}

export function buildShopifyShippingPurchaseInputFromRate(
  input: ShopifyPurchaseInputFromRate,
): ShopifyShippingLabelPurchaseInput {
  const shippingDatetime = input.shippingDatetime instanceof Date
    ? input.shippingDatetime
    : input.shippingDatetime ?? new Date().toISOString();
  return buildShopifyShippingLabelPurchaseInput({
    fulfillmentOrderId: input.fulfillmentOrderId,
    notifyCustomer: input.notifyCustomer ?? false,
    shippingDatetime,
    totalWeightOz: input.weightOz,
    packageInfo: {
      customPackage: {
        dimensions: {
          length: input.dims.length,
          width: input.dims.width,
          height: input.dims.height,
          unit: 'INCHES',
        },
        type: firstString(input.packageName, 'BOX'),
        weight: { unit: 'GRAMS', value: 0 },
      },
    },
  });
}

function normalizeVariantId(value: unknown): string | null {
  const raw = firstString(value);
  if (!raw) return null;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/i.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  return null;
}

function lineItemsFrom(rawOrder: UnknownRecord): Array<{ variantId: string; quantity: number }> {
  const rawLines = asArray(rawOrder.line_items ?? rawOrder.lineItems)
    .flatMap((item) => {
      const row = asRecord(item);
      if (row.node) return [row.node];
      return [item];
    });
  const graphEdges = asArray(asRecord(rawOrder.lineItems).edges).map((edge) => asRecord(asRecord(edge).node));
  const lines = [...rawLines, ...graphEdges];
  const parsed = lines
    .map((item): { variantId: string; quantity: number } | null => {
      const line = asRecord(item);
      const variant = asRecord(line.variant);
      const variantId = normalizeVariantId(
        line.variantId ??
        line.variant_id ??
        variant.admin_graphql_api_id ??
        variant.id,
      );
      const quantity = finitePositive(line.quantity) ?? 0;
      return variantId && quantity > 0 ? { variantId, quantity: Math.trunc(quantity) } : null;
    })
    .filter((line): line is { variantId: string; quantity: number } => Boolean(line));
  return parsed;
}

function shippingAddressFrom(rawOrder: UnknownRecord): Record<string, unknown> {
  const raw = asRecord(rawOrder.shipping_address ?? rawOrder.shippingAddress);
  const address = {
    address1: firstString(raw.address1, raw.address_1),
    address2: firstString(raw.address2, raw.address_2) || undefined,
    city: firstString(raw.city),
    company: firstString(raw.company) || undefined,
    countryCode: firstString(raw.countryCode, raw.country_code, raw.country) || 'US',
    firstName: firstString(raw.firstName, raw.first_name) || undefined,
    lastName: firstString(raw.lastName, raw.last_name) || undefined,
    phone: firstString(raw.phone) || undefined,
    provinceCode: firstString(raw.provinceCode, raw.province_code, raw.province),
    zip: firstString(raw.zip, raw.postalCode, raw.postal_code),
  };
  if (!address.city || !address.provinceCode || !address.zip || !address.countryCode) {
    throw new ShopifyRatesError(
      'Shopify Rates requires a complete Shopify shipping address. Resync the order or buy the label in Shopify.',
      'SHOPIFY_SHIPPING_ADDRESS_REQUIRED',
      400,
    );
  }
  return address;
}

function buildDraftOrderDeliveryOptionsInput(rawOrder: UnknownRecord): Record<string, unknown> {
  const lineItems = lineItemsFrom(rawOrder);
  if (!lineItems.length) {
    throw new ShopifyRatesError(
      'Shopify Rates requires Shopify variant ids on order line items. Resync the order or buy the label in Shopify.',
      'SHOPIFY_VARIANT_IDS_REQUIRED',
      400,
    );
  }
  return {
    lineItems,
    shippingAddress: shippingAddressFrom(rawOrder),
  };
}

export function extractShopifyCheckoutShipping(rawOrder: unknown): ShopifyCheckoutShippingLine[] {
  const raw = asRecord(rawOrder);
  const lines = asArray(raw.shipping_lines ?? raw.shippingLines);
  if (!lines.length) {
    const totalShipping = asRecord(raw.total_shipping_price_set ?? raw.totalShippingPriceSet);
    const shopMoney = asRecord(totalShipping.shop_money ?? totalShipping.shopMoney);
    const amount = moneyNumber(shopMoney.amount);
    return amount != null && amount > 0
      ? [{
          title: 'Shopify checkout shipping',
          amount,
          currency: firstString(shopMoney.currencyCode, shopMoney.currency, 'USD').toUpperCase(),
          carrierCode: null,
          serviceCode: null,
          raw: totalShipping,
        }]
      : [];
  }
  return lines.map((line) => {
    const row = asRecord(line);
    const priceSet = asRecord(row.price_set ?? row.priceSet);
    const shopMoney = asRecord(priceSet.shop_money ?? priceSet.shopMoney);
    return {
      title: firstString(row.title, row.code) || null,
      amount: moneyNumber(row.price ?? shopMoney.amount),
      currency: firstString(shopMoney.currencyCode, shopMoney.currency, row.currency, 'USD').toUpperCase(),
      carrierCode: firstString(row.carrier_identifier, row.carrierIdentifier, row.source) || null,
      serviceCode: firstString(row.code, row.title) || null,
      raw: line,
    };
  });
}

function fulfillmentOrderIds(rawOrder: UnknownRecord): string[] {
  const direct = extractShopifyFulfillmentOrderId(rawOrder);
  if (direct) return [direct];
  const ids: string[] = [];
  for (const item of fulfillmentOrderCandidates(rawOrder)) {
    const row = asRecord(item);
    const status = normalizeProviderText(row.status);
    const requestStatus = normalizeProviderText(row.request_status ?? row.requestStatus);
    if (['closed', 'cancelled', 'canceled', 'incomplete'].includes(status)) continue;
    if (['cancellation_requested', 'cancellation_accepted'].includes(requestStatus)) continue;
    const id = normalizeShopifyFulfillmentOrderId(row.admin_graphql_api_id ?? row.id ?? row.legacyResourceId);
    if (id) ids.push(id);
  }
  return Array.from(new Set(ids));
}

function fulfillmentOrderCandidates(rawOrder: UnknownRecord): unknown[] {
  const candidates: unknown[] = [];
  for (const value of [rawOrder.fulfillment_orders, rawOrder.fulfillmentOrders]) {
    if (Array.isArray(value)) {
      candidates.push(...value);
      continue;
    }
    const record = asRecord(value);
    if (Array.isArray(record.nodes)) candidates.push(...record.nodes);
    if (Array.isArray(record.edges)) {
      candidates.push(...record.edges.map((edge) => asRecord(edge).node ?? edge));
    }
  }
  return candidates;
}

function finitePositiveInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

export function shopifyStoreAccountIdCandidatesForOrder(order: {
  sourceAccountId?: string | null;
  storeId?: number | null;
}): number[] {
  const ids = new Set<number>();
  const rawSourceAccountId = firstString(order.sourceAccountId);
  const direct = finitePositiveInteger(rawSourceAccountId);
  if (direct != null) ids.add(direct);

  const prefixed = /^(?:store-account|shopify-account|shopify)[:_-](\d+)$/i.exec(rawSourceAccountId);
  const prefixedId = finitePositiveInteger(prefixed?.[1]);
  if (prefixedId != null) ids.add(prefixedId);

  const shopifyOffset = syntheticStoreIdForCredentialAccount('shopify', 0);
  const syntheticStoreId = finitePositiveInteger(order.storeId);
  if (syntheticStoreId != null && syntheticStoreId > shopifyOffset) {
    ids.add(syntheticStoreId - shopifyOffset);
  }

  return Array.from(ids);
}

function shopifyStoreAccountFromRow(row: UnknownRecord): ShopifyStoreAccountForShipping | null {
  const id = finitePositiveInteger(row.id);
  if (!id || normalizeProviderText(row.provider) !== 'shopify' || row.active === false) return null;
  return {
    id,
    label: firstString(row.label) || null,
    credentials: asRecord(row.credentials),
  };
}

async function queryShopifyStoreAccountRowsByIds(accountIds: number[]): Promise<UnknownRecord[]> {
  const unique = Array.from(new Set(accountIds.filter((id) => Number.isFinite(id) && id > 0)));
  if (!unique.length) return [];
  const rows = await db.execute(sql<ShopifyStoreAccountRow>`
    SELECT
      id,
      provider,
      label,
      credentials,
      active,
      source,
      client_id AS "clientId",
      account_identifier AS "accountIdentifier"
    FROM store_accounts
    WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
  `);
  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return list.map(asRecord);
}

async function queryActiveShopifyStoreAccountRows(excludedIds: number[]): Promise<UnknownRecord[]> {
  const excluded = Array.from(new Set(excludedIds.filter((id) => Number.isFinite(id) && id > 0)));
  const excludePredicate = excluded.length
    ? sql`AND id NOT IN (${sql.join(excluded.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const rows = await db.execute(sql<ShopifyStoreAccountRow>`
    SELECT
      id,
      provider,
      label,
      credentials,
      active,
      source,
      client_id AS "clientId",
      account_identifier AS "accountIdentifier"
    FROM store_accounts
    WHERE provider = 'shopify'
      AND active = true
      ${excludePredicate}
    ORDER BY
      CASE WHEN source = 'admin' THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST,
      id DESC
    LIMIT 20
  `);
  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return list.map(asRecord);
}

function normalizeShopifyOrderNumber(value: unknown): string {
  return firstString(value).trim().toLowerCase();
}

export function shopifyOrderContextMatchesOrderIdentity(
  liveOrder: unknown,
  order: {
    sourceOrderId?: string | null;
    sourceOrderNumber?: string | null;
  },
): boolean {
  const live = asRecord(liveOrder);
  const expectedNumber = normalizeShopifyOrderNumber(order.sourceOrderNumber);
  if (!expectedNumber) return true;
  const actualNumber = normalizeShopifyOrderNumber(live.name ?? live.order_number ?? live.orderNumber);
  return !actualNumber || actualNumber === expectedNumber;
}

async function fallbackShopifyStoreAccountByLiveOrderProbe(
  order: {
    sourceOrderId?: string | null;
    sourceOrderNumber?: string | null;
  },
  excludedIds: number[],
): Promise<ShopifyStoreAccountForShipping | null> {
  const sourceOrderId = firstString(order.sourceOrderId).replace(/^shopify-/i, '');
  if (!sourceOrderId) return null;

  const matches: ShopifyStoreAccountForShipping[] = [];
  for (const row of await queryActiveShopifyStoreAccountRows(excludedIds)) {
    const account = shopifyStoreAccountFromRow(row);
    if (!account) continue;
    try {
      const liveOrder = await fetchShopifyOrderShippingContext(account.credentials, sourceOrderId);
      if (shopifyOrderContextMatchesOrderIdentity(liveOrder, order)) {
        matches.push(account);
      }
    } catch {
      // Stale reconnect recovery: a candidate account that cannot read this
      // Shopify order is not the owner. Keep probing active Shopify accounts.
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ShopifyRatesError(
      'Multiple active Shopify store accounts can read this order. Select the correct Shopify store account and resync the order before browsing Shopify Rates.',
      'SHOPIFY_ACCOUNT_AMBIGUOUS',
      409,
      { accountIds: matches.map((match) => match.id) },
    );
  }
  return null;
}

export async function loadShopifyStoreAccountForOrder(order: {
  sourceAccountId: string | null;
  storeId: number | null;
  sourceOrderId?: string | null;
  sourceOrderNumber?: string | null;
}): Promise<ShopifyStoreAccountForShipping> {
  const accountIds = shopifyStoreAccountIdCandidatesForOrder(order);
  for (const row of await queryShopifyStoreAccountRowsByIds(accountIds)) {
    const account = shopifyStoreAccountFromRow(row);
    if (account) return account;
  }

  const fallback = await fallbackShopifyStoreAccountByLiveOrderProbe(order, accountIds);
  if (fallback) return fallback;

  if (!accountIds.length) {
    throw new ShopifyRatesError(
      'Shopify store account could not be resolved for this order. Resync the order before browsing Shopify Rates.',
      'SHOPIFY_ACCOUNT_REQUIRED',
      400,
    );
  }
  throw new ShopifyRatesError(
    'Active Shopify store account not found for this order. Reconnect the Shopify store, then pull or resync Shopify orders so PrepShip can refresh this order source.',
    'SHOPIFY_ACCOUNT_NOT_FOUND',
    404,
    { accountIds },
  );
}

function mergeOrderRaw(base: unknown, live: unknown): UnknownRecord {
  const baseRecord = asRecord(base);
  const liveRecord = asRecord(live);
  return {
    ...baseRecord,
    ...liveRecord,
    shipping_lines: liveRecord.shipping_lines ?? baseRecord.shipping_lines,
    shippingLines: liveRecord.shippingLines ?? baseRecord.shippingLines,
    line_items: liveRecord.line_items ?? baseRecord.line_items,
    lineItems: liveRecord.lineItems ?? baseRecord.lineItems,
    fulfillment_orders: liveRecord.fulfillment_orders ?? baseRecord.fulfillment_orders,
    fulfillmentOrders: liveRecord.fulfillmentOrders ?? baseRecord.fulfillmentOrders,
  };
}

export async function getShopifyRatesForOrder(
  input: ShopifyRatesForOrderInput,
): Promise<ShopifyRatesForOrderResult> {
  const [order] = await db
    .select({
      id: orders.id,
      orderStatus: orders.orderStatus,
      sourceProvider: orders.sourceProvider,
      sourceAccountId: orders.sourceAccountId,
      sourceOrderId: orders.sourceOrderId,
      sourceOrderNumber: orders.sourceOrderNumber,
      externalOrderId: orders.externalOrderId,
      storeId: orders.storeId,
      raw: orders.raw,
      rawSourcePayload: orders.rawSourcePayload,
      shippingAmount: orders.shippingAmount,
      weightOz: orders.weightOz,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order) throw new ShopifyRatesError('Order not found', 'ORDER_NOT_FOUND', 404);
  if (normalizeProviderText(order.sourceProvider) !== 'shopify') {
    throw new ShopifyRatesError('Shopify Rates are only available for Shopify-sourced orders.', 'SHOPIFY_ORDER_REQUIRED', 400);
  }
  if (order.orderStatus === 'shipped' || order.orderStatus === 'cancelled') {
    throw new ShopifyRatesError(`Cannot browse Shopify Rates for ${order.orderStatus} order`, 'ORDER_NOT_EDITABLE', 400, {
      orderStatus: order.orderStatus,
    });
  }

  const weightOz = finitePositive(input.weightOz) ?? finitePositive(order.weightOz);
  const length = finitePositive(input.dims?.length);
  const width = finitePositive(input.dims?.width);
  const height = finitePositive(input.dims?.height);
  if (!weightOz) throw new ShopifyRatesError('Shopify Rates requires packed weight.', 'SHOPIFY_WEIGHT_REQUIRED', 400);
  if (!length || !width || !height) {
    throw new ShopifyRatesError('Shopify Rates requires package dimensions.', 'SHOPIFY_DIMS_REQUIRED', 400);
  }

  const account = await loadShopifyStoreAccountForOrder({
    sourceAccountId: order.sourceAccountId,
    storeId: order.storeId,
    sourceOrderId: order.sourceOrderId ?? order.externalOrderId,
    sourceOrderNumber: order.sourceOrderNumber,
  });
  const sourceOrderId = firstString(order.sourceOrderId, order.externalOrderId?.replace(/^shopify-/i, ''));
  const liveRaw = await fetchShopifyOrderShippingContext(account.credentials, sourceOrderId);
  const rawOrder = mergeOrderRaw(order.rawSourcePayload ?? order.raw, liveRaw);
  const ids = fulfillmentOrderIds(rawOrder);
  if (ids.length === 0) {
    throw new ShopifyRatesError(
      'No open Shopify fulfillment order found. Refresh Shopify order sync or buy the label in Shopify.',
      'SHOPIFY_FULFILLMENT_ORDER_REQUIRED',
      400,
    );
  }
  if (ids.length > 1) {
    throw new ShopifyRatesError(
      'Shopify Rates currently supports one fulfillment order per PrepShip shipment.',
      'SHOPIFY_MULTIPLE_FULFILLMENT_ORDERS_UNSUPPORTED',
      400,
      { fulfillmentOrderIds: ids },
    );
  }

  const draftInput = buildDraftOrderDeliveryOptionsInput(rawOrder);
  const rawRates = await fetchShopifyDraftOrderAvailableDeliveryOptions(account.credentials, draftInput);
  const checkoutDeliveryOptions = normalizeShopifyDraftShippingRates(rawRates);
  const snapshot = createShopifyRateQuoteSnapshot({
    orderId: order.id,
    fulfillmentOrderId: ids[0]!,
    checkoutShipping: extractShopifyCheckoutShipping(rawOrder),
    checkoutDeliveryOptions,
    // Shopify's public Admin API exposes draft-order checkout delivery options here,
    // not the carrier-priced Shopify Admin label quote list shown before purchase.
    rates: [],
    labelRatesAvailable: false,
    labelRatesMessage: SHOPIFY_LABEL_RATES_UNAVAILABLE_MESSAGE,
    rateSource: 'checkout_delivery_options',
  });
  const shopifyRateQuoteId = await storeShopifyRateQuoteSnapshot(snapshot);
  return {
    ...snapshot,
    shopifyRateQuoteId,
    rates: snapshot.rates.map((rate) => ({ ...rate, shopifyRateQuoteId })),
  } as ShopifyRatesForOrderResult;
}
