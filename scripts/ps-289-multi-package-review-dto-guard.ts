/**
 * PS-289 - multi-package review DTO guard.
 *
 * Proves future package-group UI/API consumers can read backend-owned package
 * review rows without rebuilding label, print queue, or marketplace state in
 * the frontend.
 */
import { readFileSync } from 'node:fs';
import { purchaseMultiPackageLabels } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  orchestrateMultiPackageMarketplaceConfirmationSidecar,
  type MultiPackageMarketplaceConfirmationSidecarRepository,
} from '../src/services/shipping-workflow/multi-package-marketplace-confirmation-sidecar';
import {
  orchestrateMultiPackagePrintQueueSidecar,
  type MultiPackagePrintQueueSidecarRepository,
} from '../src/services/shipping-workflow/multi-package-print-queue-sidecar';
import { buildMultiPackageReviewDto } from '../src/services/shipping-workflow/multi-package-review-dto';
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

function throws(name: string, action: () => unknown, pattern: RegExp): void {
  try {
    action();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, pattern.test(err instanceof Error ? err.message : String(err)));
  }
}

const plan = buildMultiPackageShipmentPlan({
  orderId: 28913,
  orderNumber: 'PS-289-REVIEW',
  packages: [
    {
      packageKey: 'front-box',
      weightOz: 20,
      dimensions: { length: 10, width: 8, height: 4 },
      items: [{ sku: 'FRONT-REVIEW', quantity: 2 }],
    },
    {
      packageKey: 'back-box',
      weightOz: 34,
      dimensions: { length: 16, width: 11, height: 7 },
      items: [{ sku: 'BACK-REVIEW', quantity: 1 }],
    },
  ],
});

const purchaseFlow = await purchaseMultiPackageLabels(plan, {
  clientId: 93,
  serviceLabel: 'UPS Ground',
  purchaser: async (request) => ({
    labelIdempotencyKey: request.labelIdempotencyKey,
    shipmentId: 9300 + request.packageSequence,
    trackingNumber: `1ZREVIEW${request.packageSequence}`,
    labelUrl: `mock://review-dto/${request.packageKey}`,
    provider: 'injected_test_purchaser',
    postageCost: request.packageSequence === 1 ? 6.1 : 8.2,
    isLivePostage: false,
  }),
});

const printQueueRepository: MultiPackagePrintQueueSidecarRepository = {
  async findExistingQueuedLabelKeys() {
    return [];
  },
  async applyPrintQueueCandidates() {},
  async markGroupPrintQueuePlanned() {},
};
const printQueueSidecarPlan = await orchestrateMultiPackagePrintQueueSidecar(801, purchaseFlow, {
  repository: printQueueRepository,
});

const marketplaceRepository: MultiPackageMarketplaceConfirmationSidecarRepository = {
  async findExistingMarketplaceConfirmationKeys() {
    return [];
  },
  async applyMarketplaceConfirmationCandidates() {},
  async markGroupMarketplaceConfirmationPlanned() {},
};
const marketplaceConfirmationSidecarPlan = await orchestrateMultiPackageMarketplaceConfirmationSidecar(
  801,
  purchaseFlow,
  {
    repository: marketplaceRepository,
    carrierName: 'UPS',
    serviceLabel: 'UPS Ground',
  },
);

const plannedOnly = buildMultiPackageReviewDto(plan);
check('planned-only DTO emits one package row per planned package',
  plannedOnly.packages.length === 2 &&
    plannedOnly.summary.totalPackages === 2 &&
    plannedOnly.packages[0]?.status === 'planned');
check('planned-only DTO reports missing backend sidecar facts',
  plannedOnly.packages.every((row) =>
    row.missing.join('|') === 'label|print_queue_sidecar|marketplace_confirmation_sidecar' &&
    row.readyForOperatorReview === false));

const review = buildMultiPackageReviewDto(plan, {
  labelFlow: purchaseFlow,
  printQueueSidecarPlan,
  marketplaceConfirmationSidecarPlan,
});
check('review DTO preserves package order and identity',
  review.packages[0]?.packageKey === 'front-box' &&
    review.packages[1]?.packageKey === 'back-box' &&
    review.packages[1]?.labelIdempotencyKey === 'order:28913:package:back-box');
check('review DTO merges purchased label facts without exposing postage cost',
  review.packages[1]?.label?.source === 'label_flow' &&
    review.packages[1]?.label?.shipmentId === 9302 &&
    review.packages[1]?.label?.trackingNumber === '1ZREVIEW2' &&
    !('postageCost' in (review.packages[1]?.label ?? {})));
check('review DTO attaches package-aware print queue facts',
  review.packages[0]?.printQueue?.queueId === 'mpq:order:28913:package:front-box' &&
    review.packages[0]?.printQueue?.skuGroupId === 'multi-package:front-box' &&
    review.packages[0]?.printQueue?.realPrintQueueInserted === false);
check('review DTO attaches marketplace confirmation facts',
  review.packages[1]?.marketplaceConfirmation?.confirmationId === 'mpc:order:28913:package:back-box' &&
    review.packages[1]?.marketplaceConfirmation?.carrierName === 'UPS' &&
    review.packages[1]?.marketplaceConfirmation?.realMarketplaceNotificationSent === false);
check('review DTO summarizes package readiness conservatively',
  review.summary.labelPackageCount === 2 &&
    review.summary.printQueuePackageCount === 2 &&
    review.summary.marketplaceConfirmationPackageCount === 2 &&
    review.summary.readyForOperatorReviewCount === 2 &&
    review.summary.allPackagesReadyForOperatorReview === true &&
    review.safety.hasLivePostage === false);
check('review DTO marks package rows fully reviewable only after all backend facts exist',
  review.packages.every((row) =>
    row.status === 'marketplace_confirmation_sidecar_planned' &&
    row.missing.length === 0 &&
    row.readyForOperatorReview === true));

const sidecarOnly = buildMultiPackageReviewDto(plan, { printQueueSidecarPlan });
check('review DTO can fall back to sidecar label facts for read-only package rows',
  sidecarOnly.packages[0]?.label?.source === 'print_queue_sidecar' &&
    sidecarOnly.packages[0]?.label?.trackingNumber === '1ZREVIEW1' &&
    sidecarOnly.packages[0]?.status === 'print_queue_sidecar_planned');

throws('review DTO rejects sidecar rows outside the plan', () => {
  buildMultiPackageReviewDto(plan, {
    printQueueSidecarPlan: {
      ...printQueueSidecarPlan,
      entries: [
        {
          ...printQueueSidecarPlan.entries[0]!,
          labelIdempotencyKey: 'order:28913:package:other-box',
        },
      ],
    },
  });
}, /outside the multi-package plan/);

throws('review DTO rejects mismatched sidecar group identity', () => {
  buildMultiPackageReviewDto(plan, {
    marketplaceConfirmationSidecarPlan: {
      ...marketplaceConfirmationSidecarPlan,
      group: {
        ...marketplaceConfirmationSidecarPlan.group,
        groupKey: 'order:99999',
      },
    },
  });
}, /group key does not match/);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-review-dto.ts', 'utf8');
check('review DTO owner exports buildMultiPackageReviewDto',
  /export function buildMultiPackageReviewDto/.test(ownerSrc));
check('review DTO owner documents backend-owned read model scope',
  /Backend-owned read model/.test(ownerSrc) &&
    /No DB reads\/writes, provider calls, postage, print queue writes, marketplace/.test(ownerSrc));
check('review DTO owner stays pure and provider-free',
  !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|orders|shipments)/i.test(ownerSrc) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
const closeoutGuard = readFileSync('scripts/ps-289-multi-package-closeout-guard.ts', 'utf8');
const statusDoc = readFileSync('docs/ps-tickets/ps-289-multi-package-status.md', 'utf8');
check('package wires PS-289 review DTO guard',
  packageJson.includes('"test:ps-289-multi-package-review-dto"'));
check('PS-289 closeout guard tracks the review DTO guard',
  closeoutGuard.includes('multi-package-review-dto.ts') &&
    closeoutGuard.includes('test:ps-289-multi-package-review-dto'));
check('PS-289 status doc lists review DTO evidence',
  statusDoc.includes('`test:ps-289-multi-package-review-dto`') &&
    /backend-owned package review DTO/.test(statusDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package review DTO guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package review DTO guard');
