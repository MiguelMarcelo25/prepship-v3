/**
 * PS-289 - package-aware marketplace confirmation sidecar guard.
 *
 * Proves purchased package labels can be persisted as marketplace confirmation
 * candidates in shipment group sidecars without calling a marketplace API.
 */
import { readFileSync } from 'node:fs';
import { purchaseMultiPackageLabels } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  orchestrateMultiPackageMarketplaceConfirmationSidecar,
  type MultiPackageMarketplaceConfirmationSidecarEntry,
  type MultiPackageMarketplaceConfirmationSidecarRepository,
} from '../src/services/shipping-workflow/multi-package-marketplace-confirmation-sidecar';
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
  orderId: 28912,
  orderNumber: 'PS-289-MKT-SIDECAR',
  packages: [
    {
      packageKey: 'first-box',
      weightOz: 18,
      dimensions: { length: 9, width: 7, height: 4 },
      items: [{ sku: 'FIRST-MKT', quantity: 2 }],
    },
    {
      packageKey: 'second-box',
      weightOz: 30,
      dimensions: { length: 15, width: 10, height: 5 },
      items: [{ sku: 'SECOND-MKT', quantity: 1 }],
    },
  ],
});

const purchaseFlow = await purchaseMultiPackageLabels(plan, {
  clientId: 92,
  serviceLabel: 'UPS Ground',
  purchaser: async (request) => ({
    labelIdempotencyKey: request.labelIdempotencyKey,
    shipmentId: 9100 + request.packageSequence,
    trackingNumber: `1ZMKT${request.packageSequence}`,
    labelUrl: `mock://marketplace-sidecar/${request.packageKey}`,
    provider: 'injected_test_purchaser',
    postageCost: request.packageSequence === 1 ? 6.2 : 8.4,
    isLivePostage: false,
  }),
});

const events: string[] = [];
let appliedGroupId = 0;
let appliedEntries: MultiPackageMarketplaceConfirmationSidecarEntry[] = [];
let markedGroup: { groupId: number; packageCount: number; trackingNumbers: string[] } | null = null;

const repository: MultiPackageMarketplaceConfirmationSidecarRepository = {
  async findExistingMarketplaceConfirmationKeys(keys) {
    events.push(`find:${keys.join('|')}`);
    return [];
  },
  async applyMarketplaceConfirmationCandidates(groupId, entries) {
    events.push(`apply:${groupId}:${entries.length}`);
    appliedGroupId = groupId;
    appliedEntries = entries;
  },
  async markGroupMarketplaceConfirmationPlanned(groupId, packageCount, trackingNumbers) {
    events.push(`mark:${groupId}:${packageCount}:${trackingNumbers.join('|')}`);
    markedGroup = { groupId, packageCount, trackingNumbers };
  },
};

const result = await orchestrateMultiPackageMarketplaceConfirmationSidecar(701, purchaseFlow, {
  repository,
  carrierName: 'UPS',
  serviceLabel: 'UPS Ground',
});

check('sidecar marketplace orchestration emits one confirmation per purchased label',
  result.confirmations.length === 2 &&
    result.group.status === 'marketplace_confirmation_sidecar_planned' &&
    result.group.packageCount === 2);
check('sidecar marketplace orchestration checks duplicates before applying candidates',
  events[0] === 'find:order:28912:package:first-box|order:28912:package:second-box' &&
    events[1] === 'apply:701:2');
check('confirmation entries are package-aware and deterministic',
  result.confirmations[0]?.confirmationId === 'mpc:order:28912:package:first-box' &&
    result.confirmations[1]?.confirmationId === 'mpc:order:28912:package:second-box' &&
    result.confirmations[1]?.packageSequence === 2);
check('confirmation entries carry purchased label facts',
  result.confirmations[1]?.shipmentId === 9102 &&
    result.confirmations[1]?.trackingNumber === '1ZMKT2' &&
    result.confirmations[1]?.labelIdempotencyKey === 'order:28912:package:second-box' &&
    result.confirmations[1]?.provider === 'injected_test_purchaser');
check('confirmation entries carry carrier, service, and order identity',
  result.confirmations[0]?.carrierName === 'UPS' &&
    result.confirmations[0]?.serviceLabel === 'UPS Ground' &&
    result.confirmations[0]?.orderNumber === 'PS-289-MKT-SIDECAR' &&
    result.confirmations[0]?.shipmentGroupKey === 'order:28912');
check('tracking numbers preserve package order',
  result.trackingNumbers.join('|') === purchaseFlow.labels.map((label) => label.trackingNumber).join('|'));
check('confirmation entries stay sidecar planned and non-live',
  result.confirmations.every((entry) =>
    entry.status === 'marketplace_confirmation_sidecar_planned' &&
    entry.realMarketplaceNotificationSent === false));
check('sidecar repository receives confirmation entries for the same group',
  appliedGroupId === 701 &&
    appliedEntries.length === 2 &&
    appliedEntries[1]?.labelIdempotencyKey === 'order:28912:package:second-box');
check('sidecar group is marked with all package tracking numbers',
  markedGroup?.groupId === 701 &&
    markedGroup?.packageCount === 2 &&
    markedGroup?.trackingNumbers.join('|') === result.trackingNumbers.join('|'));

let duplicateBlocked = false;
let duplicateEvents: string[] = [];
const duplicateRepository: MultiPackageMarketplaceConfirmationSidecarRepository = {
  async findExistingMarketplaceConfirmationKeys(keys) {
    duplicateEvents.push(`find:${keys.length}`);
    return ['order:28912:package:second-box'];
  },
  async applyMarketplaceConfirmationCandidates() {
    duplicateEvents.push('apply');
  },
  async markGroupMarketplaceConfirmationPlanned() {
    duplicateEvents.push('mark');
  },
};
try {
  await orchestrateMultiPackageMarketplaceConfirmationSidecar(701, purchaseFlow, {
    repository: duplicateRepository,
  });
} catch (err) {
  duplicateBlocked = /already has a marketplace confirmation sidecar candidate/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('duplicate marketplace package label blocks before sidecar updates',
  duplicateBlocked && duplicateEvents.join('|') === 'find:2');

const ownerSrc = readFileSync(
  'src/services/shipping-workflow/multi-package-marketplace-confirmation-sidecar.ts',
  'utf8',
);
check('marketplace confirmation sidecar owner exports orchestrator',
  /export async function orchestrateMultiPackageMarketplaceConfirmationSidecar/.test(ownerSrc));
check('marketplace confirmation sidecar owner exports DB repository factory',
  /export function createDbMultiPackageMarketplaceConfirmationSidecarRepository/.test(ownerSrc));
check('marketplace confirmation sidecar owner writes only shipment group sidecars',
  ownerSrc.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|orders|shipments)/i.test(ownerSrc));
check('marketplace confirmation sidecar owner documents no live marketplace notification',
  /No marketplace API calls, live marketplace notifications, provider calls, real print queue writes, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 marketplace confirmation sidecar guard',
  packageJson.includes('"test:ps-289-multi-package-marketplace-confirmation-sidecar"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package marketplace confirmation sidecar guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package marketplace confirmation sidecar guard');
