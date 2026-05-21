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

async function readWalmartError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText;
  try {
    const data = JSON.parse(text);
    return firstString(data?.error?.[0]?.description, data?.errors?.[0]?.description, data?.message, text.slice(0, 800));
  } catch {
    return text.slice(0, 800);
  }
}

async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = firstString(creds.clientId, creds.client_id, creds.consumerId, creds.consumer_id);
  const clientSecret = firstString(creds.clientSecret, creds.client_secret, creds.privateKey, creds.private_key);
  if (!clientId || !clientSecret) {
    throw new Error('Walmart credentials missing clientId/clientSecret');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await timedFetch('walmart.token', 'https://marketplace.walmartapis.com/v3/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'WM_SVC.NAME': 'PrepShip',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    throw new Error(`Walmart token ${res.status}: ${await readWalmartError(res)}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const token = firstString(data.access_token);
  if (!token) throw new Error('Walmart token response did not include access_token');
  return token;
}

function walmartHeaders(creds: Record<string, unknown>, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'WM_SVC.NAME': firstString(creds.serviceName, creds.service_name, 'PrepShip'),
  };
  const channelType = firstString(creds.channelType, creds.channel_type);
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  return headers;
}

function walmartMethodCode(rawOrder: unknown): string {
  return firstString((rawOrder as any)?.shippingInfo?.methodCode, 'VALUE').toUpperCase();
}

function walmartShipDateTime(shipDate: string | null | undefined): string {
  const parsed = shipDate ? Date.parse(shipDate) : NaN;
  // Walmart's JSON shipping API rejects ISO strings here; it expects epoch ms.
  return String(Number.isFinite(parsed) ? parsed : Date.now());
}

function walmartOrderLines(rawOrder: unknown, input: {
  carrierName: string;
  methodCode: string;
  shipDateTime: string;
  trackingNumber: string;
  trackingUrl: string;
}): Array<Record<string, unknown>> {
  const orderLines = Array.isArray((rawOrder as any)?.orderLines?.orderLine)
    ? (rawOrder as any).orderLines.orderLine
    : [];
  const sourceLines = orderLines.length > 0 ? orderLines : [{ lineNumber: '1' }];

  return sourceLines
    .filter((line: any) => {
      const statuses = Array.isArray(line?.orderLineStatuses?.orderLineStatus)
        ? line.orderLineStatuses.orderLineStatus
        : [];
      return !statuses.length || statuses.some((status: any) => !/cancel/i.test(String(status?.status ?? '')));
    })
    .map((line: any) => ({
      lineNumber: String(line?.lineNumber ?? '1'),
      trackingInfo: {
        shipDateTime: input.shipDateTime,
        carrierName: input.carrierName,
        methodCode: input.methodCode,
        trackingNumber: input.trackingNumber,
        ...(input.trackingUrl ? { trackingURL: input.trackingUrl } : {}),
      },
    }));
}

export function createWalmartStoreConnector(): StoreConnector {
  return {
    provider: 'walmart',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    async confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      const creds = input.credentials ?? {};
      const payload = input.payload ?? {};
      const purchaseOrderId = firstString(
        payload.purchaseOrderId,
        input.externalOrderId?.startsWith('walmart-') ? input.externalOrderId.slice('walmart-'.length) : null,
      );
      if (!purchaseOrderId) {
        return {
          ok: false,
          provider: 'walmart',
          retryable: false,
          message: 'Walmart confirmation missing purchaseOrderId',
        };
      }

      const rawOrder = payload.rawOrder;
      const carrierName = firstString(payload.carrierName, input.carrierCode, 'Other');
      const trackingUrl = firstString(payload.trackingUrl);
      const orderLines = walmartOrderLines(rawOrder, {
        carrierName,
        methodCode: walmartMethodCode(rawOrder),
        shipDateTime: walmartShipDateTime(input.shipDate),
        trackingNumber: input.trackingNumber,
        trackingUrl,
      });
      if (!orderLines.length) {
        return {
          ok: false,
          provider: 'walmart',
          retryable: false,
          message: 'Walmart confirmation has no shippable order lines',
        };
      }

      const token = await getWalmartAccessToken(creds);
      const res = await timedFetch(
        'walmart.ship-confirm',
        `https://marketplace.walmartapis.com/v3/orders/${encodeURIComponent(purchaseOrderId)}/shipping`,
        {
          method: 'POST',
          headers: walmartHeaders(creds, token),
          body: JSON.stringify({ orderLines }),
        },
        { purchaseOrderId },
      );
      if (!res.ok) {
        throw new Error(`Walmart Ship Confirm ${res.status}: ${await readWalmartError(res)}`);
      }
      const text = await res.text().catch(() => '');
      let raw: unknown = { ok: true };
      if (text) {
        try {
          raw = JSON.parse(text);
        } catch {
          raw = { body: text.slice(0, 500) };
        }
      }
      return { ok: true, provider: 'walmart', raw };
    },
  };
}

export const walmartStoreConnector = createWalmartStoreConnector();
