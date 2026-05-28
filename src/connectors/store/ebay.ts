import type {
  ConfirmationResult,
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  ShipmentConfirmationInput,
  StoreOrderImportInput,
  StoreConnector,
} from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function redactEbayError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/refresh_token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, 'refresh_token=[redacted]')
    .replace(/access_token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, 'access_token=[redacted]')
    .slice(0, 700);
}

async function readEbayError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText;
  try {
    const data = JSON.parse(text);
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    const first = errors[0] ?? {};
    return redactEbayError(firstString(first.message, first.longMessage, data.message, text));
  } catch {
    return redactEbayError(text);
  }
}

async function getEbayAccessToken(creds: Record<string, unknown>): Promise<string> {
  const appId = firstString(creds.appId, creds.app_id);
  const certId = firstString(creds.certId, creds.cert_id);
  const refreshToken = firstString(creds.refreshToken, creds.refresh_token);
  if (!appId || !certId || !refreshToken) {
    throw new Error('eBay credentials missing appId/certId/refreshToken');
  }

  const useSandbox = firstString(creds.environment).toLowerCase() === 'sandbox';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
  const res = await timedFetch('ebay.token', tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    }),
  });
  if (!res.ok) {
    throw new Error(`eBay OAuth ${res.status}: ${await readEbayError(res)}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const token = firstString(data.access_token);
  if (!token) throw new Error('eBay OAuth response did not include access_token');
  return token;
}

export async function exchangeEbayAuthorizationCode(input: {
  credentials: Record<string, unknown>;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken?: string; refreshToken?: string; expiresIn?: number; tokenUrl: string }> {
  const appId = firstString(input.credentials.appId, input.credentials.app_id);
  const certId = firstString(input.credentials.certId, input.credentials.cert_id);
  if (!appId || !certId) {
    throw new Error('eBay credentials missing appId/certId');
  }

  const useSandbox = firstString(input.credentials.environment).toLowerCase() === 'sandbox';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
  const res = await timedFetch('ebay.authorization-code', tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`eBay authorization-code ${res.status}: ${await readEbayError(res)}`);
  }
  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: firstString(data.access_token) || undefined,
    refreshToken: firstString(data.refresh_token) || undefined,
    expiresIn: Number(data.expires_in ?? 0),
    tokenUrl,
  };
}

function ebayOrderIdFrom(input: ShipmentConfirmationInput): string {
  const payload = input.payload ?? {};
  const explicit = firstString(payload.ebayOrderId, payload.orderIdForMarketplace, payload.sourceOrderId);
  if (explicit) return explicit;
  const external = firstString(input.externalOrderId);
  return external.toLowerCase().startsWith('ebay-') ? external.slice('ebay-'.length) : external;
}

function ebayLineItems(input: ShipmentConfirmationInput): Array<{ lineItemId: string; quantity?: number }> {
  const payload = input.payload ?? {};
  const rawOrder = payload.rawOrder as Record<string, unknown> | undefined;
  const explicitLines = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const rawLines = Array.isArray(rawOrder?.lineItems) ? rawOrder.lineItems : [];
  const source = explicitLines.length > 0 ? explicitLines : rawLines;

  return source
    .map((line: unknown) => {
      const record = line && typeof line === 'object' ? line as Record<string, unknown> : {};
      const lineItemId = firstString(record.lineItemId, record.line_item_id);
      const quantityValue = Number(record.quantity ?? 1);
      const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? Math.trunc(quantityValue) : 1;
      return lineItemId ? { lineItemId, quantity } : null;
    })
    .filter((line): line is { lineItemId: string; quantity: number } => line != null);
}

function normalizeEbayTrackingNumber(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '');
}

function ebayCarrierCode(input: ShipmentConfirmationInput): string {
  const payload = input.payload ?? {};
  const raw = firstString(payload.shippingCarrierCode, payload.carrierName, input.carrierCode);
  const lower = raw.toLowerCase();
  if (lower.includes('usps') || lower.includes('stamps')) return 'USPS';
  if (lower.includes('ups')) return 'UPS';
  if (lower.includes('fedex')) return 'FedEx';
  return raw;
}

function isAlreadyFulfilledConflict(status: number, message: string): boolean {
  return status === 409 && /(already|duplicate|maximum tracking|fulfilled)/i.test(message);
}

function normalizeEbayOrder(raw: unknown, accountId = 'ebay'): NormalizedOrder {
  const order = raw as any;
  const orderId = firstString(order?.orderId);
  const legacyOrderId = firstString(order?.legacyOrderId);
  const status = firstString(order?.orderFulfillmentStatus).toUpperCase();
  const ship = Array.isArray(order?.fulfillmentStartInstructions)
    ? order.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  return {
    sourceProvider: 'ebay',
    sourceAccountId: accountId,
    sourceOrderId: orderId,
    sourceOrderNumber: legacyOrderId || orderId,
    marketplace: 'ebay',
    storeId: accountId,
    canonicalStatus: status === 'FULFILLED'
      ? 'shipped'
      : status === 'CANCELED' || status === 'CANCELLED'
        ? 'cancelled'
        : 'awaiting_shipment',
    customerName: firstString(ship?.fullName) || null,
    customerEmail: firstString(ship?.email) || null,
    shippingPaid: null,
    rawPayload: raw,
  };
}

export function createEbayStoreConnector(): StoreConnector {
  return {
    provider: 'ebay',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'products.import'],
    async importOrders(input: StoreOrderImportInput): Promise<NormalizedStoreOrderImportResult> {
      const creds = input.credentials ?? {};
      const accessToken = await getEbayAccessToken(creds);
      const useSandbox = firstString(creds.environment).toLowerCase() === 'sandbox';
      const apiBase = useSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
      const url = new URL(`${apiBase}/sell/fulfillment/v1/order`);
      url.searchParams.set('filter', `lastmodifieddate:[${input.sinceDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}..]`);
      url.searchParams.set('limit', String(Math.min(Math.max(Number(input.limit ?? 100), 1), 200)));

      const res = await timedFetch('ebay.orders-import', url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        throw new Error(`eBay /sell/fulfillment/v1/order ${res.status}: ${await readEbayError(res)}`);
      }

      const data = await res.json() as { orders?: unknown[]; total?: number };
      const elements = Array.isArray(data?.orders) ? data.orders : [];
      return {
        provider: 'ebay',
        accountId: input.accountId,
        orders: elements.map((order) => normalizeEbayOrder(order, input.accountId)),
        total: Number(data?.total ?? elements.length),
      };
    },
    normalizeOrder: (raw) => normalizeEbayOrder(raw),
    async confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      const trackingNumber = normalizeEbayTrackingNumber(firstString(input.trackingNumber));
      if (!trackingNumber) {
        return { ok: false, provider: 'ebay', retryable: false, message: 'eBay confirmation missing trackingNumber' };
      }

      const orderId = ebayOrderIdFrom(input);
      if (!orderId) {
        return { ok: false, provider: 'ebay', retryable: false, message: 'eBay confirmation missing orderId' };
      }

      const lineItems = ebayLineItems(input);
      if (!lineItems.length) {
        return { ok: false, provider: 'ebay', retryable: false, message: 'eBay confirmation missing line items with lineItemId' };
      }

      const shippingCarrierCode = ebayCarrierCode(input);
      if (!shippingCarrierCode) {
        return { ok: false, provider: 'ebay', retryable: false, message: 'eBay confirmation missing carrier code' };
      }

      let accessToken: string;
      try {
        accessToken = await getEbayAccessToken(input.credentials ?? {});
      } catch (err) {
        return {
          ok: false,
          provider: 'ebay',
          retryable: false,
          message: err instanceof Error ? redactEbayError(err.message) : redactEbayError(String(err)),
        };
      }

      const useSandbox = firstString(input.credentials?.environment).toLowerCase() === 'sandbox';
      const apiBase = useSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
      const body = {
        lineItems,
        shippedDate: new Date(input.shipDate || Date.now()).toISOString(),
        shippingCarrierCode,
        trackingNumber,
      };

      const res = await timedFetch(
        'ebay.ship-confirm',
        `${apiBase}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        },
        { orderId },
      );

      if (res.ok) {
        return {
          ok: true,
          provider: 'ebay',
          raw: {
            status: res.status,
            location: res.headers.get('location') ?? null,
          },
        };
      }

      const message = await readEbayError(res);
      if (isAlreadyFulfilledConflict(res.status, message)) {
        return {
          ok: true,
          provider: 'ebay',
          raw: { status: res.status, alreadyFulfilled: true, message },
        };
      }

      return {
        ok: false,
        provider: 'ebay',
        retryable: res.status === 429 || res.status >= 500,
        message: `eBay createShippingFulfillment ${res.status}: ${message}`,
      };
    },
  };
}

export const ebayStoreConnector = createEbayStoreConnector();
