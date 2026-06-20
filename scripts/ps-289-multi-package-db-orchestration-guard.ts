/**
 * PS-289 - DB-backed mocked multi-package orchestration guard.
 *
 * Uses an in-memory repository to prove the backend workflow contract without
 * touching the real database, providers, labels, print queue, marketplace, or
 * shipped/cancelled data.
 */
import { readFileSync } from 'node:fs';
import { buildMultiPackageShipmentPlan } from '../src/services/shipping-workflow/multi-package-shipment-plan';
import {
  orchestrateMockedMultiPackageLabels,
  type MultiPackageMockLabelOrchestrationRepository,
} from '../src/services/shipping-workflow/multi-package-mock-label-orchestration';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

function memoryRepo(existingKeys: string[] = []): MultiPackageMockLabelOrchestrationRepository & {
  events: string[];
  labelsApplied: number;
} {
  const existing = new Set(existingKeys);
  let nextGroupId = 8001;
  return {
    events: [],
    labelsApplied: 0,
    async findExistingMockedLabelKeys(keys) {
      this.events.push(`findExisting:${keys.length}`);
      return keys.filter((key) => existing.has(key));
    },
    async upsertPlannedGroup(group) {
      this.events.push(`upsertGroup:${group.status}:${group.packageCount}`);
      return { id: nextGroupId++, groupKey: group.groupKey };
    },
    async upsertPlannedPackages(groupId, packages) {
      this.events.push(`upsertPackages:${groupId}:${packages.length}:${packages.map((pkg) => pkg.status).join(',')}`);
    },
    async applyMockedLabels(groupId, labels) {
      this.labelsApplied = labels.length;
      this.events.push(`applyLabels:${groupId}:${labels.length}:${labels.map((label) => label.labelIdempotencyKey).join('|')}`);
    },
    async markGroupMockLabelsCreated(groupId, packageCount) {
      this.events.push(`markGroup:${groupId}:mock_labels_created:${packageCount}`);
    },
  };
}

const plan = buildMultiPackageShipmentPlan({
  orderId: 28905,
  orderNumber: 'PS-289-DB',
  packages: [
    { packageKey: 'left', weightOz: 10, dimensions: { length: 6, width: 4, height: 3 } },
    { packageKey: 'right', weightOz: 14, dimensions: { length: 7, width: 5, height: 4 } },
  ],
});

const repo = memoryRepo();
const result = await orchestrateMockedMultiPackageLabels(plan, {
  clientId: 91,
  serviceLabel: 'DB MOCK GROUND',
  repository: repo,
});

check('orchestrator returns group id and mocked flow',
  result.groupId === 8001 &&
    result.flow.group.status === 'mock_labels_created' &&
    result.flow.labels.length === 2);
check('orchestrator writes planned group/packages before label status transitions',
  repo.events[0] === 'findExisting:2' &&
    repo.events[1] === 'upsertGroup:planned:2' &&
    repo.events[2] === 'upsertPackages:8001:2:planned,planned' &&
    repo.events[3]?.startsWith('applyLabels:8001:2:order:28905:package:left|order:28905:package:right') &&
    repo.events[4] === 'markGroup:8001:mock_labels_created:2',
  repo.events.join(' -> '));
check('orchestrator applies one mocked label per package',
  repo.labelsApplied === 2 &&
    result.flow.labels.every((label) => label.provider === 'mock_multi_package' && label.isLivePostage === false));

const duplicateRepo = memoryRepo(['order:28905:package:right']);
let duplicateBlocked = false;
try {
  await orchestrateMockedMultiPackageLabels(plan, { repository: duplicateRepo });
} catch (err) {
  duplicateBlocked = /already has a mocked label/.test(err instanceof Error ? err.message : String(err));
}
check('orchestrator blocks duplicate package labels before any writes',
  duplicateBlocked && duplicateRepo.events.length === 1 && duplicateRepo.events[0] === 'findExisting:2',
  duplicateRepo.events.join(' -> '));

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-mock-label-orchestration.ts', 'utf8');
check('orchestration owner exports orchestrateMockedMultiPackageLabels',
  /export async function orchestrateMockedMultiPackageLabels/.test(ownerSrc));
check('orchestration owner exports DB repository factory',
  /export function createDbMultiPackageMockLabelOrchestrationRepository/.test(ownerSrc));
check('orchestration owner writes only shipment group sidecars',
  ownerSrc.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(orders|shipments|print-queue|labels|marketplace|connector|shipstation|shipp|easypost|walmart)/i.test(ownerSrc));
check('orchestration owner documents mocked-only safety',
  /Mocked-only orchestration: no provider calls, postage, print queue, marketplace, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 DB orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-db-orchestration"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package DB orchestration guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package DB orchestration guard');
