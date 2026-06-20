/**
 * PS-289 - multi-package ShipStation adapter guard.
 *
 * Proves each planned package can become one ShipStation-shaped label request
 * through an injected creator without calling ShipStation or buying postage.
 */
import { readFileSync } from 'node:fs';
import { purchaseMultiPackageLabels } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  createShipStationMultiPackageLabelPurchaser,
  type ShipStationMultiPackageLabelCreateContext,
} from '../src/services/shipping-workflow/multi-package-shipstation-adapter';
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
  orderId: 28914,
  orderNumber: 'PS-289-SS',
  packages: [
    {
      packageKey: 'front-box',
      weightOz: 21,
      dimensions: { length: 10, width: 8, height: 4 },
      items: [{ sku: 'FRONT-SS', quantity: 1 }],
    },
    {
      packageKey: 'back-box',
      weightOz: 34,
      dimensions: { length: 16, width: 11, height: 6 },
      items: [{ sku: 'BACK-SS', quantity: 2 }],
    },
  ],
});

const contexts: ShipStationMultiPackageLabelCreateContext[] = [];
const purchaser = createShipStationMultiPackageLabelPurchaser({
  apiKeyV2: 'test-api-key',
  carrierId: 'se-607855',
  serviceCode: 'ups_ground',
  packageCode: 'package',
  shipFrom: {
    name: 'GWH Fulfillment Center',
    address1: '1501 Knox St',
    city: 'Gardena',
    state: 'CA',
    postalCode: '90248',
    country: 'US',
    phone: '310-555-0100',
  },
  shipTo: {
    name: 'ShipStation Adapter Test',
    address1: '10 Main St',
    city: 'New York',
    state: 'NY',
    postalCode: '10001',
    country: 'US',
    phone: '212-555-0100',
    residential: false,
  },
  confirmation: 'delivery',
  insuranceProvider: 'carrier',
  insuredValue: 100,
  createLabel: async (context) => {
    contexts.push(context);
    return {
      shipmentId: 11100 + context.request.packageSequence,
      trackingNumber: `1ZSS${context.request.packageSequence}`,
      labelUrl: `mock://shipstation-multi-package/${context.request.packageKey}`,
      cost: context.request.packageSequence === 1 ? 8.1 : 12.35,
      isLivePostage: false,
    };
  },
});

const flow = await purchaseMultiPackageLabels(plan, {
  clientId: 94,
  serviceLabel: 'UPS Ground',
  purchaser,
});

check('ShipStation adapter calls injected creator once per package',
  contexts.length === 2 && flow.labels.length === 2);
check('ShipStation adapter preserves package order and idempotency',
  contexts[0]?.request.labelIdempotencyKey === 'order:28914:package:front-box' &&
    contexts[1]?.request.labelIdempotencyKey === 'order:28914:package:back-box' &&
    contexts[1]?.request.packageSequence === 2);
check('ShipStation label input carries account, service, package, and order facts',
  contexts[0]?.labelInput.apiKeyV2 === 'test-api-key' &&
    contexts[0]?.labelInput.carrierId === 'se-607855' &&
    contexts[0]?.labelInput.serviceCode === 'ups_ground' &&
    contexts[0]?.labelInput.packageCode === 'package' &&
    contexts[0]?.labelInput.orderNumber === 'PS-289-SS');
check('ShipStation label input carries per-package weight and dimensions',
  contexts[1]?.labelInput.weightOz === 34 &&
    contexts[1]?.labelInput.length === 16 &&
    contexts[1]?.labelInput.width === 11 &&
    contexts[1]?.labelInput.height === 6);
check('ShipStation request body emits one package for the current package only',
  contexts.every((context) => context.requestBody.shipment.packages.length === 1) &&
    contexts[0]?.requestBody.shipment.packages[0]?.weight.value === 21 &&
    contexts[1]?.requestBody.shipment.packages[0]?.weight.value === 34);
check('ShipStation request body carries package-level insured value',
  contexts[0]?.requestBody.shipment.packages[0]?.insured_value?.amount === 100 &&
    contexts[0]?.requestBody.shipment.packages[0]?.insured_value?.currency === 'usd' &&
    contexts[0]?.requestBody.shipment.insurance_provider === 'carrier');
check('ShipStation request body carries residential verdict and confirmation',
  contexts[0]?.requestBody.shipment.ship_to.address_residential_indicator === 'no' &&
    contexts[0]?.requestBody.shipment.confirmation === 'delivery');
check('ShipStation adapter results map back to package purchase labels',
  flow.labels[1]?.shipmentId === 11102 &&
    flow.labels[1]?.trackingNumber === '1ZSS2' &&
    flow.labels[1]?.labelUrl === 'mock://shipstation-multi-package/back-box' &&
    flow.labels[1]?.provider === 'shipstation' &&
    flow.totalPostageCost === 20.45);
check('ShipStation adapter remains non-live unless injected result says otherwise',
  flow.labels.every((label) => label.isLivePostage === false));

let syntheticBlocked = false;
try {
  const blockedPurchaser = createShipStationMultiPackageLabelPurchaser({
    carrierId: 'se-10000025',
    serviceCode: 'ups_ground',
    packageCode: 'package',
    shipFrom: { postalCode: '90248', country: 'US' },
    shipTo: { postalCode: '10001', country: 'US' },
    createLabel: async () => {
      throw new Error('should not call injected creator for synthetic carrier id');
    },
  });
  await purchaseMultiPackageLabels(plan, {
    clientId: 94,
    serviceLabel: 'UPS Ground',
    purchaser: blockedPurchaser,
  });
} catch (err) {
  syntheticBlocked = /Direct-carrier account id 10000025 cannot be sent to ShipStation/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('ShipStation adapter blocks synthetic direct-carrier account ids before injected creator',
  syntheticBlocked);

let missingCreatorBlocked = false;
try {
  createShipStationMultiPackageLabelPurchaser({
    carrierId: 'se-607855',
    serviceCode: 'ups_ground',
    packageCode: 'package',
    shipFrom: { postalCode: '90248', country: 'US' },
    shipTo: { postalCode: '10001', country: 'US' },
  } as never);
} catch (err) {
  missingCreatorBlocked = /requires an injected ShipStation label creator/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('ShipStation adapter refuses to run without injected creator',
  missingCreatorBlocked);

const ownerSrc = readFileSync(
  'src/services/shipping-workflow/multi-package-shipstation-adapter.ts',
  'utf8',
);
check('ShipStation adapter exports createShipStationMultiPackageLabelPurchaser',
  /export function createShipStationMultiPackageLabelPurchaser/.test(ownerSrc));
check('ShipStation adapter uses the existing pure ShipStation label request builder',
  /buildSsLabelRequestBody/.test(ownerSrc));
check('ShipStation adapter documents no ShipStation network call or live side effects',
  /No ShipStation network call, default live postage, print queue writes, marketplace API calls, or shipped\/cancelled mutation/.test(ownerSrc));
check('ShipStation adapter does not import network label creator or mutation paths',
  !/ssCreateLabel|ssRequest|ssV1Request|from ['"].*(routes|connector|print-queue|marketplace|orders|shipments)/i.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 ShipStation adapter guard',
  packageJson.includes('"test:ps-289-multi-package-shipstation-adapter"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package ShipStation adapter guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package ShipStation adapter guard');
