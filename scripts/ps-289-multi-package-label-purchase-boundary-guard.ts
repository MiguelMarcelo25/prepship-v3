/**
 * PS-289 - per-package label purchase boundary guard.
 *
 * Proves the real purchase owner can be exercised with an injected purchaser
 * while default behavior still refuses live postage or provider calls.
 */
import { readFileSync } from 'node:fs';
import {
  purchaseMultiPackageLabels,
  type MultiPackageLabelPurchaseRequest,
} from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
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
  orderId: 28909,
  orderNumber: 'PS-289-LABEL',
  packages: [
    {
      packageKey: 'box-a',
      weightOz: 14,
      dimensions: { length: 9, width: 6, height: 4 },
      items: [{ sku: 'BOX-A-SKU', quantity: 1 }],
    },
    {
      packageKey: 'box-b',
      weightOz: 22,
      dimensions: { length: 12, width: 8, height: 5 },
      items: [{ sku: 'BOX-B-SKU', quantity: 2 }],
    },
  ],
});

const requests: MultiPackageLabelPurchaseRequest[] = [];
const flow = await purchaseMultiPackageLabels(plan, {
  clientId: 77,
  serviceLabel: 'UPS Ground',
  purchaser: async (request) => {
    requests.push(request);
    return {
      labelIdempotencyKey: request.labelIdempotencyKey,
      shipmentId: 900000 + request.packageSequence,
      trackingNumber: `1ZPS289${request.packageSequence}`,
      labelUrl: `mock://purchased-label/${request.packageKey}`,
      provider: 'injected_test_purchaser',
      postageCost: request.packageSequence === 1 ? 4.25 : 6.75,
      isLivePostage: false,
    };
  },
});

check('purchase boundary calls the injected purchaser once per package in order',
  requests.length === 2 &&
    requests[0]?.packageKey === 'box-a' &&
    requests[1]?.packageKey === 'box-b');
check('purchase requests carry package idempotency and group identity',
  requests[0]?.labelIdempotencyKey === 'order:28909:package:box-a' &&
    requests[1]?.labelIdempotencyKey === 'order:28909:package:box-b' &&
    requests.every((request) => request.shipmentGroupKey === 'order:28909'));
check('purchase requests carry shipping package facts to the injected purchaser',
  requests[1]?.weightOz === 22 &&
    requests[1]?.dimensions.length === 12 &&
    requests[1]?.items[0]?.sku === 'BOX-B-SKU' &&
    requests[1]?.items[0]?.quantity === 2);
check('purchase requests carry account-safe order metadata',
  requests.every((request) =>
    request.orderId === 28909 &&
    request.clientId === 77 &&
    request.orderNumber === 'PS-289-LABEL' &&
    request.serviceLabel === 'UPS Ground'));
check('purchase flow returns one purchased label per package',
  flow.labels.length === 2 &&
    flow.group.status === 'labels_purchased' &&
    flow.group.packageCount === 2);
check('purchased labels preserve package identity and purchaser results',
  flow.labels[1]?.labelIdempotencyKey === 'order:28909:package:box-b' &&
    flow.labels[1]?.packageSequence === 2 &&
    flow.labels[1]?.shipmentId === 900002 &&
    flow.labels[1]?.trackingNumber === '1ZPS2892' &&
    flow.labels[1]?.labelUrl === 'mock://purchased-label/box-b');
check('purchase flow totals postage without making live postage itself',
  flow.totalPostageCost === 11 &&
    flow.labels.every((label) =>
      label.provider === 'injected_test_purchaser' &&
      label.isLivePostage === false));

let missingPurchaserBlocked = false;
try {
  await purchaseMultiPackageLabels(plan);
} catch (err) {
  missingPurchaserBlocked = /requires an explicit purchaser dependency/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('default purchase boundary refuses to buy labels without injected purchaser', missingPurchaserBlocked);

let duplicateBlockedBeforeCall = false;
let duplicateCallCount = 0;
try {
  await purchaseMultiPackageLabels(plan, {
    existingLabelIdempotencyKeys: ['order:28909:package:box-b'],
    purchaser: async (request) => {
      duplicateCallCount += 1;
      return {
        labelIdempotencyKey: request.labelIdempotencyKey,
        shipmentId: 1,
        trackingNumber: 'TRACK',
        labelUrl: 'mock://label',
        provider: 'should_not_call',
        postageCost: 0,
        isLivePostage: false,
      };
    },
  });
} catch (err) {
  duplicateBlockedBeforeCall = /already has a purchased label/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('existing package label idempotency blocks before purchaser call',
  duplicateBlockedBeforeCall && duplicateCallCount === 0);

let mismatchedResultBlocked = false;
try {
  await purchaseMultiPackageLabels(plan, {
    purchaser: async (request) => ({
      labelIdempotencyKey: `${request.labelIdempotencyKey}:wrong`,
      shipmentId: 1,
      trackingNumber: 'TRACK',
      labelUrl: 'mock://label',
      provider: 'bad_purchaser',
      postageCost: 0,
      isLivePostage: false,
    }),
  });
} catch (err) {
  mismatchedResultBlocked = /returned a mismatched label idempotency key/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('purchaser result must match the requested package idempotency key', mismatchedResultBlocked);

let liveBlocked = false;
try {
  await purchaseMultiPackageLabels(plan, {
    purchaser: async (request) => ({
      labelIdempotencyKey: request.labelIdempotencyKey,
      shipmentId: 1,
      trackingNumber: 'TRACK',
      labelUrl: 'https://carrier.example/label.pdf',
      provider: 'live_like_purchaser',
      postageCost: 5,
      isLivePostage: true,
    }),
  });
} catch (err) {
  liveBlocked = /Live multi-package postage requires explicit approval/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('live postage result is blocked by default even with an injected purchaser', liveBlocked);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-label-purchase-boundary.ts', 'utf8');
check('label purchase boundary owner exports purchaseMultiPackageLabels',
  /export async function purchaseMultiPackageLabels/.test(ownerSrc));
check('label purchase boundary owner documents no default live purchase path',
  /No default provider calls, live postage, print queue writes, marketplace API calls, or shipped\/cancelled mutation/.test(ownerSrc));
check('label purchase boundary owner has no provider, DB, route, queue, marketplace, or shipped imports',
  !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 label purchase boundary guard',
  packageJson.includes('"test:ps-289-multi-package-label-purchase-boundary"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package label purchase boundary guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package label purchase boundary guard');
