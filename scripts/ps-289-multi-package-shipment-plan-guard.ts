/**
 * PS-289 - multi-package shipment group planning guard.
 *
 * This first slice is intentionally pure and offline. It establishes the
 * backend-owned package-group planner before any label purchase, print queue,
 * marketplace confirmation, or production data mutation work begins.
 *
 *   npx tsx scripts/ps-289-multi-package-shipment-plan-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildMultiPackageShipmentPlan,
  multiPackageLabelIdempotencyKey,
} from '../src/services/shipping-workflow/multi-package-shipment-plan';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const plan = buildMultiPackageShipmentPlan({
  orderId: 28901,
  orderNumber: 'PS-289-A',
  packages: [
    {
      packageKey: 'box-a',
      weightOz: 16,
      dimensions: { length: 12, width: 10, height: 3 },
      items: [{ sku: 'A', quantity: 1 }],
    },
    {
      packageKey: 'box-b',
      weightOz: 24,
      dimensions: { length: 8, width: 6, height: 4 },
      items: [{ sku: 'B', quantity: 2 }],
    },
  ],
});

check('planner marks a two-package order as multi-package', plan.mode === 'multi_package');
check('planner creates a stable shipment group key from the order id',
  plan.shipmentGroupKey === 'order:28901');
check('planner preserves package count', plan.packageCount === 2 && plan.packages.length === 2);
check('planner assigns 1-based package sequence values',
  plan.packages[0]?.packageSequence === 1 && plan.packages[1]?.packageSequence === 2);
check('planner creates stable per-package idempotency keys',
  plan.packages[0]?.labelIdempotencyKey === 'order:28901:package:box-a' &&
    plan.packages[1]?.labelIdempotencyKey === 'order:28901:package:box-b');
check('planner preserves package item quantities',
  plan.packages[1]?.items[0]?.sku === 'B' && plan.packages[1]?.items[0]?.quantity === 2);

const single = buildMultiPackageShipmentPlan({
  orderId: 'manual-7',
  packages: [{ packageKey: 'primary', items: [{ sku: 'ONLY', quantity: 1 }] }],
});
check('single package plans stay explicitly single-package',
  single.mode === 'single_package' && single.packageCount === 1);

const fallback = buildMultiPackageShipmentPlan({
  orderId: 28902,
  packages: [{ items: [] }, { packageKey: ' Box B ', items: [] }],
});
check('missing package key gets deterministic package-N fallback',
  fallback.packages[0]?.packageKey === 'package-1');
check('package keys are normalized for idempotency',
  fallback.packages[1]?.packageKey === 'box-b' &&
    fallback.packages[1]?.labelIdempotencyKey === 'order:28902:package:box-b');

let duplicateThrown = false;
try {
  buildMultiPackageShipmentPlan({
    orderId: 28903,
    packages: [{ packageKey: 'dup' }, { packageKey: ' dup ' }],
  });
} catch (err) {
  duplicateThrown = /Duplicate package key/.test(err instanceof Error ? err.message : String(err));
}
check('duplicate package keys are rejected before any label purchase planning', duplicateThrown);

check('standalone idempotency helper matches the planner',
  multiPackageLabelIdempotencyKey({ orderId: 28901, packageKey: 'box-a' }) === 'order:28901:package:box-a');

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-shipment-plan.ts', 'utf8');
check('owner is pure: no DB/provider/label/queue imports',
  !/from ['"].*(db|schema|connector|labels|print-queue|shipstation|shipp|easypost|walmart)/i.test(ownerSrc));
check('owner documents no live label/postage mutation in this slice',
  /No label purchase, postage, queue, marketplace, or shipped\/cancelled mutation/.test(ownerSrc));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-289-multi-package-plan',
  /"test:ps-289-multi-package-plan"\s*:\s*"tsx scripts\/ps-289-multi-package-shipment-plan-guard\.ts"/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package shipment plan guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package shipment plan guard');
