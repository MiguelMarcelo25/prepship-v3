/**
 * PS-289 closeout checkpoint.
 *
 * Keeps the multi-package card honest after the planner + sidecar schema
 * foundation: live integrations/UI/live-safety proof are still missing.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const packageJson = readFileSync('package.json', 'utf8');
const doc = readFileSync('docs/ps-tickets/ps-289-multi-package-status.md', 'utf8');
const planner = readFileSync('src/services/shipping-workflow/multi-package-shipment-plan.ts', 'utf8');
const schema = readFileSync('src/db/schema/shipment-groups.ts', 'utf8');
const mockFlow = readFileSync('src/services/shipping-workflow/multi-package-mock-label-flow.ts', 'utf8');
const orchestration = readFileSync('src/services/shipping-workflow/multi-package-mock-label-orchestration.ts', 'utf8');
const printQueuePlan = readFileSync('src/services/shipping-workflow/multi-package-print-queue-plan.ts', 'utf8');
const marketplacePlan = readFileSync(
  'src/services/shipping-workflow/multi-package-marketplace-confirmation-plan.ts',
  'utf8',
);
const mockedWorkflow = readFileSync('src/services/shipping-workflow/multi-package-mocked-workflow.ts', 'utf8');
const labelPurchaseBoundary = readFileSync(
  'src/services/shipping-workflow/multi-package-label-purchase-boundary.ts',
  'utf8',
);
const sourceGuard = readFileSync('scripts/ps-289-multi-package-shipment-plan-guard.ts', 'utf8');

check('package wires PS-289 planner guard',
  packageJson.includes('"test:ps-289-multi-package-plan"'));
check('package wires PS-289 schema guard',
  packageJson.includes('"test:ps-289-multi-package-schema"'));
check('package wires PS-289 mocked label flow guard',
  packageJson.includes('"test:ps-289-multi-package-mock-label-flow"'));
check('package wires PS-289 DB orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-db-orchestration"'));
check('package wires PS-289 print queue plan guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-plan"'));
check('package wires PS-289 marketplace confirmation plan guard',
  packageJson.includes('"test:ps-289-multi-package-marketplace-confirmation-plan"'));
check('package wires PS-289 mocked workflow guard',
  packageJson.includes('"test:ps-289-multi-package-mocked-workflow"'));
check('package wires PS-289 label purchase boundary guard',
  packageJson.includes('"test:ps-289-multi-package-label-purchase-boundary"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('status doc lists planner guard',
  doc.includes('`test:ps-289-multi-package-plan`'));
check('status doc lists schema guard',
  doc.includes('`test:ps-289-multi-package-schema`'));
check('status doc lists mocked label flow guard',
  doc.includes('`test:ps-289-multi-package-mock-label-flow`'));
check('status doc lists DB orchestration guard',
  doc.includes('`test:ps-289-multi-package-db-orchestration`'));
check('status doc lists print queue plan guard',
  doc.includes('`test:ps-289-multi-package-print-queue-plan`'));
check('status doc lists marketplace confirmation plan guard',
  doc.includes('`test:ps-289-multi-package-marketplace-confirmation-plan`'));
check('status doc lists mocked workflow guard',
  doc.includes('`test:ps-289-multi-package-mocked-workflow`'));
check('status doc lists label purchase boundary guard',
  doc.includes('`test:ps-289-multi-package-label-purchase-boundary`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-289-multi-package-closeout`'));
check('status doc keeps PS-289 conservative at 72%',
  /PS-289 72%/.test(doc));
check('status doc explicitly blocks Final Review',
  /not Final Review-ready/.test(doc));
check('status doc says sidecar persistence foundation exists',
  /additive persistence\s+foundation, mocked/.test(doc));
check('status doc says mocked per-package label identity exists',
  /mocked per-package label identity workflow, and/.test(doc));
check('status doc says DB-backed mocked orchestration exists',
  /DB-backed mocked status orchestration\s+exist/.test(doc));
check('status doc says group-aware print queue planning exists',
  /Group-aware print queue planning also exists/.test(doc));
check('status doc says marketplace confirmation planning exists',
  /Marketplace confirmation planning now exists/.test(doc));
check('status doc says end-to-end mocked workflow proof exists',
  /end-to-end mocked workflow proof now exists/i.test(doc));
check('status doc says test-gated label purchase boundary exists',
  /test-gated per-package label purchase boundary now\s+exists/.test(doc));
check('status doc lists real carrier adapter wiring as missing',
  /Real carrier adapter wiring for per-package label purchase/.test(doc));
check('status doc lists print queue persistence as missing',
  /print queue persistence\/integration/.test(doc));
check('status doc lists marketplace confirmation integration as missing',
  /marketplace confirmation persistence\/integration/.test(doc));
check('status doc still blocks live/canary use',
  /No live postage, marketplace notification, or operator canary/.test(doc));

check('planner exports buildMultiPackageShipmentPlan',
  /export function buildMultiPackageShipmentPlan/.test(planner));
check('planner exports multiPackageLabelIdempotencyKey',
  /export function multiPackageLabelIdempotencyKey/.test(planner));
check('planner exports buildMultiPackagePersistenceDraft',
  /export function buildMultiPackagePersistenceDraft/.test(planner));
check('planner remains pure and side-effect-free',
  /No label purchase, postage, queue, marketplace, or shipped\/cancelled mutation/.test(planner));
check('schema has additive group and package tables',
  /shipmentGroups = pgTable/.test(schema) && /shipmentGroupPackages = pgTable/.test(schema));
check('mocked flow exports buildMockedMultiPackageLabelFlow',
  /export function buildMockedMultiPackageLabelFlow/.test(mockFlow));
check('mocked flow remains non-live and zero-postage',
  /isLivePostage: false/.test(mockFlow) && /postageCost: 0/.test(mockFlow));
check('orchestration exports orchestrateMockedMultiPackageLabels',
  /export async function orchestrateMockedMultiPackageLabels/.test(orchestration));
check('orchestration remains mocked-only and sidecar-owned',
  /Mocked-only orchestration/.test(orchestration) &&
    orchestration.includes("from '../../db/schema/shipment-groups'"));
check('print queue planner exports buildMultiPackagePrintQueuePlan',
  /export function buildMultiPackagePrintQueuePlan/.test(printQueuePlan));
check('print queue planner stays pure and planned-only',
  /No real print queue writes/.test(printQueuePlan) &&
    !/from ['"].*(db|schema|print-queue|connector|labels|marketplace)/i.test(printQueuePlan));
check('marketplace confirmation planner exports buildMultiPackageMarketplaceConfirmationPlan',
  /export function buildMultiPackageMarketplaceConfirmationPlan/.test(marketplacePlan));
check('marketplace confirmation planner stays pure and planned-only',
  /No marketplace API calls, live notifications/.test(marketplacePlan) &&
    !/from ['"].*(db|schema|print-queue|connector|labels|marketplace)/i.test(marketplacePlan));
check('mocked workflow exports buildMockedMultiPackageWorkflow',
  /export function buildMockedMultiPackageWorkflow/.test(mockedWorkflow));
check('mocked workflow stays pure and non-live',
  /No DB writes, provider calls, real labels, postage, print queue writes, marketplace API calls/.test(mockedWorkflow) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|orders|shipments)/i.test(mockedWorkflow));
check('label purchase boundary exports purchaseMultiPackageLabels',
  /export async function purchaseMultiPackageLabels/.test(labelPurchaseBoundary));
check('label purchase boundary has no default live purchase path',
  /No default provider calls, live postage, print queue writes, marketplace API calls/.test(labelPurchaseBoundary) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(labelPurchaseBoundary));
check('source guard rejects duplicate package keys',
  sourceGuard.includes('duplicate package keys are rejected before any label purchase planning'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package closeout guard');
