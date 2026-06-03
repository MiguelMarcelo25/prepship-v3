import { createShipStationStoreConnector } from '../src/connectors/store/shipstation';

// PS-078 req 6/11 — ShipStation-SOURCE order shipped via a DIRECT carrier
// (Shipp / UPS / EasyPost / Walmart Shipping) must still be confirmed THROUGH
// ShipStation, telling ShipStation the EXTERNAL carrier + tracking and asking it
// to notify the upstream sales channel. This proves the confirmation owner is
// the source (ShipStation), not the carrier.
//
// Fully offline: globalThis.fetch is mocked to capture the /orders/markasshipped
// payload. NO real ShipStation call, no postage, no marketplace notification, no
// real order is touched. Fake ids/tracking only.

const originalFetch = globalThis.fetch;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PS-078 ShipStation direct-carrier confirm guard failed: ${message}`);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Captured = { url: string; body?: string };

async function withMockFetch<T>(
  capture: Captured[],
  run: () => Promise<T>,
): Promise<T> {
  globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const textUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : String(url);
    capture.push({ url: textUrl, body: typeof init?.body === 'string' ? init.body : undefined });
    if (textUrl.includes('/orders/markasshipped')) return jsonResponse(200, { orderId: 1 });
    return jsonResponse(404, { error: 'unexpected mock call' });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function confirmDirectCarrier(opts: {
  externalOrderId: string | null;
  carrierCode: string;
  trackingNumber: string;
  notifyMarketplace?: boolean;
}) {
  const connector = createShipStationStoreConnector();
  const capture: Captured[] = [];
  const result = await withMockFetch(capture, () =>
    connector.confirmShipment({
      orderId: 555001,
      shipmentId: 778001,
      externalOrderId: opts.externalOrderId,
      clientId: 7,
      orderNumber: 'TEST-ORDER-1',
      trackingNumber: opts.trackingNumber,
      carrierCode: opts.carrierCode,
      shipDate: '2026-06-04',
      ...(opts.notifyMarketplace === undefined ? {} : { notifyMarketplace: opts.notifyMarketplace }),
      credentials: { apiKey: 'mock-key', apiSecret: 'mock-secret' },
      payload: {},
    } as never),
  );
  const markCall = capture.find((c) => c.url.includes('/orders/markasshipped'));
  return { result, markCall, capture };
}

async function run() {
  // ── Each direct carrier confirms via ShipStation with EXTERNAL tracking ─────
  for (const carrier of ['shipp', 'ups', 'easypost', 'walmart_shipping'] as const) {
    const tracking = `EXT-${carrier}-99887766`;
    const { result, markCall } = await confirmDirectCarrier({
      externalOrderId: '987654', // numeric upstream ShipStation order id
      carrierCode: carrier,
      trackingNumber: tracking,
    });
    assert((result as { ok: boolean }).ok, `${carrier}: ShipStation confirmation should succeed`);
    assert(markCall?.body, `${carrier}: must POST /orders/markasshipped`);
    const body = JSON.parse(markCall.body!);
    assert(body.orderId === 987654, `${carrier}: must mark the upstream ShipStation order id`);
    assert(body.carrierCode === carrier, `${carrier}: must send the EXTERNAL direct carrier code (not a ShipStation carrier)`);
    assert(body.trackingNumber === tracking, `${carrier}: must send the EXTERNAL direct tracking number`);
    assert(body.notifySalesChannel === true, `${carrier}: must notify the sales channel (close the marketplace loop) by default`);
    assert(!markCall.body!.includes('mock-secret'), `${carrier}: must not leak credentials in the payload`);
    console.log(`ok   ShipStation-source + direct ${carrier}: markasshipped carries external carrier+tracking, notifySalesChannel=true`);
  }

  // ── notifyMarketplace=false is honored (no forced notification) ─────────────
  {
    const { markCall } = await confirmDirectCarrier({
      externalOrderId: '987654',
      carrierCode: 'ups',
      trackingNumber: 'EXT-ups-1',
      notifyMarketplace: false,
    });
    const body = JSON.parse(markCall!.body!);
    assert(body.notifySalesChannel === false, 'explicit notifyMarketplace=false must be honored');
    console.log('ok   explicit notifyMarketplace=false is honored');
  }

  // ── A non-ShipStation external id is rejected safely (no real call) ─────────
  {
    const capture: Captured[] = [];
    const connector = createShipStationStoreConnector();
    const result = await withMockFetch(capture, () =>
      connector.confirmShipment({
        orderId: 555002,
        shipmentId: 778002,
        externalOrderId: 'walmart-129114381653217', // not a ShipStation numeric id
        clientId: 7,
        orderNumber: 'TEST-ORDER-2',
        trackingNumber: 'EXT-ups-2',
        carrierCode: 'ups',
        shipDate: '2026-06-04',
        credentials: { apiKey: 'mock-key', apiSecret: 'mock-secret' },
        payload: {},
      } as never),
    );
    assert(!(result as { ok: boolean }).ok, 'non-ShipStation external id must not confirm via ShipStation');
    assert(!capture.some((c) => c.url.includes('/orders/markasshipped')), 'must NOT call ShipStation for a non-ShipStation id');
    console.log('ok   non-ShipStation external id is rejected without any ShipStation call');
  }

  console.log('\nPASS PS-078 ShipStation-source + direct-carrier confirmation guard');
}

run().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
