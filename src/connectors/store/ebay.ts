import type {
  ConfirmationResult,
  ShipmentConfirmationInput,
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

export function createEbayStoreConnector(): StoreConnector {
  return {
    provider: 'ebay',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'products.import'],
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
