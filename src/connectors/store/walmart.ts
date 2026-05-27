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
  return firstString((rawOrder as any)?.shippingInfo?.methodCode, 'VALUE');
}

function normalizeWalmartOrder(raw: unknown, accountId = 'walmart'): NormalizedOrder {
  const order = raw as any;
  const purchaseOrderId = firstString(order?.purchaseOrderId);
  const customerOrderId = firstString(order?.customerOrderId);
  const lines = Array.isArray(order?.orderLines?.orderLine) ? order.orderLines.orderLine : [];
  const firstStatus = lines[0]?.orderLineStatuses?.orderLineStatus?.[0]?.status;
  const status = firstString(firstStatus).toLowerCase();
  const address = order?.shippingInfo?.postalAddress ?? {};
  return {
    sourceProvider: 'walmart',
    sourceAccountId: accountId,
    sourceOrderId: purchaseOrderId,
    sourceOrderNumber: customerOrderId || purchaseOrderId,
    marketplace: 'walmart',
    storeId: accountId,
    canonicalStatus: status === 'shipped' || status === 'delivered'
      ? 'shipped'
      : status === 'cancelled' || status === 'canceled'
        ? 'cancelled'
        : 'awaiting_shipment',
    customerName: firstString(address.name) || null,
    customerEmail: null,
    shippingPaid: null,
    rawPayload: raw,
  };
}

export async function lookupWalmartOrderByCustomerOrderId(
  creds: Record<string, unknown>,
  customerOrderId: string,
): Promise<{ purchaseOrderId: string; rawOrder: any } | null> {
  const trimmed = customerOrderId.trim();
  if (!/^\d{8,}$/.test(trimmed)) return null;

  let token: string;
  try {
    token = await getWalmartAccessToken(creds);
  } catch (err) {
    console.warn('[walmart connector] token lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const url = new URL('https://marketplace.walmartapis.com/v3/orders');
  url.searchParams.set('customerOrderId', trimmed);
  url.searchParams.set('productInfo', 'true');

  try {
    const res = await timedFetch('walmart.order-lookup', url.toString(), {
      headers: {
        ...walmartHeaders(creds, token),
        'WM_MARKET': 'us',
      },
    });
    if (!res.ok) {
      console.warn(`[walmart connector] order lookup ${res.status}: ${await readWalmartError(res)}`);
      return null;
    }
    const data = await res.json() as { list?: { elements?: { order?: unknown[] | unknown } } };
    const elementsRaw = (data?.list?.elements as { order?: unknown[] | unknown } | undefined)?.order;
    const elements = Array.isArray(elementsRaw)
      ? elementsRaw
      : elementsRaw
        ? [elementsRaw]
        : [];
    const match = elements.find((order) => firstString((order as any)?.customerOrderId) === trimmed) ?? elements[0];
    const purchaseOrderId = firstString((match as any)?.purchaseOrderId);
    if (!purchaseOrderId) return null;
    return { purchaseOrderId, rawOrder: match };
  } catch (err) {
    console.warn('[walmart connector] order lookup error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function walmartShipDateTime(shipDate: string | null | undefined): number {
  const parsed = shipDate ? Date.parse(shipDate) : NaN;
  // Walmart's JSON shipping API rejects ISO strings here; it expects epoch ms.
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function walmartLineNumber(line: any): string {
  return firstString(line?.lineNumber);
}

function walmartStatusQuantity(line: any): Record<string, string> {
  const lineQuantity = line?.orderLineQuantity;
  const statuses = Array.isArray(line?.orderLineStatuses?.orderLineStatus)
    ? line.orderLineStatuses.orderLineStatus
    : [];
  const statusQuantity = statuses.find((status: any) => status?.statusQuantity)?.statusQuantity;
  const quantity = statusQuantity ?? lineQuantity ?? {};
  return {
    unitOfMeasurement: firstString(quantity.unitOfMeasurement, 'EACH'),
    amount: firstString(quantity.amount, '1'),
  };
}

export function buildWalmartShipmentConfirmationBody(rawOrder: unknown, input: {
  carrierName: string;
  methodCode: string;
  shipDateTime: number;
  trackingNumber: string;
  trackingUrl: string;
}): { orderShipment: { orderLines: { orderLine: Array<Record<string, unknown>> } } } {
  const orderLines = Array.isArray((rawOrder as any)?.orderLines?.orderLine)
    ? (rawOrder as any).orderLines.orderLine
    : [];

  const orderLine = orderLines
    .filter((line: any) => {
      const statuses = Array.isArray(line?.orderLineStatuses?.orderLineStatus)
        ? line.orderLineStatuses.orderLineStatus
        : [];
      return walmartLineNumber(line) && (!statuses.length || statuses.some((status: any) => !/cancel/i.test(String(status?.status ?? ''))));
    })
    .map((line: any) => ({
      lineNumber: walmartLineNumber(line),
      orderLineStatuses: {
        orderLineStatus: [
          {
            status: 'Shipped',
            statusQuantity: walmartStatusQuantity(line),
            trackingInfo: {
              shipDateTime: input.shipDateTime,
              carrierName: { carrier: input.carrierName },
              methodCode: input.methodCode,
              trackingNumber: input.trackingNumber,
              ...(input.trackingUrl ? { trackingURL: input.trackingUrl } : {}),
            },
          },
        ],
      },
    }));

  return {
    orderShipment: {
      orderLines: {
        orderLine,
      },
    },
  };
}

export function createWalmartStoreConnector(): StoreConnector {
  return {
    provider: 'walmart',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'inventory.import', 'inventory.push', 'products.import'],
    async importOrders(input: StoreOrderImportInput): Promise<NormalizedStoreOrderImportResult> {
      const creds = input.credentials ?? {};
      const token = await getWalmartAccessToken(creds);
      const url = new URL('https://marketplace.walmartapis.com/v3/orders');
      url.searchParams.set('createdStartDate', input.createdStartDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      url.searchParams.set('limit', String(Math.min(Math.max(Number(input.limit ?? 50), 1), 200)));
      url.searchParams.set('productInfo', 'true');

      const res = await timedFetch('walmart.orders-import', url.toString(), {
        headers: walmartHeaders(creds, token),
      });
      if (!res.ok) {
        throw new Error(`Walmart /v3/orders ${res.status}: ${await readWalmartError(res)}`);
      }

      const data = await res.json() as { list?: { meta?: unknown; elements?: { order?: unknown[] | unknown } } };
      const ordersList = (data?.list?.elements as { order?: unknown[] | unknown } | undefined) ?? {};
      const elements = Array.isArray((ordersList as any)?.order)
        ? ((ordersList as any).order as unknown[])
        : (ordersList as any)?.order
          ? [(ordersList as any).order]
          : [];

      return {
        provider: 'walmart',
        accountId: input.accountId,
        orders: elements.map((order) => normalizeWalmartOrder(order, input.accountId)),
        total: elements.length,
        diagnostics: { meta: data?.list?.meta ?? null },
      };
    },
    normalizeOrder: (raw) => normalizeWalmartOrder(raw),
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
      if (!firstString(input.trackingNumber)) {
        return {
          ok: false,
          provider: 'walmart',
          retryable: false,
          message: 'Walmart confirmation missing tracking number',
        };
      }
      const shipmentBody = buildWalmartShipmentConfirmationBody(rawOrder, {
        carrierName,
        methodCode: walmartMethodCode(rawOrder),
        shipDateTime: walmartShipDateTime(input.shipDate),
        trackingNumber: input.trackingNumber,
        trackingUrl,
      });
      if (!shipmentBody.orderShipment.orderLines.orderLine.length) {
        return {
          ok: false,
          provider: 'walmart',
          retryable: false,
          message: 'Cannot mark Walmart shipped: missing Walmart order line numbers',
        };
      }

      const token = await getWalmartAccessToken(creds);
      const res = await timedFetch(
        'walmart.ship-confirm',
        `https://marketplace.walmartapis.com/v3/orders/${encodeURIComponent(purchaseOrderId)}/shipping`,
        {
          method: 'POST',
          headers: walmartHeaders(creds, token),
          body: JSON.stringify(shipmentBody),
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
