import { readFileSync } from 'node:fs';
import { buildWalmartShipmentConfirmationBody, createWalmartStoreConnector } from '../src/connectors/store/walmart';

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

function assertWalmartLineSelection() {
  const body = buildWalmartShipmentConfirmationBody({
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
        {
          lineNumber: '2',
          orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '2' },
          orderLineStatuses: {
            orderLineStatus: [
              { status: 'Created', statusQuantity: { unitOfMeasurement: 'EACH', amount: '2' } },
            ],
          },
        },
        {
          lineNumber: '3',
          orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
          orderLineStatuses: {
            orderLineStatus: [
              { status: 'Cancelled', statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' } },
            ],
          },
        },
      ],
    },
  }, {
    carrierName: 'FedEx',
    methodCode: 'VALUE',
    shipDateTime: 1779408000000,
    trackingNumber: '381526072689',
    trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr=381526072689',
  });

  const lines = body.orderShipment.orderLines.orderLine;
  assert(lines.length === 2, 'multi-line payload must include only shippable non-cancelled Walmart lines');
  assert(lines.map((line) => line.lineNumber).join(',') === '1,2', 'payload must preserve all shippable Walmart line numbers and exclude cancelled lines');
  const secondTracking = (lines[1] as any).orderLineStatuses?.orderLineStatus?.[0]?.trackingInfo;
  assert(secondTracking?.trackingNumber === '381526072689', 'payload must include tracking for every shippable Walmart line');
}

function assertLiveRetryCommandSafety() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert(
    pkg.scripts?.['marketplace:confirm:retry'] === 'tsx scripts/retry-marketplace-confirmation.ts',
    'package.json must expose marketplace:confirm:retry',
  );

  const retryScript = readFileSync('scripts/retry-marketplace-confirmation.ts', 'utf8');
  const outboxService = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
  assert(retryScript.includes('--live-approved'), 'live retry command must require --live-approved');
  assert(retryScript.includes('--outbox-id'), 'live retry command must require an exact --outbox-id');
  assert(retryScript.includes("provider !== 'walmart'"), 'live retry command must be scoped to Walmart only');
  assert(retryScript.includes('missing Walmart order line numbers'), 'live retry command must refuse payloads without Walmart line numbers');
  assert(retryScript.includes('dryRun'), 'live retry command must support dry-run inspection');
  assert(retryScript.includes('processFulfillmentOutboxById'), 'live retry command must process one exact outbox row');
  assert(
    outboxService.includes('payload.storeAccountId ?? payload.sourceAccountId ?? payload.marketplaceAccountId ?? payload.carrierAccountId'),
    'Walmart outbox credential lookup must honor carrierAccountId from label payload',
  );
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
  assertWalmartLineSelection();
  assertLiveRetryCommandSafety();

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
  assert(!body.orderLines, 'shipping update body must not send top-level orderLines for the strict shippingUpdates schema');
  const line = body.orderShipment?.orderLines?.orderLine?.[0];
  assert(line?.lineNumber === '1', 'payload must include Walmart order line number');
  const status = line?.orderLineStatuses?.orderLineStatus?.[0];
  assert(status?.status === 'Shipped', 'payload must mark Walmart line status as Shipped');
  assert(status?.statusQuantity?.amount === '1', 'payload must include shipped quantity');
  assert(status?.trackingInfo?.trackingNumber === '381526072689', 'payload must include tracking number');
  assert(status?.trackingInfo?.carrierName?.carrier === 'FedEx', 'payload must use Walmart carrierName object');
  assert(typeof status?.trackingInfo?.shipDateTime === 'number', 'payload must send Walmart shipDateTime as epoch milliseconds');
  assert(status?.trackingInfo?.methodCode === 'Standard', 'payload must preserve Walmart shipping method');
  assert(!shipCall.body.includes('client-secret'), 'payload must not leak credentials');

  const multilineCalls: Array<{ url: string; body?: string }> = [];
  const multiline = await withMockFetch((url, init) => {
    multilineCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/v3/token')) {
      return jsonResponse(200, { access_token: 'mock-walmart-token' });
    }
    if (url.includes('/v3/orders/129114381893181/shipping')) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: [{ description: 'unexpected mock call' }] });
  }, () => connector.confirmShipment({
    orderId: 1057590,
    shipmentId: 24545,
    externalOrderId: 'walmart-129114381893181',
    clientId: 10,
    orderNumber: '200014621589900',
    trackingNumber: '381526072690',
    carrierCode: 'FedEx',
    shipDate: '2026-05-23T00:36:02.850Z',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      serviceName: 'Walmart Marketplace',
    },
    payload: {
      purchaseOrderId: '129114381893181',
      carrierName: 'FedEx',
      rawOrder: {
        shippingInfo: { methodCode: 'Standard' },
        orderLines: {
          orderLine: [
            {
              lineNumber: '1',
              orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
              orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged', statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' } }] },
            },
            {
              lineNumber: '2',
              orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '2' },
              orderLineStatuses: { orderLineStatus: [{ status: 'Created', statusQuantity: { unitOfMeasurement: 'EACH', amount: '2' } }] },
            },
            {
              lineNumber: '3',
              orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
              orderLineStatuses: { orderLineStatus: [{ status: 'Cancelled', statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' } }] },
            },
          ],
        },
      },
    },
  }));
  assert(multiline.ok, 'mocked multiline Walmart confirmation should succeed');
  const multilineShipCall = multilineCalls.find((call) => call.url.includes('/v3/orders/129114381893181/shipping'));
  assert(multilineShipCall?.body, 'multiline ship-confirm call must include a body');
  const multilineBody = JSON.parse(multilineShipCall.body);
  const multilineNumbers = multilineBody.orderShipment.orderLines.orderLine.map((line: { lineNumber: string }) => line.lineNumber);
  assert(JSON.stringify(multilineNumbers) === JSON.stringify(['1', '2']), 'payload must include all non-cancelled Walmart line numbers and exclude cancelled lines');
  const secondLineTracking = multilineBody.orderShipment.orderLines.orderLine[1].orderLineStatuses.orderLineStatus[0].trackingInfo;
  assert(secondLineTracking.trackingNumber === '381526072690', 'payload must include tracking on every shippable Walmart line');

  const missingLinesCalls: Array<string> = [];
  const missingLines = await withMockFetch((url) => {
    missingLinesCalls.push(url);
    if (url.includes('/v3/token')) {
      return jsonResponse(200, { access_token: 'mock-walmart-token' });
    }
    if (url.includes('/shipping')) {
      return jsonResponse(500, { error: [{ description: 'shipping should not be called without real Walmart line numbers' }] });
    }
    return jsonResponse(404, { error: [{ description: 'unexpected mock call' }] });
  }, () => connector.confirmShipment({
    orderId: 1057591,
    shipmentId: 24546,
    externalOrderId: 'walmart-129114381893181',
    clientId: 10,
    orderNumber: '200014621589901',
    trackingNumber: '381526072691',
    carrierCode: 'FedEx',
    shipDate: '2026-05-23T00:36:02.850Z',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      serviceName: 'Walmart Marketplace',
    },
    payload: {
      purchaseOrderId: '129114381893181',
      carrierName: 'FedEx',
      rawOrder: {
        shippingInfo: { methodCode: 'Standard' },
      },
    },
  }));
  assert(!missingLines.ok && missingLines.retryable === false, 'missing Walmart line numbers must fail safely');
  assert(/line/i.test(missingLines.message ?? ''), 'missing line-number failure must be clear');
  assert(!missingLinesCalls.some((url) => url.includes('/shipping')), 'connector must not call Walmart shipping without real line numbers');

  const missingTracking = await connector.confirmShipment({
    orderId: 1057592,
    shipmentId: 24547,
    externalOrderId: 'walmart-129114381893181',
    clientId: 10,
    orderNumber: '200014621589902',
    trackingNumber: '',
    carrierCode: 'FedEx',
    shipDate: '2026-05-23T00:36:02.850Z',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      serviceName: 'Walmart Marketplace',
    },
    payload: {
      purchaseOrderId: '129114381893181',
      carrierName: 'FedEx',
      rawOrder: {
        shippingInfo: { methodCode: 'Standard' },
        orderLines: { orderLine: [{ lineNumber: '1' }] },
      },
    },
  });
  assert(!missingTracking.ok && missingTracking.retryable === false, 'missing tracking number must fail safely');
  assert(/tracking/i.test(missingTracking.message ?? ''), 'missing tracking failure must be clear');

  const missingPurchaseOrder = await connector.confirmShipment({
    orderId: 1057593,
    shipmentId: 24548,
    externalOrderId: '288420079',
    clientId: 10,
    orderNumber: '200014621589903',
    trackingNumber: '381526072692',
    carrierCode: 'FedEx',
    shipDate: '2026-05-23T00:36:02.850Z',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      serviceName: 'Walmart Marketplace',
    },
    payload: {
      carrierName: 'FedEx',
      rawOrder: {
        shippingInfo: { methodCode: 'Standard' },
        orderLines: { orderLine: [{ lineNumber: '1' }] },
      },
    },
  });
  assert(!missingPurchaseOrder.ok && missingPurchaseOrder.retryable === false, 'missing purchaseOrderId must fail safely');
  assert(/purchaseOrderId/i.test(missingPurchaseOrder.message ?? ''), 'missing purchaseOrderId failure must be clear');

  console.log('walmart confirmation payload guard passed');
}

run().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
