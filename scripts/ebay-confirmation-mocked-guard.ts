import { createEbayStoreConnector } from '../src/connectors/store/ebay';

const originalFetch = globalThis.fetch;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ebay confirmation mocked guard failed: ${message}`);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 1001,
    shipmentId: 2002,
    externalOrderId: 'ebay-11-22222-33333',
    clientId: 3,
    orderNumber: '11-22222-33333',
    trackingNumber: '1Z999AA10123456784',
    carrierCode: 'UPS',
    shipDate: '2026-05-22T10:00:00.000Z',
    credentials: {
      appId: 'app-id',
      certId: 'cert-id',
      refreshToken: 'refresh-token',
      environment: 'sandbox',
    },
    payload: {
      rawOrder: {
        lineItems: [
          { lineItemId: 'line-1', quantity: 1 },
        ],
      },
      ...overrides,
    },
  };
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
  const connector = createEbayStoreConnector();

  const missingCreds = await connector.confirmShipment({
    ...baseInput(),
    credentials: {},
  });
  assert(!missingCreds.ok && missingCreds.retryable === false, 'missing credentials must fail safely');

  const missingTracking = await connector.confirmShipment({
    ...baseInput(),
    trackingNumber: '',
  });
  assert(!missingTracking.ok && /tracking/i.test(missingTracking.message ?? ''), 'missing tracking must fail safely');

  const missingLineItems = await connector.confirmShipment(baseInput({ rawOrder: { lineItems: [] } }));
  assert(!missingLineItems.ok && /line item/i.test(missingLineItems.message ?? ''), 'missing line items must fail safely');

  const calls: Array<{ url: string; body?: string }> = [];
  const success = await withMockFetch((url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/identity/v1/oauth2/token')) {
      return jsonResponse(200, { access_token: 'mock-access-token', expires_in: 7200 });
    }
    if (url.includes('/sell/fulfillment/v1/order/11-22222-33333/shipping_fulfillment')) {
      return new Response(null, {
        status: 201,
        headers: { location: 'https://api.sandbox.ebay.com/sell/fulfillment/v1/order/11-22222-33333/shipping_fulfillment/1Z999AA10123456784' },
      });
    }
    return jsonResponse(404, { errors: [{ message: 'unexpected mock call' }] });
  }, () => connector.confirmShipment(baseInput()));
  assert(success.ok, 'mocked eBay confirmation should succeed');
  assert(calls.length === 2, 'success path should call OAuth and fulfillment once each');
  const fulfillmentCall = calls.find((call) => call.url.includes('/shipping_fulfillment'));
  assert(fulfillmentCall?.body, 'fulfillment call must include a JSON body');
  const sent = JSON.parse(fulfillmentCall.body);
  assert(sent.lineItems?.[0]?.lineItemId === 'line-1', 'payload must include eBay line item id');
  assert(sent.shippingCarrierCode === 'UPS', 'payload must include carrier code');
  assert(sent.trackingNumber === '1Z999AA10123456784', 'payload must include tracking');

  const alreadyFulfilled = await withMockFetch((url) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return jsonResponse(200, { access_token: 'mock-access-token', expires_in: 7200 });
    }
    return jsonResponse(409, { errors: [{ message: 'Maximum tracking number for order is exceeded because this order is already fulfilled' }] });
  }, () => connector.confirmShipment(baseInput()));
  assert(alreadyFulfilled.ok, 'already-fulfilled/idempotent conflict should be treated as safe success');

  const retryable = await withMockFetch((url) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return jsonResponse(200, { access_token: 'mock-access-token', expires_in: 7200 });
    }
    return jsonResponse(500, { errors: [{ message: 'temporary eBay outage' }] });
  }, () => connector.confirmShipment(baseInput()));
  assert(!retryable.ok && retryable.retryable === true, '5xx fulfillment failure must be retryable');

  console.log('ebay confirmation mocked guard passed');
}

run().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
