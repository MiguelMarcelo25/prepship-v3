import type {
  ConfirmationResult,
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  ShipmentConfirmationInput,
  StoreOrderImportInput,
  StoreConnector,
} from '../../domain/fulfillment/types.js';
import { timedFetch, type TimingFields } from '../../lib/http/timing.js';

const DEFAULT_API_VERSION = '2026-07';

type ShopifyCredentials = {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  authMode: 'access_token' | 'client_credentials';
};

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
  if (!raw) return '';

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

  raw = raw.replace(/^admin\./, '').replace(/\/+$/, '');
  if (/^[a-z0-9][a-z0-9-]*$/.test(raw)) return `${raw}.myshopify.com`;
  return raw;
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
  const accessToken = firstString(creds.accessToken, creds.access_token, creds.adminAccessToken, creds.admin_api_access_token);

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
  const fulfillment = firstString(order.fulfillment_status, order.fulfillmentStatus).toLowerCase();
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
  return asArray(order.line_items ?? order.lineItems)
    .map((rawLine) => {
      const line = asRecord(rawLine);
      const quantity = lineQuantity(line);
      const grams = Number(line.grams ?? 0);
      const unitPrice = moneyString(line.price) ?? '0.00';
      const image = asRecord(line.image);
      return {
        sku: firstString(line.sku) || null,
        name: firstString(line.title, line.name) || null,
        quantity,
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
  let gramsTotal = 0;
  for (const rawLine of asArray(order.line_items ?? order.lineItems)) {
    const line = asRecord(rawLine);
    const grams = Number(line.grams ?? 0);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    gramsTotal += grams * lineQuantity(line);
  }
  return gramsTotal > 0 ? Math.ceil(gramsToOunces(gramsTotal)) : null;
}

function normalizeShopifyOrder(raw: unknown, accountId = 'shopify'): NormalizedOrder {
  const order = asRecord(raw);
  const id = firstString(order.id, order.admin_graphql_api_id);
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
    storeId: accountId,
    canonicalStatus: normalizeShopifyStatus(order),
    orderDate: firstString(order.created_at, order.createdAt) ? new Date(firstString(order.created_at, order.createdAt)) : null,
    customerName: firstString(shippingAddress.name, customer.first_name, customer.last_name) || null,
    customerEmail: firstString(order.email, order.contact_email, customer.email) || null,
    shipToCity: firstString(shippingAddress.city) || null,
    shipToState: firstString(shippingAddress.province_code, shippingAddress.province) || null,
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

function cursorFromLinkHeader(link: string | null): string | null {
  if (!link) return null;
  const nextPart = link.split(',').find((part) => /rel="?next"?/.test(part));
  const urlMatch = nextPart?.match(/<([^>]+)>/);
  if (!urlMatch?.[1]) return null;
  try {
    return new URL(urlMatch[1]).searchParams.get('page_info');
  } catch {
    return null;
  }
}

async function importShopifyOrders(input: StoreOrderImportInput): Promise<NormalizedStoreOrderImportResult> {
  const creds = await shopifyCredentials(input.credentials ?? {});
  const limit = Math.min(Math.max(Number(input.limit ?? input.pageSize ?? 50), 1), 250);
  const params = new URLSearchParams({
    status: 'open',
    fulfillment_status: input.orderStatus ?? 'unshipped',
    limit: String(limit),
  });
  if (input.cursor) {
    params.set('page_info', input.cursor);
  } else {
    const since = firstString(input.sinceDate, input.createdStartDate);
    if (since) params.set('created_at_min', since);
  }

  const res = await shopifyFetch('shopify.orders-import', creds, `/orders.json?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Shopify orders ${res.status}: ${await readShopifyError(res)}`);
  }
  const data = await res.json() as { orders?: unknown[] };
  const rawOrders = asArray(data.orders);
  return {
    provider: 'shopify',
    accountId: input.accountId,
    orders: rawOrders.map((order) => normalizeShopifyOrder(order, input.accountId)),
    cursor: cursorFromLinkHeader(res.headers.get('link')),
    total: rawOrders.length,
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

export function createShopifyStoreConnector(): StoreConnector {
  return {
    provider: 'shopify',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    importOrders: importShopifyOrders,
    normalizeOrder: (raw) => normalizeShopifyOrder(raw),
    confirmShipment: confirmShopifyShipment,
  };
}

export const shopifyStoreConnector = createShopifyStoreConnector();
