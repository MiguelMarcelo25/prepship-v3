/**
 * PS-289 - purchased label sidecar orchestration guard.
 *
 * Proves purchased package labels can be persisted into shipment group sidecars
 * without writing real print queue rows, calling marketplaces, or mutating
 * shipped/cancelled data.
 */
import { readFileSync } from 'node:fs';
import type {
  MultiPackageLabelPurchaseRequest,
  MultiPackagePurchasedLabel,
} from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  multiPackageSidecarHasPurchasedLabelFacts,
  orchestratePurchasedMultiPackageLabels,
  type MultiPackagePurchasedLabelOrchestrationRepository,
} from '../src/services/shipping-workflow/multi-package-purchased-label-orchestration';
import {
  buildMultiPackageShipmentPlan,
  type MultiPackagePersistenceDraft,
} from '../src/services/shipping-workflow/multi-package-shipment-plan';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

type PlannedGroup = MultiPackagePersistenceDraft['group'];
type PlannedPackage = MultiPackagePersistenceDraft['packages'][number];

const events: string[] = [];
const purchaseRequests: MultiPackageLabelPurchaseRequest[] = [];
let plannedGroup: PlannedGroup | null = null;
let plannedPackages: PlannedPackage[] = [];
let appliedLabels: MultiPackagePurchasedLabel[] | null = null;
let appliedGroupId = 0;
let markedGroup: { groupId: number; packageCount: number; totalPostageCost: number } | null = null;

const repository: MultiPackagePurchasedLabelOrchestrationRepository = {
  async findExistingPurchasedLabelKeys(keys) {
    events.push(`find:${keys.join('|')}`);
    return [];
  },
  async upsertPlannedGroup(group) {
    events.push(`upsert-group:${group.groupKey}`);
    plannedGroup = group;
    return { id: 501, groupKey: group.groupKey };
  },
  async upsertPlannedPackages(groupId, packages) {
    events.push(`upsert-packages:${groupId}:${packages.length}`);
    plannedPackages = packages;
  },
  async applyPurchasedLabels(groupId, labels) {
    events.push(`apply-labels:${groupId}:${labels.length}`);
    appliedGroupId = groupId;
    appliedLabels = labels;
  },
  async markGroupLabelsPurchased(groupId, packageCount, totalPostageCost) {
    events.push(`mark-group:${groupId}:${packageCount}:${totalPostageCost}`);
    markedGroup = { groupId, packageCount, totalPostageCost };
  },
};

const plan = buildMultiPackageShipmentPlan({
  orderId: 28910,
  orderNumber: 'PS-289-PERSIST',
  packages: [
    {
      packageKey: 'first',
      weightOz: 10,
      dimensions: { length: 8, width: 6, height: 2 },
      items: [{ sku: 'FIRST-SKU', quantity: 1 }],
    },
    {
      packageKey: 'second',
      weightOz: 24,
      dimensions: { length: 14, width: 9, height: 4 },
      items: [{ sku: 'SECOND-SKU', quantity: 3 }],
    },
  ],
});

const result = await orchestratePurchasedMultiPackageLabels(plan, {
  clientId: 88,
  serviceLabel: 'UPS Ground',
  repository,
  purchaser: async (request) => {
    events.push(`purchase:${request.packageKey}`);
    purchaseRequests.push(request);
    return {
      labelIdempotencyKey: request.labelIdempotencyKey,
      shipmentId: 7100 + request.packageSequence,
      trackingNumber: `1ZPERSIST${request.packageSequence}`,
      labelUrl: `mock://persisted/${request.packageKey}`,
      provider: 'injected_test_purchaser',
      postageCost: request.packageSequence === 1 ? 3.15 : 8.45,
      isLivePostage: false,
    };
  },
});

check('orchestration returns persisted group id and purchased flow',
  result.groupId === 501 &&
    result.flow.labels.length === 2 &&
    result.flow.group.status === 'labels_purchased');
check('orchestration checks duplicate purchased labels before sidecar writes',
  events[0] === 'find:order:28910:package:first|order:28910:package:second');
check('orchestration writes planned group and package sidecars before purchase',
  events[1] === 'upsert-group:order:28910' &&
    events[2] === 'upsert-packages:501:2' &&
    events[3] === 'purchase:first');
check('planned sidecar rows preserve package facts',
  plannedGroup?.orderId === 28910 &&
    plannedGroup?.clientId === 88 &&
    plannedPackages[1]?.labelIdempotencyKey === 'order:28910:package:second' &&
    plannedPackages[1]?.dimsL === 14 &&
    plannedPackages[1]?.items[0]?.sku === 'SECOND-SKU');
check('purchaser receives one package-aware request per sidecar package',
  purchaseRequests.length === 2 &&
    purchaseRequests[0]?.labelIdempotencyKey === 'order:28910:package:first' &&
    purchaseRequests[1]?.labelIdempotencyKey === 'order:28910:package:second' &&
    purchaseRequests.every((request) => request.shipmentGroupKey === 'order:28910'));
check('orchestration applies purchased labels back to the same sidecar group',
  appliedGroupId === 501 &&
    Array.isArray(appliedLabels) &&
    appliedLabels.length === 2 &&
    appliedLabels[1]?.shipmentId === 7102 &&
    appliedLabels[1]?.trackingNumber === '1ZPERSIST2' &&
    appliedLabels[1]?.labelUrl === 'mock://persisted/second');
check('orchestration marks the group purchased with total postage',
  markedGroup?.groupId === 501 &&
    markedGroup?.packageCount === 2 &&
    markedGroup?.totalPostageCost === 11.6);
check('orchestration does not create live postage by itself',
  result.flow.labels.every((label) => label.isLivePostage === false && label.provider === 'injected_test_purchaser'));
check('sidecar idempotency treats downstream print-queue status as purchased proof',
  multiPackageSidecarHasPurchasedLabelFacts({
    status: 'print_queue_sidecar_planned',
    shipmentId: null,
    trackingNumber: null,
    labelUrl: null,
  }));
check('sidecar idempotency treats downstream marketplace status as purchased proof',
  multiPackageSidecarHasPurchasedLabelFacts({
    status: 'marketplace_confirmation_sidecar_planned',
    shipmentId: null,
    trackingNumber: null,
    labelUrl: null,
  }));
check('sidecar idempotency treats persisted label facts as purchased proof',
  multiPackageSidecarHasPurchasedLabelFacts({
    status: 'planned',
    shipmentId: 7101,
    trackingNumber: null,
    labelUrl: null,
  }) &&
    multiPackageSidecarHasPurchasedLabelFacts({
      status: 'planned',
      shipmentId: null,
      trackingNumber: '1ZPS289',
      labelUrl: null,
    }) &&
    multiPackageSidecarHasPurchasedLabelFacts({
      status: 'planned',
      shipmentId: null,
      trackingNumber: null,
      labelUrl: 'mock://label/ps-289',
    }));
check('sidecar idempotency does not block an empty planned row',
  !multiPackageSidecarHasPurchasedLabelFacts({
    status: 'planned',
    shipmentId: null,
    trackingNumber: null,
    labelUrl: null,
  }));

let duplicateBlocked = false;
let duplicateEvents: string[] = [];
const duplicateRepository: MultiPackagePurchasedLabelOrchestrationRepository = {
  async findExistingPurchasedLabelKeys(keys) {
    duplicateEvents.push(`find:${keys.length}`);
    return ['order:28910:package:second'];
  },
  async upsertPlannedGroup() {
    duplicateEvents.push('upsert-group');
    throw new Error('should not write group');
  },
  async upsertPlannedPackages() {
    duplicateEvents.push('upsert-packages');
  },
  async applyPurchasedLabels() {
    duplicateEvents.push('apply-labels');
  },
  async markGroupLabelsPurchased() {
    duplicateEvents.push('mark-group');
  },
};
try {
  await orchestratePurchasedMultiPackageLabels(plan, {
    repository: duplicateRepository,
    purchaser: async (request) => ({
      labelIdempotencyKey: request.labelIdempotencyKey,
      shipmentId: 1,
      trackingNumber: 'TRACK',
      labelUrl: 'mock://label',
      provider: 'should_not_call',
      postageCost: 0,
      isLivePostage: false,
    }),
  });
} catch (err) {
  duplicateBlocked = /Package already has a purchased label/.test(err instanceof Error ? err.message : String(err));
}
check('duplicate purchased sidecar label blocks before writes or purchase',
  duplicateBlocked && duplicateEvents.join('|') === 'find:2');

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-purchased-label-orchestration.ts', 'utf8');
check('purchased label orchestration exports orchestratePurchasedMultiPackageLabels',
  /export async function orchestratePurchasedMultiPackageLabels/.test(ownerSrc));
check('purchased label orchestration exports DB repository factory',
  /export function createDbMultiPackagePurchasedLabelOrchestrationRepository/.test(ownerSrc));
check('purchased label orchestration writes only shipment group sidecars',
  ownerSrc.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(ownerSrc));
check('purchased label orchestration documents no provider or live mutation behavior',
  /No provider calls by default, no print queue writes, no marketplace API calls, and no shipped\/cancelled mutation/.test(ownerSrc));
check('DB duplicate lookup treats downstream sidecars and label facts as purchased proof',
  ownerSrc.includes('PURCHASED_OR_DOWNSTREAM_PACKAGE_STATUSES') &&
    ownerSrc.includes('print_queue_sidecar_planned') &&
    ownerSrc.includes('marketplace_confirmation_sidecar_planned') &&
    /isNotNull\(shipmentGroupPackages\.shipmentId\)/.test(ownerSrc) &&
    /isNotNull\(shipmentGroupPackages\.trackingNumber\)/.test(ownerSrc) &&
    /isNotNull\(shipmentGroupPackages\.labelUrl\)/.test(ownerSrc));
const plannedPackageUpsertOwner = ownerSrc.slice(
  ownerSrc.indexOf('async upsertPlannedPackages'),
  ownerSrc.indexOf('async applyPurchasedLabels'),
);
check('planned package conflict update preserves purchased label sidecar facts',
  Boolean(plannedPackageUpsertOwner) &&
    !/onConflictDoUpdate\([\s\S]*set:\s*\{[\s\S]*status:\s*pkg\.status/.test(plannedPackageUpsertOwner) &&
    !/onConflictDoUpdate\([\s\S]*set:\s*\{[\s\S]*shipmentId:\s*null/.test(plannedPackageUpsertOwner) &&
    !/onConflictDoUpdate\([\s\S]*set:\s*\{[\s\S]*trackingNumber:\s*null/.test(plannedPackageUpsertOwner) &&
    !/onConflictDoUpdate\([\s\S]*set:\s*\{[\s\S]*labelUrl:\s*null/.test(plannedPackageUpsertOwner));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 purchased label orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-purchased-label-orchestration"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package purchased label orchestration guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package purchased label orchestration guard');
