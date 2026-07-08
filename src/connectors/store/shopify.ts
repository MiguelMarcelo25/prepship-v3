import type {
  ConfirmationResult,
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  ShipmentConfirmationInput,
  StoreOrderImportInput,
  StoreConnector,
} from '../../domain/fulfillment/types.js';
import { timedFetch, type TimingFields } from '../../lib/http/timing.js';
import {
  SHOPIFY_SHIPPING_PROVIDER,
  SHOPIFY_SHIPPING_REQUIRED_SCOPES,
  buildShopifyShippingLabelPurchaseInput,
  createShopifyShippingMockLabel,
  evaluateShopifyShippingEligibility,
  isShopifyShippingPurchaseEnabled,
  type BuildShopifyShippingLabelPurchaseInput,
  type ShopifyShippingEligibilityResult,
  type ShopifyShippingEnv,
  type ShopifyShippingMockLabelResult,
} from '../../services/shopify-shipping-labels.js';

export const SHOPIFY_ADMIN_API_VERSION = '2026-07';
const DEFAULT_API_VERSION = SHOPIFY_ADMIN_API_VERSION;
const SHOPIFY_SHIPPING_LABEL_PURCHASE_MUTATION = `
mutation shippingLabelPurchase($shippingLabelPurchase: ShippingLabelPurchaseInput!) {
  shippingLabelPurchase(shippingLabelPurchase: $shippingLabelPurchase) {
    shippingLabelPurchaseResult {
      id
      done
      status
      errors {
        code
        field
        message
      }
      shippingLabels {
        id
        printed
        cancellable
        trackingInfo {
          number
          company
          url
        }
        shippingDocuments {
          documentType
          format
          shippingLabelId
          url
        }
      }
    }
    userErrors {
      code
      field
      message
    }
  }
}
`;

type ShopifyCredentials = {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  authMode: 'access_token' | 'client_credentials';
};

type ShopifyConnectorOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  apiVersion?: string;
};

type ShopifyValidationCredentials = {
  shopDomain?: string | null;
  adminAccessToken?: string | null;
  accessToken?: string | null;
};

type ShopifyOrderContext = {
  accountId: string;
  clientId?: number | null;
  storeId?: number | null;
};

export type ShopifyValidationResult =
  | { ok: true; shopName: string; myshopifyDomain: string }
  | { ok: false; error: string };

const SHOPIFY_SHOP_QUERY = `
  query PrepShipShopValidation {
    shop {
      name
      myshopifyDomain
    }
  }
`;

const SHOPIFY_ORDERS_QUERY = `
  query PrepShipOrders($first: Int!, $after: String, $query: String!) {
    shop {
      name
      myshopifyDomain
    }
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          updatedAt
          cancelledAt
          displayFulfillmentStatus
          email
          totalWeight
          customer {
            displayName
            email
          }
          shippingAddress {
            name
            city
            provinceCode
            province
            zip
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            edges {
              node {
                id
                sku
                title
                quantity
                variant {
                  id
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export type ShopifyShippingReadinessInput = {
  orderId?: unknown;
  env?: ShopifyShippingEnv;
};

export type ShopifyShippingPurchaseInput = {
  env?: ShopifyShippingEnv;
  orderId?: unknown;
  orderName?: unknown;
  purchaseInput: BuildShopifyShippingLabelPurchaseInput;
};

export type ShopifyShippingPurchasedLabelResult = {
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  mock: false;
  fulfillmentOrderId: string;
  orderId?: string;
  orderName?: string;
  purchaseResultId: string;
  done: boolean;
  status: string;
  labelId: string;
  trackingNumber: string;
  trackingUrl?: string;
  labelUrl: string;
  labelFormat: string;
  carrierCode: string;
  serviceCode: string;
  cost: null;
  currency: null;
  postagePurchased: true;
  printable: true;
  raw: unknown;
};

export type ShopifyShippingReadinessResult = {
  ok: boolean;
  provider: typeof SHOPIFY_SHIPPING_PROVIDER;
  shopDomain?: string;
  shopName?: string;
  authMode?: ShopifyCredentials['authMode'];
  scopes: string[];
  requiredScopes: readonly string[];
  missingScopes: string[];
  requiredPermission: 'buy_shipping_labels';
  orderId?: string;
  orderName?: string;
  fulfillmentOrderId: string | null;
  eligibility: ShopifyShippingEligibilityResult;
  mockLabel?: ShopifyShippingMockLabelResult;
  message: string;
  error?: string;
  retryable?: boolean;
};

export class ShopifyShippingPurchaseDisabledError extends Error {
  code = 'SHOPIFY_SHIPPING_DISABLED';

  constructor() {
    super('SHOPIFY_SHIPPING_LABELS_ENABLED disabled; Shopify Shipping live label purchase is not enabled.');
    this.name = 'ShopifyShippingPurchaseDisabledError';
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function moneyNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[$,]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyString(value: unknown): string | null {
  const parsed = moneyNumber(value);
  return parsed == null ? null : Math.max(0, parsed).toFixed(2);
}

function normalizeApiVersion(value: unknown): string {
  const raw = firstString(value);
  return /^\d{4}-\d{2}$/.test(raw) ? raw : DEFAULT_API_VERSION;
}

export function normalizeShopifyShopDomain(value: unknown): string {
  let raw = firstString(value).toLowerCase();
  if (!raw) throw new Error('Shopify shop domain is required');

  try {
    const parsed = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : new URL(`https://${raw}`);
    if (parsed.hostname === 'admin.shopify.com') {
      const [, storeSlug] = parsed.pathname.match(/\/store\/([^/?#]+)/) ?? [];
      if (storeSlug) return `${storeSlug}.myshopify.com`;
    }
    raw = parsed.hostname;
  } catch {
    raw = raw.replace(/^https?:\/\//, '').split('/')[0] ?? raw;
  }

  raw = raw.replace(/^www\./, '').replace(/^admin\./, '').replace(/\.+$/, '').replace(/\/+$/, '');
  if (/^[a-z0-9][a-z0-9-]*$/.test(raw)) return `${raw}.myshopify.com`;
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw)) return raw;
  throw new Error('Shopify shop domain must be a .myshopify.com domain');
}

function tokenExpiresAtMs(value: unknown): number | null {
  const raw = firstString(value);
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function accessTokenIsFresh(creds: Record<string, unknown>): boolean {
  const expiresAt = tokenExpiresAtMs(creds.accessTokenExpiresAt ?? creds.access_token_expires_at);
  return expiresAt == null || expiresAt > Date.now() + 60_000;
}

function baseShopifyCredentials(creds: Record<string, unknown>): Omit<ShopifyCredentials, 'accessToken' | 'authMode'> {
  const shopDomain = normalizeShopifyShopDomain(
    creds.shopDomain ?? creds.shop_domain ?? creds.storeDomain ?? creds.store_domain,
  );
  if (!shopDomain) throw new Error('Shopify credentials missing shopDomain');
  return {
    shopDomain,
    apiVersion: normalizeApiVersion(creds.apiVersion ?? creds.api_version),
  };
}

async function exchangeClientCredentialsToken(
  shopDomain: string,
  rawCredentials: Record<string, unknown>,
): Promise<string> {
  const clientId = firstString(rawCredentials.clientId, rawCredentials.client_id, rawCredentials.apiKey, rawCredentials.api_key);
  const clientSecret = firstString(
    rawCredentials.clientSecret,
    rawCredentials.client_secret,
    rawCredentials.secret,
    rawCredentials.appSecret,
    rawCredentials.app_secret,
  );
  if (!clientId || !clientSecret) {
    throw new Error('Shopify credentials missing accessToken or clientId/clientSecret');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await timedFetch(
    'shopify.token',
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(shopifyTokenError(res.status, await readShopifyError(res), shopDomain));
  }
  const data = await res.json() as { access_token?: unknown };
  const token = firstString(data.access_token);
  if (!token) throw new Error('Shopify token response missing access_token');
  return token;
}

async function shopifyCredentials(creds: Record<string, unknown>): Promise<ShopifyCredentials> {
  const base = baseShopifyCredentials(creds);
  const clientId = firstString(creds.clientId, creds.client_id, creds.apiKey, creds.api_key);
  const clientSecret = firstString(creds.clientSecret, creds.client_secret, creds.secret, creds.appSecret, creds.app_secret);
  const accessToken = firstString(
    creds.accessToken,
    creds.access_token,
    creds.adminAccessToken,
    creds.admin_access_token,
    creds.admin_api_access_token,
  );

  // Dev Dashboard apps should use client credentials. Prefer that path when
  // present so a stale/wrong manually-entered accessToken cannot shadow it.
  if (clientId && clientSecret) {
    return {
      ...base,
      accessToken: await exchangeClientCredentialsToken(base.shopDomain, creds),
      authMode: 'client_credentials',
    };
  }

  if (!accessToken) throw new Error('Shopify credentials missing accessToken');
  if (!accessTokenIsFresh(creds)) {
    throw new Error('Shopify accessToken is expired; reconnect with Client ID and Client Secret');
  }
  return {
    ...base,
    accessToken,
    authMode: 'access_token',
  };
}

function shopifyUrl(creds: ShopifyCredentials, path: string): string {
  return `https://${creds.shopDomain}/admin/api/${creds.apiVersion}${path}`;
}

function shopifyAdminUrl(creds: ShopifyCredentials, path: string): string {
  return `https://${creds.shopDomain}${path}`;
}

function redactShopifyError(value: string): string {
  return value
    .replace(/shpat_[A-Za-z0-9_]+/gi, 'shpat_[redacted]')
    .replace(/shpss_[A-Za-z0-9_]+/gi, 'shpss_[redacted]')
    .replace(/X-Shopify-Access-Token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, 'X-Shopify-Access-Token=[redacted]')
    .slice(0, 700);
}

function shopifyTokenError(status: number, detail: string, shopDomain: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes('app_not_installed')) {
    return `Shopify token ${status}: the Shopify app is not installed on ${shopDomain}. Install/reinstall the app on this exact .myshopify.com shop, or connect with a real shpat_ Admin API Access Token from a Shopify-admin custom app.`;
  }
  if (lower.includes('shop_not_permitted')) {
    return `Shopify token ${status}: this Shopify shop is not permitted to use Dev Dashboard client credentials. Use a store-owned installed app, or connect with a real shpat_ Admin API Access Token from a Shopify-admin custom app.`;
  }
  return `Shopify token ${status}: ${detail}`;
}

async function readShopifyError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText;
  try {
    const data = JSON.parse(text);
    const errors = data?.errors;
    const oauthCode = firstString(data?.error);
    const oauthDescription = firstString(data?.error_description);
    if (oauthCode || oauthDescription) {
      return redactShopifyError([oauthCode, oauthDescription].filter(Boolean).join(': '));
    }
    if (typeof errors === 'string') return redactShopifyError(errors);
    if (Array.isArray(errors)) return redactShopifyError(errors.map(String).join('; '));
    return redactShopifyError(firstString(data?.message, JSON.stringify(errors), text));
  } catch {
    return redactShopifyError(text);
  }
}

async function shopifyFetch(
  name: string,
  creds: ShopifyCredentials,
  path: string,
  init: RequestInit = {},
  fields?: TimingFields,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Shopify-Access-Token', creds.accessToken);
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return timedFetch(name, shopifyUrl(creds, path), { ...init, headers }, fields);
}

async function shopifyAdminFetch(
  name: string,
  creds: ShopifyCredentials,
  path: string,
  init: RequestInit = {},
  fields?: TimingFields,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Shopify-Access-Token', creds.accessToken);
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return timedFetch(name, shopifyAdminUrl(creds, path), { ...init, headers }, fields);
}

function shopifyGraphqlUrl(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

function shopifyGraphqlHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': accessToken,
  };
}

function validationCredentialsFrom(credentials: ShopifyValidationCredentials): {
  shopDomain: string;
  accessToken: string;
} {
  const shopDomain = normalizeShopifyShopDomain(credentials.shopDomain);
  const accessToken = firstString(
    credentials.adminAccessToken,
    credentials.accessToken,
  );
  if (!accessToken) throw new Error('Shopify Admin API token is required');
  return { shopDomain, accessToken };
}

async function postShopifyGraphql<T>(
  operationName: string,
  creds: ShopifyCredentials,
  body: Record<string, unknown>,
  options: Required<Pick<ShopifyConnectorOptions, 'fetch' | 'sleep' | 'apiVersion'>>,
): Promise<T> {
  const url = shopifyGraphqlUrl(creds.shopDomain, options.apiVersion);
  const init: RequestInit = {
    method: 'POST',
    headers: shopifyGraphqlHeaders(creds.accessToken),
    body: JSON.stringify(body),
  };
  const response = options.fetch === fetch
    ? await timedFetch(operationName, url, init)
    : await options.fetch(url, init);

  if (!response.ok) {
    throw new Error(`Shopify GraphQL ${response.status}: ${await readShopifyError(response)}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  if (asArray(payload.errors).length > 0) {
    throw new Error(`Shopify GraphQL returned errors: ${redactShopifyError(JSON.stringify(payload.errors))}`);
  }

  const throttle = asRecord(asRecord(asRecord(payload.extensions).cost).throttleStatus);
  const currentlyAvailable = Number(throttle.currentlyAvailable);
  const restoreRate = Number(throttle.restoreRate);
  if (
    Number.isFinite(currentlyAvailable) &&
    Number.isFinite(restoreRate) &&
    restoreRate > 0 &&
    currentlyAvailable < 20
  ) {
    await options.sleep(Math.ceil(((20 - currentlyAvailable) / restoreRate) * 1000));
  }

  return payload as T;
}

export async function validateShopifyCredentials(
  credentials: ShopifyValidationCredentials,
  options: ShopifyConnectorOptions & { timeoutMs?: number } = {},
): Promise<ShopifyValidationResult> {
  const fetchImpl = options.fetch ?? fetch;
  const apiVersion = options.apiVersion ?? SHOPIFY_ADMIN_API_VERSION;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const creds = validationCredentialsFrom(credentials);
    const response = await fetchImpl(shopifyGraphqlUrl(creds.shopDomain, apiVersion), {
      method: 'POST',
      headers: shopifyGraphqlHeaders(creds.accessToken),
      body: JSON.stringify({ query: SHOPIFY_SHOP_QUERY }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Shopify validation ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    if (asArray(payload.errors).length > 0) {
      throw new Error('Shopify validation returned GraphQL errors');
    }
    const shop = asRecord(asRecord(payload.data).shop);
    const myshopifyDomain = normalizeShopifyShopDomain(shop.myshopifyDomain);
    return {
      ok: true,
      shopName: firstString(shop.name) || myshopifyDomain,
      myshopifyDomain,
    };
  } catch {
    return {
      ok: false,
      error: "Couldn't connect - check your shop domain and Admin API token.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyShopifyCredentials(
  rawCredentials: Record<string, unknown>,
): Promise<{
  ok: boolean;
  accountIdentifier?: string;
  accountLabel?: string;
  meta?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const creds = await shopifyCredentials(rawCredentials);
    const res = await shopifyFetch('shopify.shop', creds, '/shop.json');
    if (!res.ok) {
      return { ok: false, error: `Shopify shop ${res.status}: ${await readShopifyError(res)}` };
    }
    const data = await res.json() as { shop?: Record<string, unknown> };
    const shop = asRecord(data.shop);
    const domain = firstString(shop.myshopify_domain, shop.domain, creds.shopDomain) || creds.shopDomain;
    return {
      ok: true,
      accountIdentifier: normalizeShopifyShopDomain(domain),
      accountLabel: firstString(shop.name, domain),
      meta: {
        shopId: firstString(shop.id) || null,
        apiVersion: creds.apiVersion,
        authMode: creds.authMode,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? redactShopifyError(err.message) : redactShopifyError(String(err)) };
  }
}

export async function purchaseShopifyShippingLabel(
  rawCredentials: Record<string, unknown>,
  input: ShopifyShippingPurchaseInput,
): Promise<ShopifyShippingPurchasedLabelResult> {
  if (!isShopifyShippingPurchaseEnabled(input.env)) {
    throw new ShopifyShippingPurchaseDisabledError();
  }

  const purchaseInput = buildShopifyShippingLabelPurchaseInput(input.purchaseInput);
  const creds = await shopifyCredentials(rawCredentials);
  const res = await shopifyFetch(
    'shopify.shipping-label-purchase',
    creds,
    '/graphql.json',
    {
      method: 'POST',
      body: JSON.stringify({
        query: SHOPIFY_SHIPPING_LABEL_PURCHASE_MUTATION,
        variables: { shippingLabelPurchase: purchaseInput },
      }),
    },
    { fulfillmentOrderId: purchaseInput.fulfillmentOrderId },
  );
  if (!res.ok) {
    throw new Error(`Shopify shippingLabelPurchase ${res.status}: ${await readShopifyError(res)}`);
  }

  const body = await res.json().catch(() => ({}));
  return parseShopifyShippingPurchaseResult(body, {
    fulfillmentOrderId: purchaseInput.fulfillmentOrderId,
    orderId: firstString(input.orderId),
    orderName: firstString(input.orderName),
    preferredCarrierCode: firstString(input.purchaseInput.preferredRateSelection?.carrierCode),
    preferredServiceCode: firstString(input.purchaseInput.preferredRateSelection?.serviceCode),
  });
}

export async function checkShopifyShippingReadiness(
  rawCredentials: Record<string, unknown>,
  input: ShopifyShippingReadinessInput = {},
): Promise<ShopifyShippingReadinessResult> {
  let creds: ShopifyCredentials;
  try {
    creds = await shopifyCredentials(rawCredentials);
  } catch (err) {
    return shopifyShippingReadinessFailure({
      error: err instanceof Error ? redactShopifyError(err.message) : redactShopifyError(String(err)),
      env: input.env,
    });
  }

  const shopRes = await shopifyFetch('shopify.shop', creds, '/shop.json');
  if (!shopRes.ok) {
    return shopifyShippingReadinessFailure({
      creds,
      error: `Shopify shop ${shopRes.status}: ${await readShopifyError(shopRes)}`,
      retryable: shopRes.status === 429 || shopRes.status >= 500,
      env: input.env,
    });
  }
  const shopData = await shopRes.json().catch(() => ({})) as { shop?: Record<string, unknown> };
  const shop = asRecord(shopData.shop);
  const shopDomain = normalizeShopifyShopDomain(firstString(shop.myshopify_domain, shop.domain, creds.shopDomain) || creds.shopDomain);
  const shopName = firstString(shop.name, shopDomain);

  const scopesRes = await shopifyAdminFetch('shopify.access-scopes', creds, '/admin/oauth/access_scopes.json');
  if (!scopesRes.ok) {
    return shopifyShippingReadinessFailure({
      creds,
      shopDomain,
      shopName,
      error: `Shopify access scopes ${scopesRes.status}: ${await readShopifyError(scopesRes)}`,
      retryable: scopesRes.status === 429 || scopesRes.status >= 500,
      env: input.env,
    });
  }
  const scopePayload = await scopesRes.json().catch(() => ({}));
  const scopes = shopifyScopeHandles(scopePayload);
  const missingScopes = missingShopifyShippingScopes(scopes);
  if (missingScopes.length) {
    const eligibility = evaluateShopifyShippingEligibility({
      sourceProvider: 'shopify',
      rawOrderPayload: { source: 'shopify' },
      grantedScopes: scopes,
      env: input.env,
    });
    return {
      ok: false,
      provider: SHOPIFY_SHIPPING_PROVIDER,
      shopDomain,
      shopName,
      authMode: creds.authMode,
      scopes,
      requiredScopes: SHOPIFY_SHIPPING_REQUIRED_SCOPES,
      missingScopes,
      requiredPermission: 'buy_shipping_labels',
      fulfillmentOrderId: null,
      eligibility,
      message: `Shopify Shipping is missing scope(s): ${missingScopes.join(', ')}`,
      error: `Missing Shopify scope(s): ${missingScopes.join(', ')}`,
    };
  }

  const explicitOrderId = shopifyRestOrderIdFrom(input.orderId);
  const orderResult = explicitOrderId
    ? { order: { id: explicitOrderId, source: 'shopify' } as Record<string, unknown> }
    : await fetchShopifyReadinessSampleOrder(creds);
  if (orderResult.error) {
    return shopifyShippingReadinessFailure({
      creds,
      shopDomain,
      shopName,
      scopes,
      error: orderResult.error,
      retryable: orderResult.retryable,
      env: input.env,
    });
  }
  const order = orderResult.order;
  if (!order) {
    const eligibility = evaluateShopifyShippingEligibility({
      sourceProvider: 'shopify',
      rawOrderPayload: { source: 'shopify' },
      grantedScopes: scopes,
      env: input.env,
    });
    return {
      ok: false,
      provider: SHOPIFY_SHIPPING_PROVIDER,
      shopDomain,
      shopName,
      authMode: creds.authMode,
      scopes,
      requiredScopes: SHOPIFY_SHIPPING_REQUIRED_SCOPES,
      missingScopes: [],
      requiredPermission: 'buy_shipping_labels',
      fulfillmentOrderId: null,
      eligibility,
      message: 'Shopify connection is valid, but no open unfulfilled Shopify order was available to check fulfillment-order readiness.',
      error: 'No open unfulfilled Shopify order found',
    };
  }

  const orderId = shopifyRestOrderIdFrom(order.id ?? order.admin_graphql_api_id);
  if (!orderId) {
    return shopifyShippingReadinessFailure({
      creds,
      shopDomain,
      shopName,
      scopes,
      error: 'Shopify Shipping readiness could not resolve a REST order id from the selected order.',
      env: input.env,
    });
  }

  const fulfillmentOrdersRes = await shopifyFetch(
    'shopify.fulfillment-orders',
    creds,
    `/orders/${encodeURIComponent(orderId)}/fulfillment_orders.json`,
    {},
    { orderId },
  );
  if (!fulfillmentOrdersRes.ok) {
    return shopifyShippingReadinessFailure({
      creds,
      shopDomain,
      shopName,
      scopes,
      order,
      error: `Shopify fulfillment_orders ${fulfillmentOrdersRes.status}: ${await readShopifyError(fulfillmentOrdersRes)}`,
      retryable: fulfillmentOrdersRes.status === 429 || fulfillmentOrdersRes.status >= 500,
      env: input.env,
    });
  }

  const fulfillmentOrdersPayload = await fulfillmentOrdersRes.json().catch(() => ({}));
  const rawOrderPayload = {
    ...order,
    source: 'shopify',
    fulfillment_orders: asArray(asRecord(fulfillmentOrdersPayload).fulfillment_orders),
  };
  const eligibility = evaluateShopifyShippingEligibility({
    sourceProvider: 'shopify',
    rawOrderPayload,
    grantedScopes: scopes,
    env: input.env,
  });
  const mockLabel = eligibility.eligible && eligibility.fulfillmentOrderId
    ? createShopifyShippingMockLabel({
        fulfillmentOrderId: eligibility.fulfillmentOrderId,
        orderId,
        orderName: firstString(order.name, order.order_number, order.orderNumber, orderId),
        shopDomain,
      })
    : undefined;
  return {
    ok: eligibility.eligible,
    provider: SHOPIFY_SHIPPING_PROVIDER,
    shopDomain,
    shopName,
    authMode: creds.authMode,
    scopes,
    requiredScopes: SHOPIFY_SHIPPING_REQUIRED_SCOPES,
    missingScopes: missingShopifyShippingScopes(scopes),
    requiredPermission: 'buy_shipping_labels',
    orderId,
    orderName: firstString(order.name, order.order_number, order.orderNumber, orderId),
    fulfillmentOrderId: eligibility.fulfillmentOrderId,
    eligibility,
    ...(mockLabel ? { mockLabel } : {}),
    message: eligibility.eligible
      ? 'Shopify Shipping is ready for this store/order; mock label path ready. Live label purchase is still controlled by SHOPIFY_SHIPPING_LABELS_ENABLED and the Shopify user permission buy_shipping_labels.'
      : `Shopify Shipping is not ready: ${eligibility.missing.join(', ')}`,
    ...(eligibility.eligible ? {} : { error: `Shopify Shipping is not ready: ${eligibility.missing.join(', ')}` }),
  };
}

function shopifyShippingReadinessFailure(input: {
  creds?: ShopifyCredentials;
  shopDomain?: string;
  shopName?: string;
  scopes?: string[];
  order?: Record<string, unknown>;
  error: string;
  retryable?: boolean;
  env?: ShopifyShippingEnv;
}): ShopifyShippingReadinessResult {
  const scopes = input.scopes ?? [];
  const order = input.order ?? { source: 'shopify' };
  const eligibility = evaluateShopifyShippingEligibility({
    sourceProvider: 'shopify',
    rawOrderPayload: { ...order, source: 'shopify' },
    grantedScopes: scopes,
    env: input.env,
  });
  return {
    ok: false,
    provider: SHOPIFY_SHIPPING_PROVIDER,
    shopDomain: input.shopDomain ?? input.creds?.shopDomain,
    shopName: input.shopName,
    authMode: input.creds?.authMode,
    scopes,
    requiredScopes: SHOPIFY_SHIPPING_REQUIRED_SCOPES,
    missingScopes: missingShopifyShippingScopes(scopes),
    requiredPermission: 'buy_shipping_labels',
    orderId: shopifyRestOrderIdFrom(input.order?.id ?? input.order?.admin_graphql_api_id) || undefined,
    orderName: firstString(input.order?.name, input.order?.order_number, input.order?.orderNumber) || undefined,
    fulfillmentOrderId: eligibility.fulfillmentOrderId,
    eligibility,
    message: input.error,
    error: input.error,
    retryable: input.retryable,
  };
}

function parseShopifyShippingPurchaseResult(
  body: unknown,
  context: {
    fulfillmentOrderId: string;
    orderId?: string;
    orderName?: string;
    preferredCarrierCode?: string;
    preferredServiceCode?: string;
  },
): ShopifyShippingPurchasedLabelResult {
  const root = asRecord(body);
  const graphErrors = asArray(root.errors);
  if (graphErrors.length) {
    throw shopifyShippingPurchaseError('Shopify shippingLabelPurchase GraphQL error', graphErrors);
  }

  const payload = asRecord(asRecord(asRecord(root.data).shippingLabelPurchase));
  const userErrors = asArray(payload.userErrors);
  if (userErrors.length) {
    throw shopifyShippingPurchaseError('Shopify shippingLabelPurchase user error', userErrors);
  }

  const result = asRecord(payload.shippingLabelPurchaseResult);
  const resultErrors = asArray(result.errors);
  if (resultErrors.length) {
    throw shopifyShippingPurchaseError('Shopify shippingLabelPurchase provider error', resultErrors);
  }

  const labels = asArray(result.shippingLabels).map(asRecord);
  const label = labels[0];
  if (!label || Object.keys(label).length === 0) {
    throw shopifyShippingPurchaseError(
      `Shopify shippingLabelPurchase returned no shipping label (status ${firstString(result.status) || 'unknown'})`,
      [],
      'SHOPIFY_SHIPPING_LABEL_MISSING',
    );
  }

  const tracking = asRecord(label.trackingInfo);
  const trackingNumber = firstString(tracking.number);
  if (!trackingNumber) {
    throw shopifyShippingPurchaseError(
      'Shopify shippingLabelPurchase returned a label without a tracking number',
      [],
      'SHOPIFY_SHIPPING_TRACKING_MISSING',
    );
  }

  const document = asArray(label.shippingDocuments)
    .map(asRecord)
    .find((doc) => firstString(doc.documentType).toUpperCase() === 'LABEL' && firstString(doc.url))
    ?? asArray(label.shippingDocuments).map(asRecord).find((doc) => firstString(doc.url));
  const labelUrl = firstString(document?.url);
  if (!labelUrl) {
    throw shopifyShippingPurchaseError(
      'Shopify shippingLabelPurchase returned a label without a printable document URL',
      [],
      'SHOPIFY_SHIPPING_DOCUMENT_MISSING',
    );
  }

  return {
    provider: SHOPIFY_SHIPPING_PROVIDER,
    mock: false,
    fulfillmentOrderId: context.fulfillmentOrderId,
    orderId: context.orderId,
    orderName: context.orderName,
    purchaseResultId: firstString(result.id),
    done: Boolean(result.done),
    status: firstString(result.status) || 'UNKNOWN',
    labelId: firstString(label.id, document?.shippingLabelId),
    trackingNumber,
    trackingUrl: firstString(tracking.url) || undefined,
    labelUrl,
    labelFormat: firstString(document?.format) || 'PDF',
    carrierCode: firstString(context.preferredCarrierCode, tracking.company, SHOPIFY_SHIPPING_PROVIDER),
    serviceCode: firstString(context.preferredServiceCode, 'shopify_shipping'),
    cost: null,
    currency: null,
    postagePurchased: true,
    printable: true,
    raw: body,
  };
}

function shopifyShippingPurchaseError(message: string, errors: unknown[], code = 'SHOPIFY_SHIPPING_PURCHASE_FAILED'): Error & { code?: string; details?: Record<string, unknown> } {
  const detail = errors
    .map((error) => {
      const record = asRecord(error);
      const field = asArray(record.field).map(String).join('.');
      const parts = [firstString(record.code), field, firstString(record.message, JSON.stringify(error))].filter(Boolean);
      return parts.join(': ');
    })
    .filter(Boolean)
    .join('; ');
  const err = new Error(detail ? `${message}: ${detail}` : message) as Error & { code?: string; details?: Record<string, unknown> };
  err.code = code;
  err.details = errors.length ? { shopifyErrors: errors } : undefined;
  return err;
}

function shopifyScopeHandles(payload: unknown): string[] {
  return asArray(asRecord(payload).access_scopes)
    .map((scope) => firstString(asRecord(scope).handle))
    .filter(Boolean);
}

function missingShopifyShippingScopes(scopes: string[]): string[] {
  const granted = new Set(scopes);
  return SHOPIFY_SHIPPING_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
}

async function fetchShopifyReadinessSampleOrder(
  creds: ShopifyCredentials,
): Promise<{ order?: Record<string, unknown>; error?: string; retryable?: boolean }> {
  const params = new URLSearchParams({
    status: 'open',
    fulfillment_status: 'unshipped',
    limit: '1',
  });
  const res = await shopifyFetch('shopify.orders-import', creds, `/orders.json?${params.toString()}`);
  if (!res.ok) {
    return {
      error: `Shopify orders ${res.status}: ${await readShopifyError(res)}`,
      retryable: res.status === 429 || res.status >= 500,
    };
  }
  const data = await res.json().catch(() => ({})) as { orders?: unknown[] };
  const order = asArray(data.orders).map(asRecord)[0];
  return order ? { order } : {};
}

function shopifyRestOrderIdFrom(value: unknown): string {
  const raw = firstString(value);
  if (!raw) return '';
  const normalized = raw
    .replace(/^gid:\/\/shopify\/Order\//i, '')
    .replace(/^shopify-/i, '')
    .trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function gidTail(value: unknown): string {
  const raw = firstString(value);
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function parseShopifyDate(value: unknown): Date | null {
  const raw = firstString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function firstMoneyFromPaths(root: Record<string, unknown>, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = root;
    for (const segment of path) {
      current = asRecord(current)[segment];
    }
    const money = moneyString(current);
    if (money != null) return money;
  }
  return null;
}

function normalizeShopifyStatus(order: Record<string, unknown>): NormalizedOrder['canonicalStatus'] {
  const fulfillment = firstString(
    order.fulfillment_status,
    order.fulfillmentStatus,
    order.displayFulfillmentStatus,
  ).toLowerCase();
  const financial = firstString(order.financial_status, order.financialStatus).toLowerCase();
  if (firstString(order.cancelled_at, order.cancelledAt, order.cancel_reason)) return 'cancelled';
  if (financial === 'voided') return 'cancelled';
  if (fulfillment === 'fulfilled') return 'shipped';
  return 'awaiting_shipment';
}

function lineQuantity(line: Record<string, unknown>): number {
  const raw = Number(line.current_quantity ?? line.currentQuantity ?? line.quantity ?? 1);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

function gramsToOunces(grams: number): number {
  return grams / 28.349523125;
}

function normalizeShopifyItems(order: Record<string, unknown>): Array<Record<string, unknown>> {
  const restLines = asArray(order.line_items);
  const directLineItems = asArray(order.lineItems);
  const graphLineItems = asArray(asRecord(order.lineItems).edges)
    .map((edge) => asRecord(asRecord(edge).node))
    .filter((line) => Object.keys(line).length > 0);
  const lines = restLines.length ? restLines : directLineItems.length ? directLineItems : graphLineItems;

  return lines
    .map((rawLine) => {
      const line = asRecord(rawLine);
      const quantity = lineQuantity(line);
      const grams = Number(line.grams ?? 0);
      const unitPrice = firstMoneyFromPaths(line, [
        ['originalUnitPriceSet', 'shopMoney', 'amount'],
      ]) ?? moneyString(line.price) ?? '0.00';
      const image = asRecord(line.image);
      const variant = asRecord(line.variant);
      return {
        sku: firstString(line.sku) || null,
        name: firstString(line.title, line.name) || null,
        quantity,
        variantId: firstString(variant.id) || null,
        unitPrice,
        lineTotal: (Number(unitPrice) * quantity).toFixed(2),
        imageUrl: firstString(image.src, image.url) || null,
        sourceLineItemId: firstString(line.id, line.admin_graphql_api_id) || null,
        weightOz: Number.isFinite(grams) && grams > 0 ? Math.ceil(gramsToOunces(grams)) : null,
        raw: line,
      };
    })
    .filter((line) => line.quantity !== 0);
}

function shopifyOrderWeightOz(order: Record<string, unknown>): number | null {
  const totalWeight = Number(order.totalWeight);
  if (Number.isFinite(totalWeight) && totalWeight > 0) return totalWeight;

  let gramsTotal = 0;
  for (const rawLine of asArray(order.line_items ?? order.lineItems)) {
    const line = asRecord(rawLine);
    const grams = Number(line.grams ?? 0);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    gramsTotal += grams * lineQuantity(line);
  }
  return gramsTotal > 0 ? Math.ceil(gramsToOunces(gramsTotal)) : null;
}

export function normalizeShopifyOrder(
  raw: unknown,
  context: string | ShopifyOrderContext = 'shopify',
): NormalizedOrder {
  const order = asRecord(raw);
  const accountId = typeof context === 'string' ? context : context.accountId;
  const storeId = typeof context === 'string'
    ? accountId
    : context.storeId != null
      ? String(context.storeId)
      : accountId;
  const id = gidTail(firstString(order.id, order.admin_graphql_api_id));
  const orderNumber = firstString(order.name, order.order_number, order.orderNumber, id);
  const shippingAddress = asRecord(order.shipping_address ?? order.shippingAddress);
  const shippingLine = asRecord(asArray(order.shipping_lines ?? order.shippingLines)[0]);
  const customer = asRecord(order.customer);
  const shippingPaid = moneyNumber(
    firstMoneyFromPaths(order, [
      ['total_shipping_price_set', 'shop_money', 'amount'],
      ['totalShippingPriceSet', 'shopMoney', 'amount'],
    ]) ?? shippingLine.price,
  );

  return {
    sourceProvider: 'shopify',
    sourceAccountId: accountId,
    sourceOrderId: id,
    sourceOrderNumber: orderNumber || id,
    marketplace: 'shopify',
    storeId,
    canonicalStatus: normalizeShopifyStatus(order),
    orderDate: parseShopifyDate(firstString(order.created_at, order.createdAt)),
    customerName: firstString(shippingAddress.name, customer.displayName, customer.first_name, customer.last_name) || null,
    customerEmail: firstString(order.email, order.contact_email, customer.email) || null,
    shipToCity: firstString(shippingAddress.city) || null,
    shipToState: firstString(shippingAddress.province_code, shippingAddress.provinceCode, shippingAddress.province) || null,
    shipToPostalCode: firstString(shippingAddress.zip, shippingAddress.postal_code) || null,
    carrierCode: firstString(shippingLine.carrier_identifier, shippingLine.source) || null,
    serviceCode: firstString(shippingLine.code, shippingLine.title) || null,
    weightOz: shopifyOrderWeightOz(order),
    orderTotal: firstMoneyFromPaths(order, [
      ['current_total_price'],
      ['currentTotalPrice'],
      ['total_price'],
      ['totalPrice'],
      ['current_total_price_set', 'shop_money', 'amount'],
      ['currentTotalPriceSet', 'shopMoney', 'amount'],
    ]),
    shippingPaid,
    items: normalizeShopifyItems(order),
    externallyShipped: normalizeShopifyStatus(order) === 'shipped',
    rawPayload: raw,
  };
}

function buildOrdersSearchQuery(input: StoreOrderImportInput): string {
  const terms: string[] = [];
  if (input.sinceDate) terms.push(`updated_at:>=${input.sinceDate}`);
  if (input.createdStartDate) terms.push(`created_at:>=${input.createdStartDate}`);
  return terms.join(' ');
}

function maxUpdatedAt(nodes: unknown[]): string | null {
  let max = 0;
  for (const node of nodes) {
    const parsed = parseShopifyDate(asRecord(node).updatedAt ?? asRecord(node).updated_at);
    if (parsed && parsed.getTime() > max) max = parsed.getTime();
  }
  return max > 0 ? new Date(max).toISOString() : null;
}

function defaultConnectorOptions(options: ShopifyConnectorOptions = {}): Required<Pick<ShopifyConnectorOptions, 'fetch' | 'sleep' | 'apiVersion'>> {
  return {
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    apiVersion: options.apiVersion ?? SHOPIFY_ADMIN_API_VERSION,
  };
}

async function importShopifyOrders(
  input: StoreOrderImportInput,
  options: Required<Pick<ShopifyConnectorOptions, 'fetch' | 'sleep' | 'apiVersion'>>,
): Promise<NormalizedStoreOrderImportResult> {
  const creds = await shopifyCredentials(input.credentials ?? {});
  const pageSize = Math.min(Math.max(Number(input.limit ?? input.pageSize ?? 50), 1), 100);
  const payload = await postShopifyGraphql<{
    data?: {
      orders?: {
        edges?: Array<{ cursor?: string; node?: unknown }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
    orders?: unknown[];
  }>(
    'shopify.orders-import',
    creds,
    {
      query: SHOPIFY_ORDERS_QUERY,
      variables: {
        first: pageSize,
        after: input.cursor ?? null,
        query: buildOrdersSearchQuery(input),
      },
    },
    options,
  );

  const ordersConnection = payload.data?.orders;
  const orderEdges = Array.isArray(ordersConnection?.edges) ? ordersConnection.edges : [];
  const graphNodes = orderEdges
    .map((edge) => edge.node)
    .filter((node): node is unknown => node != null);
  const legacyReplayOrders = asArray(payload.orders);
  const rawOrders = graphNodes.length > 0 ? graphNodes : legacyReplayOrders;
  const pageInfo = ordersConnection?.pageInfo ?? {};
  const storeId = input.storeId ?? null;
  const clientId = input.companyId || null;

  return {
    provider: 'shopify',
    accountId: input.accountId,
    orders: rawOrders.map((order) => normalizeShopifyOrder(order, {
      accountId: input.accountId,
      clientId,
      storeId,
    })),
    cursor: pageInfo.hasNextPage ? firstString(pageInfo.endCursor) || null : null,
    total: rawOrders.length,
    diagnostics: {
      hasNextPage: pageInfo.hasNextPage === true,
      maxUpdatedAt: maxUpdatedAt(rawOrders),
    },
  };
}

function shopifyOrderIdFrom(input: ShipmentConfirmationInput): string {
  const payload = input.payload ?? {};
  const explicit = firstString(payload.shopifyOrderId, payload.sourceOrderId, payload.upstreamOrderId);
  if (explicit) return explicit.replace(/^gid:\/\/shopify\/Order\//, '');
  const external = firstString(input.externalOrderId);
  return external.toLowerCase().startsWith('shopify-') ? external.slice('shopify-'.length) : external;
}

function trackingCompany(input: ShipmentConfirmationInput): string {
  const carrier = firstString(input.carrierCode, input.payload?.carrierName, input.payload?.carrierProvider);
  const lower = carrier.toLowerCase();
  if (lower.includes('usps')) return 'USPS';
  if (lower.includes('ups')) return 'UPS';
  if (lower.includes('fedex')) return 'FedEx';
  if (lower.includes('dhl')) return 'DHL';
  return carrier || 'Other';
}

function trackingUrl(input: ShipmentConfirmationInput): string | null {
  const explicit = firstString(input.payload?.trackingUrl, input.payload?.trackingURL);
  if (explicit) return explicit;
  const carrier = trackingCompany(input).toLowerCase();
  const tracking = encodeURIComponent(input.trackingNumber);
  if (carrier === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;
  if (carrier === 'ups') return `https://www.ups.com/track?tracknum=${tracking}`;
  if (carrier === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${tracking}`;
  return null;
}

function activeFulfillmentOrders(raw: unknown): Array<Record<string, unknown>> {
  return asArray(asRecord(raw).fulfillment_orders)
    .map(asRecord)
    .filter((order) => {
      const status = firstString(order.status).toLowerCase();
      const requestStatus = firstString(order.request_status).toLowerCase();
      return status !== 'closed' && status !== 'cancelled' && requestStatus !== 'cancellation_requested';
    });
}

async function confirmShopifyShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
  const trackingNumber = firstString(input.trackingNumber);
  if (!trackingNumber) {
    return { ok: false, provider: 'shopify', retryable: false, message: 'Shopify confirmation missing trackingNumber' };
  }
  const orderId = shopifyOrderIdFrom(input);
  if (!orderId) {
    return { ok: false, provider: 'shopify', retryable: false, message: 'Shopify confirmation missing order id' };
  }

  let creds: ShopifyCredentials;
  try {
    creds = await shopifyCredentials(input.credentials ?? {});
  } catch (err) {
    return {
      ok: false,
      provider: 'shopify',
      retryable: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const fulfillmentOrdersRes = await shopifyFetch(
    'shopify.fulfillment-orders',
    creds,
    `/orders/${encodeURIComponent(orderId)}/fulfillment_orders.json`,
    {},
    { orderId },
  );
  if (!fulfillmentOrdersRes.ok) {
    return {
      ok: false,
      provider: 'shopify',
      retryable: fulfillmentOrdersRes.status === 429 || fulfillmentOrdersRes.status >= 500,
      message: `Shopify fulfillment_orders ${fulfillmentOrdersRes.status}: ${await readShopifyError(fulfillmentOrdersRes)}`,
    };
  }

  const fulfillmentOrdersPayload = await fulfillmentOrdersRes.json();
  const fulfillmentOrders = activeFulfillmentOrders(fulfillmentOrdersPayload);
  if (!fulfillmentOrders.length) {
    return {
      ok: true,
      provider: 'shopify',
      raw: { alreadyFulfilled: true, fulfillmentOrders: fulfillmentOrdersPayload },
    };
  }

  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: fulfillmentOrders.map((order) => ({
        fulfillment_order_id: Number(order.id),
      })),
      notify_customer: input.notifyCustomer === true,
      tracking_info: {
        number: trackingNumber,
        company: trackingCompany(input),
        ...(trackingUrl(input) ? { url: trackingUrl(input) } : {}),
      },
    },
  };

  const res = await shopifyFetch(
    'shopify.ship-confirm',
    creds,
    '/fulfillments.json',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    { orderId },
  );
  if (res.ok) {
    const raw = await res.json().catch(() => ({ status: res.status }));
    return { ok: true, provider: 'shopify', raw };
  }

  const message = await readShopifyError(res);
  if (res.status === 422 && /(already|fulfilled|closed)/i.test(message)) {
    return { ok: true, provider: 'shopify', raw: { alreadyFulfilled: true, message } };
  }

  return {
    ok: false,
    provider: 'shopify',
    retryable: res.status === 429 || res.status >= 500,
    message: `Shopify fulfillment create ${res.status}: ${message}`,
  };
}

export function createShopifyStoreConnector(options: ShopifyConnectorOptions = {}): StoreConnector {
  const connectorOptions = defaultConnectorOptions(options);
  return {
    provider: 'shopify',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    importOrders: (input) => importShopifyOrders(input, connectorOptions),
    normalizeOrder: (raw) => normalizeShopifyOrder(raw, { accountId: 'shopify' }),
    confirmShipment: confirmShopifyShipment,
  };
}

export const shopifyStoreConnector = createShopifyStoreConnector();

export const __shopifyConnectorTestOnly = {
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_SHOP_QUERY,
};
