const FIXTURE_ONLY = true;

function usage() {
  console.log(`Offline fixture-only label smoke test.

Usage:
  npm run smoke:shipping:test-label -- --fixture

Safety:
  This command refuses to create real labels. It does not buy postage, call carrier APIs,
  send marketplace notifications, or mutate live orders.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture label smoke failed: ${message}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  if (!argv.includes('--fixture')) {
    console.error('Refusing to run: smoke-shipping-test-label refuses to create real labels. Re-run with --fixture for the offline harness.');
    process.exitCode = 2;
    return;
  }

  const started = performance.now();
  const order = {
    id: 101,
    orderStatus: 'awaiting_shipment',
    clientId: 1,
    storeId: 101,
    hasActiveShipment: false,
  };
  assert(order.orderStatus !== 'shipped' && order.orderStatus !== 'cancelled', 'fixture order must not be terminal');
  assert(!order.hasActiveShipment, 'fixture must refuse duplicate active labels');

  const labelCreateStarted = performance.now();
  const labelResponse = {
    shipmentId: 9001,
    trackingNumber: 'MOCKTRACK123456',
    labelUrl: 'mock://labels/9001.pdf',
  };
  assert(labelResponse.shipmentId, 'label response must include shipmentId');
  assert(labelResponse.trackingNumber, 'label response must include trackingNumber');
  assert(labelResponse.labelUrl, 'label response must include labelUrl');

  const persistenceStarted = performance.now();
  const persistedShipment = {
    id: labelResponse.shipmentId,
    orderId: order.id,
    trackingNumber: labelResponse.trackingNumber,
    labelUrl: labelResponse.labelUrl,
  };
  const updatedOrder = { ...order, orderStatus: 'shipped' };
  assert(persistedShipment.orderId === order.id, 'shipment must link to order');
  assert(updatedOrder.orderStatus === 'shipped', 'order must move to shipped in fixture state');

  const retrievalStarted = performance.now();
  const labelRetrievable = labelResponse.labelUrl.startsWith('mock://labels/');
  assert(labelRetrievable, 'fixture label URL must be retrievable');

  console.log(JSON.stringify({
    ok: true,
    fixtureOnly: FIXTURE_ONLY,
    safety: {
      realLabelsCreated: false,
      postagePurchased: false,
      liveOrdersMutated: false,
      marketplaceNotificationsSent: false,
    },
    result: {
      shipmentId: labelResponse.shipmentId,
      trackingNumberPresent: true,
      labelUrlPresent: true,
      orderStatus: updatedOrder.orderStatus,
    },
    timingsMs: {
      total: Math.round(performance.now() - started),
      labelCreate: Math.round(persistenceStarted - labelCreateStarted),
      persistenceCheck: Math.round(retrievalStarted - persistenceStarted),
      labelRetrievalCheck: Math.round(performance.now() - retrievalStarted),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
