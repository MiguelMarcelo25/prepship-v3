import { createWalmartStoreConnector } from '../src/connectors/store/walmart';

const originalFetch = globalThis.fetch;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`walmart confirmation payload guard failed: ${message}`);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockFetch<T>(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const textUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : String(url);
    return handler(textUrl, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function run() {
  const connector = createWalmartStoreConnector();
  const calls: Array<{ url: string; body?: string }> = [];

  const result = await withMockFetch((url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/v3/token')) {
      return jsonResponse(200, { access_token: 'mock-walmart-token' });
    }
    if (url.includes('/v3/orders/129114381653217/shipping')) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: [{ description: 'unexpected mock call' }] });
  }, () => connector.confirmShipment({
    orderId: 1057589,
    shipmentId: 24544,
    externalOrderId: 'walmart-129114381653217',
    clientId: 10,
    orderNumber: '200014621589900',
    trackingNumber: '381526072689',
    carrierCode: 'FedEx',
    shipDate: '2026-05-23T00:36:02.850Z',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      serviceName: 'Walmart Marketplace',
    },
    payload: {
      purchaseOrderId: '129114381653217',
      carrierName: 'FedEx',
      trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr=381526072689',
      rawOrder: {
        shippingInfo: { methodCode: 'Standard' },
        orderLines: {
          orderLine: [
            {
              lineNumber: '1',
              orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
              orderLineStatuses: {
                orderLineStatus: [
                  { status: 'Acknowledged', statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' } },
                ],
              },
            },
          ],
        },
      },
    },
  }));

  assert(result.ok, 'mocked Walmart confirmation should succeed');
  const shipCall = calls.find((call) => call.url.includes('/v3/orders/129114381653217/shipping'));
  assert(shipCall?.body, 'ship-confirm call must include a JSON body');
  const body = JSON.parse(shipCall.body);
  assert(body.orderShipment, 'shipping update body must use Walmart orderShipment envelope');
  assert(!body.orderLines, 'shipping update body must not send top-level orderLines');
  const line = body.orderShipment?.orderLines?.orderLine?.[0];
  assert(line?.lineNumber === '1', 'payload must include Walmart order line number');
  const status = line?.orderLineStatuses?.orderLineStatus?.[0];
  assert(status?.status === 'Shipped', 'payload must mark the line status as Shipped');
  assert(status?.statusQuantity?.amount === '1', 'payload must include shipped quantity');
  assert(status?.trackingInfo?.trackingNumber === '381526072689', 'payload must include tracking number');
  assert(status?.trackingInfo?.carrierName === 'FedEx', 'payload must include carrier name');
  assert(status?.trackingInfo?.methodCode === 'Standard', 'payload must preserve Walmart shipping method');
  assert(!shipCall.body.includes('client-secret'), 'payload must not leak credentials');

  console.log('walmart confirmation payload guard passed');
}

run().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
