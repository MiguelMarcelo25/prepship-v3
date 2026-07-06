/**
 * PS-398 - Custom box override labels survive manual edit and regeneration.
 *
 * HUGRAB order #1767 shape: an operator sets only a box cost for a custom
 * shipment box (package_id remains NULL), while the shipment carries exact
 * dims 10x6.5x2. The backend billing-box policy must preserve that dims label
 * as "Custom 10x6.5x2" instead of falling back to "operator-resolved".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decidePackageCostLine,
  resolveShippedPackageId,
  resolvedPackageDisplayName,
  type BoxLookups,
  type ShippedBoxResolution,
} from '../src/services/billing-box-policy';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const emptyLookups: BoxLookups = {
  byId: new Map(),
  byCode: new Map(),
  byDims: new Map(),
};

const resolution = resolveShippedPackageId({
  operator: { packageId: null, overridePrice: 0.2, note: 'bulk custom box override' },
  selectedPid: null,
  selectedPackageId: null,
  dimsL: 10,
  dimsW: 6.5,
  dimsH: 2,
  lookups: emptyLookups,
});

assert.equal(resolution.status, 'resolved');
assert.equal(
  resolvedPackageDisplayName(resolution as Extract<ShippedBoxResolution, { status: 'resolved' }>, 'operator-resolved'),
  'Custom 10x6.5x2',
);
assert.deepEqual(
  decidePackageCostLine({
    resolution,
    clientHasBoxPricing: true,
    configuredPrice: null,
    markupPct: 25,
  }),
  { kind: 'line', amount: 0.2, packageId: null, pkgName: 'Custom 10x6.5x2' },
);

const route = read('src/routes/billing.ts');
const policy = read('src/services/billing-box-policy.ts');
const generator = read('src/services/billing.ts');

assert.ok(
  policy.includes('export function resolvedPackageDisplayName'),
  'billing-box-policy must own the resolved/custom display label',
);
assert.ok(
  generator.includes('description: `Box (${packageCostDecision.pkgName})`'),
  'regeneration must emit the policy-provided package_cost label',
);
assert.ok(
  route.includes("from '../services/billing-box-policy'") &&
    route.includes('resolveShippedPackageId') &&
    route.includes('resolvedPackageDisplayName'),
  'PATCH /billing/details must consume billing-box-policy instead of rebuilding box labels',
);
assert.ok(
  route.indexOf('currentPackageCostLineBeforeEdit') < route.indexOf('for (const [bodyKey, lineType, description]'),
  'PATCH must compare box price against the pre-edit package_cost amount before mutating line items',
);
assert.ok(
  route.includes('currentBoxAmountBeforeEdit') &&
    route.includes('money(body.packageCost) !== currentBoxAmountBeforeEdit'),
  'priceChanged must use the pre-edit box amount so price-only custom-box edits persist a resolution',
);
assert.ok(
  route.includes('.from(shipments)') &&
    route.includes('dimsL: shipments.dimsL') &&
    route.includes('dimsW: shipments.dimsW') &&
    route.includes('dimsH: shipments.dimsH'),
  'manual PATCH must pass shipment dims into the policy for package_id NULL custom-box overrides',
);
assert.ok(
  route.includes('.from(packages)') && route.includes('newPackageId != null'),
  'manual PATCH must pass package facts into the same policy for package-id overrides',
);
assert.ok(
  route.includes(".set({ description: `Box (${resolvedPackageDisplayName(boxResolution, 'Package Cost')})` })"),
  'manual PATCH must immediately rewrite package_cost.description with the policy label',
);
assert.ok(
  !/pkgName:\s*['"]operator-resolved['"]/.test(policy),
  'custom override labels must not collapse to a hard-coded operator-resolved pkgName',
);

console.log('PASS ps-398 billing custom-box override guard');
