import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupWalmartOrderByCustomerOrderId, buildWalmartShipmentConfirmationBody } from '../src/connectors/store/walmart';
import { __test_extractWalmartLabelReference } from '../src/connectors/carrier/walmart-shipping';

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
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

async function assertWalmartPoLookupRequiresExactCustomerOrderId() {
  const noExact = await withMockFetch((url) => {
    if (url.includes('/v3/token')) {
      return jsonResponse(200, { access_token: 'mock-token' });
    }
    if (url.includes('/v3/orders')) {
      return jsonResponse(200, {
        list: {
          elements: {
            order: [
              { customerOrderId: '200014620000000', purchaseOrderId: '129114380000000' },
              { customerOrderId: '200014621111111', purchaseOrderId: '129114381111111' },
            ],
          },
        },
      });
    }
    return jsonResponse(404, { error: [{ description: 'unexpected mock call' }] });
  }, () => lookupWalmartOrderByCustomerOrderId(
    { clientId: 'client-id', clientSecret: 'client-secret' },
    '200014621589900',
  ));

  assert.equal(
    noExact,
    null,
    'Walmart PO lookup must return null when no returned order exactly matches the requested customerOrderId',
  );

  const exact = await withMockFetch((url) => {
    if (url.includes('/v3/token')) {
      return jsonResponse(200, { access_token: 'mock-token' });
    }
    if (url.includes('/v3/orders')) {
      return jsonResponse(200, {
        list: {
          elements: {
            order: [
              { customerOrderId: '200014620000000', purchaseOrderId: '129114380000000' },
              {
                customerOrderId: '200014621589900',
                purchaseOrderId: '129114381893181',
                orderLines: { orderLine: [{ lineNumber: '1' }] },
              },
            ],
          },
        },
      });
    }
    return jsonResponse(404, { error: [{ description: 'unexpected mock call' }] });
  }, () => lookupWalmartOrderByCustomerOrderId(
    { clientId: 'client-id', clientSecret: 'client-secret' },
    '200014621589900',
  ));

  assert.equal(exact?.purchaseOrderId, '129114381893181', 'Walmart PO lookup must return the exact-match purchaseOrderId');
  assert.equal(exact?.rawOrder?.customerOrderId, '200014621589900', 'Walmart PO lookup raw order must be the exact requested customerOrderId');
}

function assertMockedLabelQueueAndConfirmationWorkflow() {
  const base64 = 'JVBERi0xLjQK'.repeat(12);
  const nestedLabel = __test_extractWalmartLabelReference({
    data: {
      labelResponse: {
        labels: [
          {
            labelData: {
              pdf: base64,
            },
          },
        ],
      },
    },
  }, 'base64');
  const queuedLabelValue = `data:application/pdf;base64,${nestedLabel.value}`;
  assert.equal(typeof queuedLabelValue, 'string', 'mocked queue label value must be a string');
  assert.match(queuedLabelValue, /^data:application\/pdf;base64,/, 'mocked queue label value must be a printable PDF data URL');
  assert.notEqual(queuedLabelValue, '[object Object]', 'mocked queue label value must not be an object-stringified payload');

  assert.throws(
    () => __test_extractWalmartLabelReference({ data: { labelData: { pdf: { href: 'https://example.test/label.pdf' } } } }, 'base64'),
    /data\.labelData\.pdf\.href:string_unsupported/,
    'unsupported object-shaped Walmart label payloads must fail before print queue insertion with an actionable sanitized error',
  );

  const body = buildWalmartShipmentConfirmationBody({
    shippingInfo: { methodCode: 'Standard' },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          orderLineQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
          orderLineStatuses: {
            orderLineStatus: [
              { status: 'Created', statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' } },
            ],
          },
        },
      ],
    },
  }, {
    carrierName: 'UPS',
    methodCode: 'Standard',
    shipDateTime: 1779408000000,
    trackingNumber: '1ZMOCKTRACK',
    trackingUrl: 'https://www.ups.com/track?tracknum=1ZMOCKTRACK',
  });

  const line = body.orderShipment.orderLines.orderLine[0] as any;
  const trackingInfo = line.orderLineStatuses.orderLineStatus[0].trackingInfo;
  assert.equal(line.lineNumber, '1', 'Walmart confirmation payload must carry the Walmart order line number');
  assert.equal(trackingInfo.trackingNumber, '1ZMOCKTRACK', 'Walmart confirmation payload must carry tracking');
  assert.equal(trackingInfo.carrierName.carrier, 'UPS', 'Walmart confirmation payload must use the Walmart carrierName object');
  assert.equal(trackingInfo.methodCode, 'Standard', 'Walmart confirmation payload must carry the marketplace method code');
}

function assertPrintQueueAndOutboxContracts() {
  const printQueue = readFileSync('src/services/print-queue.ts', 'utf8');
  // PS-209: api/carriers/labels.ts is a retired 410 stub. The v4 label owner
  // (src/services/labels.ts createLabelV2) now owns the confirmation/outbox
  // decoupling, with marketplace-GENERIC wording (no longer Walmart-specific).
  const labelsService = readFileSync('src/services/labels.ts', 'utf8');
  const walmartStore = readFileSync('src/connectors/store/walmart.ts', 'utf8');

  assert(
    !walmartStore.includes('?? elements[0]'),
    'shared Walmart PO lookup must not fall back to the first returned order',
  );
  assert(
    printQueue.includes('normalizePrintQueueLabelUrl'),
    'print queue must normalize and validate label values before queue insertion',
  );
  assert(
    printQueue.includes('[object Object]'),
    'print queue must reject object-stringified label values before queue insertion',
  );
  assert(
    printQueue.includes('let existingLabelUrl = await timeQueueStep(') &&
      printQueue.includes('() => findExistingQueueSendLabel(order)') &&
      printQueue.includes('const recoverCreatedLabelUrl = existingLabelUrl ?? await timeQueueStep(') &&
      printQueue.includes('await createLabelV2'),
    'print queue must recover by queueing an existing label instead of buying duplicate postage',
  );
  assert(
    // createLabelV2 queues the marketplace confirmation separately from the label
    // purchase: the enqueue is wrapped in try/catch and only warns (never rethrown)
    // and the outbox is processed in the background — a confirmation/outbox failure
    // can never fail a successful label. Now marketplace-generic, not Walmart-only.
    labelsService.includes('confirmation separately from label purchase') &&
      labelsService.includes("console.warn('[labels] marketplace confirmation enqueue failed:") &&
      labelsService.includes("timer.background('marketplace confirmation outbox'"),
    'Walmart label success must be decoupled from confirmation/outbox failures',
  );
}

async function run() {
  await assertWalmartPoLookupRequiresExactCustomerOrderId();
  assertMockedLabelQueueAndConfirmationWorkflow();
  assertPrintQueueAndOutboxContracts();
  console.log('PS-054 Walmart PO lookup and mocked label->queue->confirmation workflow guard passed');
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
