/**
 * PS-289 - multi-package carrier adapter boundary guard.
 *
 * Proves per-package label purchase can be wired to an injected carrier label
 * creator without importing direct provider modules or buying live postage by default.
 */
import { readFileSync } from 'node:fs';
import { purchaseMultiPackageLabels } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  createMultiPackageCarrierLabelPurchaser,
  type MultiPackageCarrierLabelCreateRequest,
} from '../src/services/shipping-workflow/multi-package-carrier-adapter';
import { buildMultiPackageShipmentPlan } from '../src/services/shipping-workflow/multi-package-shipment-plan';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const plan = buildMultiPackageShipmentPlan({
  orderId: 28913,
  orderNumber: 'PS-289-CARRIER',
  packages: [
    {
      packageKey: 'left-box',
      weightOz: 19,
      dimensions: { length: 10, width: 8, height: 4 },
      items: [{ sku: 'LEFT-CARRIER', quantity: 1 }],
    },
    {
      packageKey: 'right-box',
      weightOz: 27,
      dimensions: { length: 14, width: 9, height: 5 },
      items: [{ sku: 'RIGHT-CARRIER', quantity: 3 }],
    },
  ],
});

const requests: MultiPackageCarrierLabelCreateRequest[] = [];
const purchaser = createMultiPackageCarrierLabelPurchaser({
  provider: 'shipstation',
  carrierAccountId: 'carrier-account-ps-289',
  shipFrom: {
    name: 'GWH Fulfillment Center',
    postalCode: '90248',
    country: 'US',
  },
  shipTo: {
    name: 'Carrier Adapter Test',
    postalCode: '10001',
    country: 'US',
    residential: true,
  },
  createLabel: async (request) => {
    requests.push(request);
    return {
      labelIdempotencyKey: request.labelIdempotencyKey,
      shipmentId: 10100 + request.packageSequence,
      trackingNumber: `1ZCARRIER${request.packageSequence}`,
      labelUrl: `mock://carrier-adapter/${request.packageKey}`,
      provider: request.provider,
      postageCost: request.packageSequence === 1 ? 9.25 : 11.75,
      isLivePostage: false,
    };
  },
});

const flow = await purchaseMultiPackageLabels(plan, {
  clientId: 93,
  serviceLabel: 'UPS Ground',
  purchaser,
});

check('carrier adapter calls injected carrier label creator once per package',
  requests.length === 2 && flow.labels.length === 2);
check('carrier adapter requests preserve package order and idempotency',
  requests[0]?.labelIdempotencyKey === 'order:28913:package:left-box' &&
    requests[1]?.labelIdempotencyKey === 'order:28913:package:right-box' &&
    requests[1]?.packageSequence === 2);
check('carrier adapter requests carry carrier account and provider identity',
  requests.every((request) =>
    request.provider === 'shipstation' &&
    request.carrierAccountId === 'carrier-account-ps-289' &&
    request.serviceLabel === 'UPS Ground'));
check('carrier adapter requests carry package shipping facts',
  requests[1]?.weightOz === 27 &&
    requests[1]?.dimensions.length === 14 &&
    requests[1]?.items[0]?.sku === 'RIGHT-CARRIER' &&
    requests[1]?.items[0]?.quantity === 3);
check('carrier adapter requests carry explicit ship-from and ship-to context',
  requests[0]?.shipFrom.postalCode === '90248' &&
    requests[0]?.shipTo.postalCode === '10001' &&
    requests[0]?.shipTo.residential === true);
check('carrier adapter results map back into purchase flow labels',
  flow.labels[1]?.shipmentId === 10102 &&
    flow.labels[1]?.trackingNumber === '1ZCARRIER2' &&
    flow.labels[1]?.labelUrl === 'mock://carrier-adapter/right-box' &&
    flow.labels[1]?.provider === 'shipstation');
check('carrier adapter keeps live postage blocked by the purchase boundary by default',
  flow.labels.every((label) => label.isLivePostage === false));

let missingCreatorBlocked = false;
try {
  createMultiPackageCarrierLabelPurchaser({
    provider: 'shipstation',
    carrierAccountId: 'carrier-account-ps-289',
    shipFrom: { postalCode: '90248', country: 'US' },
    shipTo: { postalCode: '10001', country: 'US' },
  } as never);
} catch (err) {
  missingCreatorBlocked = /requires an injected carrier label creator/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('carrier adapter refuses to run without injected carrier label creator', missingCreatorBlocked);

let liveBlocked = false;
const livePurchaser = createMultiPackageCarrierLabelPurchaser({
  provider: 'shipstation',
  carrierAccountId: 'carrier-account-ps-289',
  shipFrom: { postalCode: '90248', country: 'US' },
  shipTo: { postalCode: '10001', country: 'US' },
  createLabel: async (request) => ({
    labelIdempotencyKey: request.labelIdempotencyKey,
    shipmentId: 10200 + request.packageSequence,
    trackingNumber: `1ZLIVE${request.packageSequence}`,
    labelUrl: `mock://live/${request.packageKey}`,
    provider: request.provider,
    postageCost: 10,
    isLivePostage: true,
  }),
});
try {
  await purchaseMultiPackageLabels(plan, {
    clientId: 93,
    serviceLabel: 'UPS Ground',
    purchaser: livePurchaser,
  });
} catch (err) {
  liveBlocked = /Live multi-package postage requires explicit approval/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('live carrier adapter result stays blocked unless caller explicitly approves live postage', liveBlocked);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-carrier-adapter.ts', 'utf8');
check('carrier adapter exports createMultiPackageCarrierLabelPurchaser',
  /export function createMultiPackageCarrierLabelPurchaser/.test(ownerSrc));
check('carrier adapter documents injected-only carrier behavior',
  /No provider module imports, default provider calls, live postage, print queue writes, marketplace API calls, or shipped\/cancelled mutation/.test(ownerSrc));
check('carrier adapter has no direct provider, route, queue, marketplace, order, or shipment imports',
  !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 carrier adapter guard',
  packageJson.includes('"test:ps-289-multi-package-carrier-adapter"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package carrier adapter guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package carrier adapter guard');
